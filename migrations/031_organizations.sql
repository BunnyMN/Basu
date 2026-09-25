-- ── Businesses, and the people who run them ─────────────────────────
--
-- Until now a supplier was one person: the owner whose phone it was. A real
-- business is several people — the owner, a manager who runs the day, the
-- staff who cut and pack, the accountant who reconciles the money — and a
-- restaurant is the same. So a business on Basu is an organisation, with
-- members and a role each:
--
--   owner       everything, and appoints managers
--   manager     the day's work, the listings and the menu, adds staff
--   staff       orders and listings
--   accountant  money and reports, and nothing else
--
-- A person registers the organisation themselves and becomes its owner;
-- Basu's desk approves it. An organisation may be a restaurant, a supplier,
-- or both.

CREATE SCHEMA org;
COMMENT ON SCHEMA org IS 'Businesses on Basu — a restaurant, a supplier, or both — and the people who run them.';

CREATE TABLE org.organization (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  restaurant     boolean NOT NULL DEFAULT false,
  supplier       boolean NOT NULL DEFAULT false,
  -- The number guests ring, where it is, and who it is to the tax office.
  phone          text,
  address        text,
  lat            numeric(9, 6),
  lon            numeric(9, 6),
  tin            text,
  about          text,
  state          text NOT NULL DEFAULT 'applied' CHECK (state IN ('applied', 'active', 'declined', 'suspended')),
  -- The account that registered it. No foreign key to identity, as everywhere.
  applied_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  decided_by     text,
  decline_reason text,
  CHECK (restaurant OR supplier)
);
CREATE INDEX organization_state_idx ON org.organization (state, created_at);

CREATE TABLE org.membership (
  org_id    uuid NOT NULL REFERENCES org.organization (id) ON DELETE CASCADE,
  guest_id  uuid NOT NULL,
  role      text NOT NULL CHECK (role IN ('owner', 'manager', 'staff', 'accountant')),
  added_by  uuid,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, guest_id)
);
CREATE INDEX membership_guest_idx ON org.membership (guest_id);

-- A supplier belongs to an organisation. No foreign key across the line.
ALTER TABLE idesh.supplier ADD COLUMN org_id uuid;
CREATE INDEX supplier_org_idx ON idesh.supplier (org_id) WHERE org_id IS NOT NULL;

-- Every supplier with an owner becomes an organisation of one: its owner is
-- the organisation's owner. The one place this migration looks across.
ALTER TABLE org.organization ADD COLUMN carried_supplier uuid;
INSERT INTO org.organization
  (name, supplier, phone, address, lat, lon, tin, about, state, applied_by, created_at, decided_at, carried_supplier)
SELECT s.name, true, s.phone, s.pickup_address, s.lat, s.lon, s.ebarimt_merchant_tin, s.about,
       CASE s.state WHEN 'contracted' THEN 'active' WHEN 'applied' THEN 'applied' ELSE 'declined' END,
       s.owner_guest_id, COALESCE(s.applied_at, s.contracted_at, now()), s.contracted_at, s.id
  FROM idesh.supplier s
 WHERE s.owner_guest_id IS NOT NULL;
UPDATE idesh.supplier s SET org_id = o.id FROM org.organization o WHERE o.carried_supplier = s.id;
INSERT INTO org.membership (org_id, guest_id, role)
SELECT id, applied_by, 'owner' FROM org.organization WHERE carried_supplier IS NOT NULL
ON CONFLICT DO NOTHING;
ALTER TABLE org.organization DROP COLUMN carried_supplier;

-- The desk's record names organisations too: approved, declined.
ALTER TABLE idesh.audit DROP CONSTRAINT audit_target_kind_check;
ALTER TABLE idesh.audit ADD CONSTRAINT audit_target_kind_check
  CHECK (target_kind IN ('supplier','listing','order','settlement','guest','member','restaurant','device','menu_item','receipt','ledger','message','setting','org'));
