-- Basu — dine-in pre-order, initial schema.
--
-- Three invariants are enforced here rather than in application code, because
-- code can be wrong and a constraint cannot:
--   1. one table is never double-held        (table_hold EXCLUDE)
--   2. one order never has two pending fires (fire_job partial unique)
--   3. one provider callback counts once     (payment unique)
--
-- Money is bigint MNT: the tögrög has no subunit in practice, and integers
-- keep totals exact. Times are timestamptz; the restaurant's own zone lives on
-- the restaurant row because slots are generated in local wall-clock terms.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── restaurant & menu ──────────────────────────────────────────────────

CREATE TABLE restaurant (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL,
  tz                    text        NOT NULL DEFAULT 'Asia/Ulaanbaatar',
  slot_minutes          int         NOT NULL DEFAULT 15,
  accept_timeout_s      int         NOT NULL DEFAULT 90,
  auto_accept           boolean     NOT NULL DEFAULT true,
  plating_buffer_min    int         NOT NULL DEFAULT 1,
  -- Minutes on foot from the tower lobby. Feeds the on_my_way signal.
  travel_minutes        int         NOT NULL DEFAULT 7,
  ebarimt_merchant_tin  text,
  active                boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE station (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurant(id) ON DELETE CASCADE,
  code           text NOT NULL,
  display_name   text NOT NULL,
  -- How many tickets this station cooks at once. The scheduler's hard ceiling.
  parallel_lanes int  NOT NULL CHECK (parallel_lanes >= 0),
  UNIQUE (restaurant_id, code)
);

CREATE TABLE menu_item (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id          uuid NOT NULL REFERENCES restaurant(id) ON DELETE CASCADE,
  station_id             uuid NOT NULL REFERENCES station(id),
  name                   text NOT NULL,
  price_mnt              bigint NOT NULL CHECK (price_mnt >= 0),
  -- Measured with a stopwatch at peak, not quoted by the chef (§06).
  prep_minutes           numeric(4,1) NOT NULL CHECK (prep_minutes > 0),
  hold_tolerance_minutes numeric(4,1) NOT NULL CHECK (hold_tolerance_minutes >= 0),
  preorder_enabled       boolean NOT NULL DEFAULT false,
  sold_out_until         timestamptz,
  active                 boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX menu_item_restaurant_idx ON menu_item (restaurant_id) WHERE active;

-- ── capacity ───────────────────────────────────────────────────────────

CREATE TABLE slot (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurant(id) ON DELETE CASCADE,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  max_orders    int NOT NULL CHECK (max_orders >= 0),
  max_covers    int NOT NULL CHECK (max_covers >= 0),
  taken_orders  int NOT NULL DEFAULT 0 CHECK (taken_orders >= 0),
  taken_covers  int NOT NULL DEFAULT 0 CHECK (taken_covers >= 0),
  closed        boolean NOT NULL DEFAULT false,
  UNIQUE (restaurant_id, starts_at),
  CHECK (ends_at > starts_at),
  CHECK (taken_orders <= max_orders)
);
CREATE INDEX slot_lookup_idx ON slot (restaurant_id, starts_at) WHERE NOT closed;

CREATE TABLE dining_table (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurant(id) ON DELETE CASCADE,
  code          text NOT NULL,
  seats         int  NOT NULL CHECK (seats > 0),
  zone          text,
  UNIQUE (restaurant_id, code)
);

-- ── guest ──────────────────────────────────────────────────────────────

CREATE TABLE guest (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text UNIQUE NOT NULL,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trust_profile (
  guest_id             uuid PRIMARY KEY REFERENCES guest(id) ON DELETE CASCADE,
  completed_visits     int NOT NULL DEFAULT 0,
  no_shows             int NOT NULL DEFAULT 0,
  consecutive_no_shows int NOT NULL DEFAULT 0,
  last_no_show_at      timestamptz,
  tier                 text NOT NULL DEFAULT 'NEW'
                         CHECK (tier IN ('NEW','AUTO','CONFIRM','BLOCKED')),
  tier_until           timestamptz
);

-- ── order ──────────────────────────────────────────────────────────────
-- Named dining_order, not "order": the bare word is reserved and quoting it
-- in every query is a permanent tax for no benefit.

CREATE TABLE dining_order (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text UNIQUE NOT NULL,         -- №1042, shown to the guest
  restaurant_id       uuid NOT NULL REFERENCES restaurant(id),
  guest_id            uuid NOT NULL REFERENCES guest(id),
  slot_id             uuid REFERENCES slot(id),
  state               text NOT NULL DEFAULT 'DRAFT',
  party_size          int  NOT NULL CHECK (party_size > 0),

  slot_starts_at      timestamptz NOT NULL,          -- what the guest booked
  eta_at              timestamptz,                   -- fused prediction (§04)
  eta_confidence      numeric(3,2) CHECK (eta_confidence BETWEEN 0 AND 1),
  eta_basis           text,
  fire_at             timestamptz,                   -- the computed decision
  ready_at            timestamptz,
  order_prep_minutes  numeric(4,1),
  fire_mode           text CHECK (fire_mode IN ('AUTO','CONFIRM','MANUAL')),

  armed_at            timestamptz,
  fired_at            timestamptz,
  fired_by            text,                          -- scheduler | kds | ops
  cooked_ready_at     timestamptz,
  seated_at           timestamptz,
  served_at           timestamptz,
  closed_at           timestamptz,

  total_mnt           bigint NOT NULL DEFAULT 0 CHECK (total_mnt >= 0),
  version             int    NOT NULL DEFAULT 0,     -- optimistic lock
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dining_order_state_check CHECK (state IN (
    'DRAFT','PLACED','ACCEPTED','SCHEDULED','ARMED','HELD','FIRED','COOKING',
    'READY','SERVED','CLOSED','REJECTED','RESLOTTED','NO_SHOW','CANCELLED','REFUNDED'
  )),
  -- If the kitchen committed ingredients, we know the minute it happened.
  -- NO_SHOW deliberately is not on this list: a guest can fail to turn up for a
  -- ticket that was still HELD and never fired.
  CONSTRAINT fired_at_when_committed CHECK (
    state NOT IN ('FIRED','COOKING','READY','SERVED') OR fired_at IS NOT NULL
  )
);
CREATE INDEX dining_order_live_idx ON dining_order (restaurant_id, state)
  WHERE state NOT IN ('CLOSED','CANCELLED','REFUNDED','REJECTED');
CREATE INDEX dining_order_guest_idx ON dining_order (guest_id, created_at DESC);

CREATE TABLE order_line (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id               uuid NOT NULL REFERENCES dining_order(id) ON DELETE CASCADE,
  menu_item_id           uuid NOT NULL REFERENCES menu_item(id),
  qty                    int  NOT NULL CHECK (qty > 0),
  -- Copied, not joined: the menu may change and history must not.
  name                   text NOT NULL,
  unit_price_mnt         bigint NOT NULL,
  prep_minutes           numeric(4,1) NOT NULL,
  hold_tolerance_minutes numeric(4,1) NOT NULL,
  station_code           text NOT NULL,
  fire_offset_minutes    numeric(4,1) NOT NULL DEFAULT 0,
  notes                  text,
  cancelled_at           timestamptz            -- an 86 after the ticket fired
);
CREATE INDEX order_line_order_idx ON order_line (order_id);

CREATE TABLE table_hold (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES dining_order(id) ON DELETE CASCADE,
  table_id       uuid NOT NULL REFERENCES dining_table(id),
  hold_from      timestamptz NOT NULL,
  hold_until     timestamptz NOT NULL,
  released_at    timestamptz,
  release_reason text,
  CHECK (hold_until > hold_from),
  -- Two guests can never be promised the same table at the same time.
  EXCLUDE USING gist (
    table_id WITH =,
    tstzrange(hold_from, hold_until) WITH &&
  ) WHERE (released_at IS NULL)
);
CREATE INDEX table_hold_order_idx ON table_hold (order_id) WHERE released_at IS NULL;

-- ── arrival signals ────────────────────────────────────────────────────
-- Location is kept as a coarse band, never raw coordinates, and swept after a
-- week (§11 of the technical spec, and the personal-data law).

CREATE TABLE arrival_signal (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES dining_order(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN
               ('slot','on_my_way','delay_10','geofence_800','geofence_300','app_open','checkin')),
  at         timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX arrival_signal_order_idx ON arrival_signal (order_id, at);

-- ── firing ─────────────────────────────────────────────────────────────

CREATE TABLE fire_job (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES dining_order(id) ON DELETE CASCADE,
  run_at       timestamptz NOT NULL,
  state        text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','done','cancelled','failed')),
  attempt      int NOT NULL DEFAULT 0,
  locked_by    text,
  locked_until timestamptz,
  plan         jsonb,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- One order, one pending job. This is what makes double-firing impossible
-- even if two schedulers race.
CREATE UNIQUE INDEX fire_job_one_pending_idx ON fire_job (order_id) WHERE state = 'pending';
CREATE INDEX fire_job_due_idx ON fire_job (run_at) WHERE state = 'pending';

-- Append-only. The only admissible evidence in a dispute.
CREATE TABLE order_event (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES dining_order(id) ON DELETE CASCADE,
  seq        int  NOT NULL,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor      text NOT NULL,     -- guest:<id> | kds:<device> | system:scheduler | ops:<user>
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seq)
);
CREATE INDEX order_event_stream_idx ON order_event (id);

-- ── money & tax ────────────────────────────────────────────────────────

CREATE TABLE payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES dining_order(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('qpay','card')),
  provider_ref  text NOT NULL,
  amount_mnt    bigint NOT NULL CHECK (amount_mnt > 0),
  state         text NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','authorized','captured','refunded','failed')),
  authorized_at timestamptz,
  captured_at   timestamptz,
  refunded_mnt  bigint NOT NULL DEFAULT 0 CHECK (refunded_mnt >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- A retried webhook must never be counted twice.
  UNIQUE (provider, provider_ref)
);

CREATE TABLE ebarimt_receipt (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  uuid NOT NULL REFERENCES payment(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('SALE','RETURN')),
  bill_id     text,
  lottery     text,
  ddtd        text,
  qr_payload  text,
  state       text NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','issued','failed')),
  attempts    int NOT NULL DEFAULT 0,
  issued_at   timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ebarimt_pending_idx ON ebarimt_receipt (created_at) WHERE state = 'queued';

-- ── notifications ──────────────────────────────────────────────────────

CREATE TABLE notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES dining_order(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('push','sms')),
  template    text NOT NULL,
  -- Retries collapse onto the same key, so a guest never gets two of these.
  dedupe_key  text UNIQUE NOT NULL,
  state       text NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','sent','acked','failed')),
  sent_at     timestamptz,
  acked_at    timestamptz,
  provider_ref text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Everything the system wants to tell the outside world is written in the same
-- transaction as the state change, then relayed. No lost fires, no ghost pushes.
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
