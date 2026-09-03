-- ── The platform / vertical line ───────────────────────────────────────
--
-- Until now everything lived in one schema, which was right while there was
-- one product. Wallet, profile and notifications are not about lunch: a second
-- vertical will need all three on day one, and it must not have to reach into
-- the dining tables to get them.
--
-- So: four schemas, each owned by one module. Nothing here moves a row — the
-- data is where it was, only the namespace changed. What does change is that a
-- module can no longer JOIN its way into another module's tables; it has to
-- ask, through a function call today and over the wire the day one of these
-- becomes its own service. `src/test/boundaries.test.ts` holds that line.
--
-- `guest` keeps its name rather than becoming `user`. The word is reserved in
-- Postgres and quoting it in every query is a permanent tax for no benefit —
-- the same reason the order table is `dining_order`.

CREATE SCHEMA identity;
CREATE SCHEMA ledger;
CREATE SCHEMA notify;
CREATE SCHEMA dine;

COMMENT ON SCHEMA identity IS 'Who someone is. Phone, session, profile. No vertical may write here.';
COMMENT ON SCHEMA ledger   IS 'Money. Double-entry, append-only. Balances are derived, never stored.';
COMMENT ON SCHEMA notify   IS 'Messages out and the devices they go to.';
COMMENT ON SCHEMA dine     IS 'The dine-in vertical. Everything that is about food.';

-- ── move what exists ───────────────────────────────────────────────────

ALTER TABLE guest          SET SCHEMA identity;
ALTER TABLE otp_challenge  SET SCHEMA identity;
ALTER TABLE guest_session  SET SCHEMA identity;

ALTER TABLE payment          SET SCHEMA ledger;
ALTER TABLE ebarimt_receipt  SET SCHEMA ledger;

ALTER TABLE notification SET SCHEMA notify;
ALTER TABLE notify.notification RENAME TO message;

ALTER TABLE restaurant          SET SCHEMA dine;
ALTER TABLE station             SET SCHEMA dine;
ALTER TABLE station_reservation SET SCHEMA dine;
ALTER TABLE menu_item           SET SCHEMA dine;
ALTER TABLE slot                SET SCHEMA dine;
ALTER TABLE dining_table        SET SCHEMA dine;
ALTER TABLE trust_profile       SET SCHEMA dine;
ALTER TABLE dining_order        SET SCHEMA dine;
ALTER TABLE order_line          SET SCHEMA dine;
ALTER TABLE table_hold          SET SCHEMA dine;
ALTER TABLE arrival_signal      SET SCHEMA dine;
ALTER TABLE fire_job            SET SCHEMA dine;
ALTER TABLE order_event         SET SCHEMA dine;
ALTER TABLE order_review        SET SCHEMA dine;
ALTER TABLE dish_review         SET SCHEMA dine;
ALTER TABLE kds_device          SET SCHEMA dine;

-- `idempotency_key`, `outbox` and `schema_migration` stay in public: they are
-- infrastructure every module uses, not any one module's data.

-- ── cut the foreign keys that cross the line ───────────────────────────
--
-- The column stays and still holds the same uuid; what goes is the database's
-- insistence that both sides live in one cluster. A cross-schema FK is a hard
-- weld: it makes the "split this module into a service" migration impossible
-- without first doing exactly this, under time pressure, in production.

ALTER TABLE dine.trust_profile DROP CONSTRAINT trust_profile_guest_id_fkey;
ALTER TABLE dine.dining_order  DROP CONSTRAINT dining_order_guest_id_fkey;
ALTER TABLE dine.order_review  DROP CONSTRAINT order_review_guest_id_fkey;
ALTER TABLE ledger.payment     DROP CONSTRAINT payment_order_id_fkey;
ALTER TABLE notify.message     DROP CONSTRAINT notification_order_id_fkey;

COMMENT ON COLUMN dine.dining_order.guest_id IS
  'identity.guest.id. No FK on purpose — identity is a module, not a table.';
COMMENT ON COLUMN ledger.payment.order_id IS
  'dine.dining_order.id, for rows written before wallets. No FK: money outlives
   any one vertical''s rows.';

-- A payment is now the provider's side of a top-up as often as it is an order,
-- so it can no longer insist on naming a meal.
ALTER TABLE ledger.payment ALTER COLUMN order_id DROP NOT NULL;

-- ── identity: the profile a person carries between verticals ───────────

CREATE TABLE identity.profile (
  guest_id     uuid PRIMARY KEY REFERENCES identity.guest(id) ON DELETE CASCADE,
  display_name text,
  locale       text NOT NULL DEFAULT 'mn' CHECK (locale IN ('mn','en')),
  -- No uploads yet. The avatar is drawn from this seed, so a profile picture
  -- costs no storage, no moderation and no CDN until somebody asks for one.
  avatar_seed  text NOT NULL DEFAULT substr(md5(random()::text), 1, 8),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO identity.profile (guest_id, display_name)
SELECT id, name FROM identity.guest;

-- ── ledger: double entry, and nothing that can drift ───────────────────
--
-- There is no balance column anywhere below, and that is the whole design. A
-- balance is SUM(amount_mnt) over the account's entries; it cannot be wrong,
-- cannot be half-updated by a crashed request, and reconciles against the
-- payment provider by construction.

CREATE TABLE ledger.account (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('guest','house','provider')),
  -- identity.guest.id for a guest wallet; null for the house's own accounts.
  owner_id   uuid,
  -- Singleton accounts (the float, the QPay clearing account) are named.
  label      text UNIQUE,
  currency   char(3) NOT NULL DEFAULT 'MNT',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'guest') = (owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX account_owner_idx
  ON ledger.account (kind, owner_id, currency) WHERE owner_id IS NOT NULL;

-- The house side of every guest movement. Named, so the seed and the tests
-- refer to the same rows rather than each inventing their own.
INSERT INTO ledger.account (kind, label) VALUES
  ('provider', 'qpay:clearing'),
  ('house',    'house:revenue'),
  ('house',    'house:promotions');

CREATE TABLE ledger.transfer (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('topup','purchase','refund','promotion','adjustment')),
  amount_mnt bigint NOT NULL CHECK (amount_mnt > 0),
  -- What this was for, in the language of whichever module asked. The ledger
  -- stores it and never interprets it — that is what keeps it a ledger.
  subject    text,
  subject_id uuid,
  memo       text,
  -- A retried callback, a double-tapped button and a re-delivered webhook all
  -- carry the same key and collapse onto one transfer.
  idempotency_key text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transfer_subject_idx ON ledger.transfer (subject, subject_id);

CREATE TABLE ledger.entry (
  id          bigserial PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES ledger.transfer(id) ON DELETE RESTRICT,
  account_id  uuid NOT NULL REFERENCES ledger.account(id) ON DELETE RESTRICT,
  -- Signed. Every transfer's entries sum to zero; the trigger below refuses
  -- anything else, so "the ledger is balanced" is a property of the schema
  -- rather than of whoever wrote the last service.
  amount_mnt  bigint NOT NULL CHECK (amount_mnt <> 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entry_account_idx  ON ledger.entry (account_id, id DESC);
CREATE INDEX entry_transfer_idx ON ledger.entry (transfer_id);

CREATE FUNCTION ledger.assert_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
BEGIN
  SELECT COALESCE(SUM(amount_mnt), 0) INTO total
    FROM ledger.entry WHERE transfer_id = NEW.transfer_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'unbalanced transfer %: entries sum to %', NEW.transfer_id, total;
  END IF;
  RETURN NULL;
END;
$$;

-- Deferred: the two halves of a transfer are inserted as two statements, so
-- the check has to wait for COMMIT to have both of them in view.
CREATE CONSTRAINT TRIGGER entry_balanced
  AFTER INSERT ON ledger.entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_balanced();

CREATE TABLE ledger.topup (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id     uuid NOT NULL,
  amount_mnt   bigint NOT NULL CHECK (amount_mnt > 0),
  provider     text NOT NULL CHECK (provider IN ('qpay','card')),
  provider_ref text,
  action_url   text,
  state        text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','settled','failed','expired')),
  -- Set once, when the money actually arrives.
  transfer_id  uuid REFERENCES ledger.transfer(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX topup_guest_idx ON ledger.topup (guest_id, created_at DESC);

-- ── notify: messages belong to a person, not to an order ───────────────

ALTER TABLE notify.message
  ADD COLUMN guest_id   uuid,
  ADD COLUMN title      text,
  ADD COLUMN subject    text,
  ADD COLUMN subject_id uuid,
  ADD COLUMN read_at    timestamptz;

UPDATE notify.message m
   SET guest_id   = o.guest_id,
       subject    = 'order',
       subject_id = m.order_id
  FROM dine.dining_order o
 WHERE o.id = m.order_id AND m.guest_id IS NULL;

DELETE FROM notify.message WHERE guest_id IS NULL;
ALTER TABLE notify.message ALTER COLUMN guest_id SET NOT NULL;
ALTER TABLE notify.message ALTER COLUMN order_id DROP NOT NULL;

COMMENT ON COLUMN notify.message.order_id IS
  'Deprecated — read subject/subject_id instead. Dropped in a later release.';

CREATE INDEX message_guest_idx ON notify.message (guest_id, created_at DESC);
CREATE INDEX message_unread_idx ON notify.message (guest_id) WHERE read_at IS NULL;

CREATE TABLE notify.device (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id     uuid NOT NULL,
  platform     text NOT NULL CHECK (platform IN ('ios','android','web')),
  push_token   text UNIQUE NOT NULL,
  label        text,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_guest_idx ON notify.device (guest_id) WHERE revoked_at IS NULL;

CREATE TABLE notify.preference (
  guest_id   uuid PRIMARY KEY,
  -- Transactional messages are not optional: "your table is being fired" is
  -- the product, not marketing. What is switchable is the channel and whether
  -- we are allowed to say anything that is not about an order in flight.
  push       boolean NOT NULL DEFAULT true,
  sms        boolean NOT NULL DEFAULT true,
  marketing  boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── receipts stop reaching into the dining tables ──────────────────────
--
-- Issuing a receipt needs four facts: who sold, what it was called, how much,
-- and sale or return. Three of them used to be fetched by joining through
-- payment → dining_order → restaurant, which is ledger reading dine's data. A
-- receipt is a record of a moment, so the facts are copied in at that moment
-- and stay true even if the restaurant later changes its name or its TIN.

ALTER TABLE ledger.ebarimt_receipt
  ADD COLUMN transfer_id  uuid REFERENCES ledger.transfer(id),
  ADD COLUMN merchant_tin text,
  ADD COLUMN order_code   text,
  ADD COLUMN amount_mnt   bigint;

UPDATE ledger.ebarimt_receipt e
   SET merchant_tin = r.ebarimt_merchant_tin,
       order_code   = o.code,
       amount_mnt   = p.amount_mnt
  FROM ledger.payment p
  JOIN dine.dining_order o ON o.id = p.order_id
  JOIN dine.restaurant r   ON r.id = o.restaurant_id
 WHERE p.id = e.payment_id;

ALTER TABLE ledger.ebarimt_receipt ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE ledger.ebarimt_receipt DROP CONSTRAINT ebarimt_receipt_payment_id_fkey;

-- ── dine remembers which movement paid for the meal ────────────────────
--
-- The ledger's id, held by the vertical that caused it. Dine hands it back
-- when it wants a receipt; it never reads the ledger's tables to find it.

ALTER TABLE dine.dining_order ADD COLUMN ledger_transfer_id uuid;
COMMENT ON COLUMN dine.dining_order.ledger_transfer_id IS
  'ledger.transfer.id for the purchase. Opaque here — dine only passes it back.';
