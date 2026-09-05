-- ── Өвлийн идэш: the second vertical ──────────────────────────────────
--
-- A supplier under contract lists an animal, whole or by the kilogram, at a
-- fixed price. A guest pays the whole price once, up front, and chooses to
-- collect it or have it delivered. The supplier slaughters, marks it ready,
-- and hands it over against the order's code.
--
-- Same shape as dine — one schema, no foreign keys across the line, the money
-- in the ledger and the person in identity — so the second vertical costs the
-- platform nothing, which is the whole argument for having a platform.

CREATE SCHEMA idesh;
COMMENT ON SCHEMA idesh IS
  'Өвлийн идэш. Suppliers, what they list, and the orders guests pay for. Everything that is about an animal.';

-- ── suppliers ──────────────────────────────────────────────────────────
--
-- The restaurant's counterpart. There is no self-signup: ops registers a
-- supplier by script once a contract is signed, and `contracted_at` is the
-- whole meaning of «баталгаатай» on the guest's screen.

CREATE TABLE idesh.supplier (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  -- Whom the guest calls once they have paid. Never shown before that.
  phone                text NOT NULL,
  contracted_at        timestamptz NOT NULL DEFAULT now(),
  -- The seller of record on the receipt. The supplier's, never the platform's.
  ebarimt_merchant_tin text,
  -- Where a guest who chose «өөрөө очиж» goes. One per supplier, in the city.
  pickup_address       text NOT NULL,
  lat                  numeric(9,6),
  lon                  numeric(9,6),
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Ulaanbaatar only, and generously bounded, like dine.restaurant.
  CONSTRAINT supplier_coords_sane CHECK (
    (lat IS NULL AND lon IS NULL) OR
    (lat BETWEEN 47.7 AND 48.1 AND lon BETWEEN 106.6 AND 107.3)
  )
);

-- ── listings ───────────────────────────────────────────────────────────
--
-- One offer: a kind of animal, whole or by weight, at a price that is final.
-- The price is final on purpose: a whole animal's true weight is known only
-- after slaughter, and settling the difference afterwards is a second payment,
-- a second notification and a «what if they never pay» — a whole product
-- nobody asked for this autumn. The supplier quotes with the approximate
-- weight beside the number and stands by it.

CREATE TABLE idesh.listing (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id      uuid NOT NULL REFERENCES idesh.supplier(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('sheep','goat','beef','horse')),
  unit             text NOT NULL CHECK (unit IN ('whole','kg')),
  title            text NOT NULL,
  note             text,
  -- Per head when whole, per kilogram otherwise.
  price_mnt        bigint NOT NULL CHECK (price_mnt > 0),
  -- Whole animals carry a weight the guest can judge the price by.
  approx_kg        numeric(6,1) CHECK (approx_kg IS NULL OR approx_kg > 0),
  -- Smallest order: one head, or however many kilograms the supplier will cut.
  min_qty          int NOT NULL DEFAULT 1 CHECK (min_qty > 0),
  -- Heads or kilograms on offer, and how many are spoken for. `sold` cannot
  -- pass `quantity`: two guests reaching for the last sheep at once is settled
  -- here, by the database, not by whichever request read the count first.
  quantity         int NOT NULL CHECK (quantity >= 0),
  sold             int NOT NULL DEFAULT 0 CHECK (sold >= 0),
  -- Where the meat is from: an aimag, a soum, a city abattoir. Not where the
  -- guest collects it — that is the supplier's pickup point.
  origin           text NOT NULL,
  -- The day the supplier can first hand it over.
  ready_from       date NOT NULL,
  delivers         boolean NOT NULL DEFAULT true,
  delivery_fee_mnt bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_mnt >= 0),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (sold <= quantity),
  CHECK (unit <> 'whole' OR approx_kg IS NOT NULL)
);
CREATE INDEX listing_open_idx ON idesh.listing (ready_from) WHERE active;
CREATE INDEX listing_supplier_idx ON idesh.listing (supplier_id);

-- ── the order ──────────────────────────────────────────────────────────
-- Named idesh_order for the same reason dine's is dining_order: the bare word
-- is reserved, and quoting it in every query is a permanent tax.

CREATE TABLE idesh.idesh_order (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Shown to the guest and read out at the handover. Its own series, so a
  -- supplier is never handed a lunch number.
  code               text UNIQUE NOT NULL,
  supplier_id        uuid NOT NULL REFERENCES idesh.supplier(id),
  listing_id         uuid NOT NULL REFERENCES idesh.listing(id),
  guest_id           uuid NOT NULL,
  state              text NOT NULL DEFAULT 'DRAFT',

  -- Copied, not joined: the listing may be edited tomorrow and this must not.
  kind               text NOT NULL,
  unit               text NOT NULL,
  title              text NOT NULL,
  origin             text NOT NULL,
  qty                int    NOT NULL CHECK (qty > 0),
  unit_price_mnt     bigint NOT NULL CHECK (unit_price_mnt > 0),
  delivery_fee_mnt   bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_mnt >= 0),
  total_mnt          bigint NOT NULL CHECK (total_mnt > 0),

  receive            text NOT NULL CHECK (receive IN ('delivery','pickup')),
  receive_on         date NOT NULL,
  address            text,
  address_phone      text,
  address_lat        numeric(9,6),
  address_lon        numeric(9,6),

  ledger_transfer_id uuid,

  paid_at            timestamptz,
  preparing_at       timestamptz,
  ready_at           timestamptz,
  dispatched_at      timestamptz,
  handed_at          timestamptz,
  cancelled_at       timestamptz,
  cancelled_by       text,
  closed_at          timestamptz,

  version            int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT idesh_order_state_check CHECK (state IN (
    'DRAFT','PAID','PREPARING','READY','DISPATCHED','HANDED','CLOSED','CANCELLED','REFUNDED'
  )),
  -- A delivery has somewhere to go and somebody to call at the gate.
  CHECK (receive <> 'delivery' OR (address IS NOT NULL AND address_phone IS NOT NULL)),
  -- Money in means we know the minute it came in.
  CHECK (state NOT IN ('PAID','PREPARING','READY','DISPATCHED','HANDED','REFUNDED')
         OR paid_at IS NOT NULL),
  -- Once the animal is committed we know when — the refund boundary, like
  -- fired_at in dine.
  CHECK (state NOT IN ('PREPARING','READY','DISPATCHED','HANDED') OR preparing_at IS NOT NULL)
);
CREATE INDEX idesh_order_guest_idx ON idesh.idesh_order (guest_id, created_at DESC);
CREATE INDEX idesh_order_supplier_live_idx ON idesh.idesh_order (supplier_id, state)
  WHERE state NOT IN ('DRAFT','CLOSED','CANCELLED','REFUNDED');
CREATE INDEX idesh_order_draft_idx ON idesh.idesh_order (created_at) WHERE state = 'DRAFT';

COMMENT ON COLUMN idesh.idesh_order.guest_id IS
  'identity.guest.id. No FK on purpose — identity is a module, not a table.';
COMMENT ON COLUMN idesh.idesh_order.ledger_transfer_id IS
  'ledger.transfer.id for the purchase. Opaque here — idesh only passes it back.';

-- Append-only. The only admissible evidence when a supplier and a guest
-- disagree about who said what and when.
CREATE TABLE idesh.order_event (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES idesh.idesh_order(id) ON DELETE CASCADE,
  seq        int  NOT NULL,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor      text NOT NULL,     -- guest:<id> | supplier:<device> | system:scheduler | ops:<who>
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seq)
);

-- ── the supplier's screen ──────────────────────────────────────────────
-- The kitchen tablet's counterpart, and the same mechanism: an eight-digit
-- code typed once, a long-lived token after, revocable from ops. Its own table
-- rather than dine.kds_device, because that one names a restaurant.

CREATE TABLE idesh.supplier_device (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id        uuid NOT NULL REFERENCES idesh.supplier(id) ON DELETE CASCADE,
  label              text NOT NULL,
  token_hash         text UNIQUE,
  pairing_code       text,
  pairing_expires_at timestamptz,
  paired_at          timestamptz,
  revoked_at         timestamptz,
  last_seen_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_device_supplier_idx ON idesh.supplier_device (supplier_id)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX supplier_device_pairing_idx ON idesh.supplier_device (pairing_code)
  WHERE pairing_code IS NOT NULL AND paired_at IS NULL;
