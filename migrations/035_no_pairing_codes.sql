-- ── No more pairing codes: a screen is a person signed in ────────────────
--
-- A tablet on a supplier's counter or in a restaurant's kitchen used to be
-- let in by an eight-digit code from Basu, and then acted as a manager that
-- no role described. It is now a person, signed in with their own account,
-- doing what their role at the business allows — the same person on a
-- phone, a tablet or a computer.
--
-- A restaurant is a business like a supplier: it belongs to an organisation,
-- and the people with a role there run its kitchen. Whether a kitchen is
-- watching — no orders are taken for food nobody would cook — is now when
-- somebody last had its orders open, rather than a tablet's heartbeat.

DROP TABLE idesh.supplier_device;
DROP TABLE dine.kds_device;

ALTER TABLE dine.restaurant
  ADD COLUMN org_id          uuid,
  -- The last time somebody at this restaurant had the kitchen's orders open.
  ADD COLUMN kitchen_seen_at timestamptz;
CREATE UNIQUE INDEX restaurant_org_idx ON dine.restaurant (org_id) WHERE org_id IS NOT NULL;
