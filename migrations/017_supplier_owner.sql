-- ── The person behind a supplier ──────────────────────────────────────
--
-- A supplier was a row and a screen; the guest who applied was remembered
-- only to answer their application. Now every supplier has an owner — the
-- guest whose phone it is — whether they applied from the page or ops wrote
-- them in from a contract. The owner is who gets the SMS when an order is
-- paid, and who sees the supplier's own screens after signing in with that
-- phone. Suppliers written in before this get their owner made on first
-- need, from the phone on the row.

ALTER TABLE idesh.supplier RENAME COLUMN applicant_guest_id TO owner_guest_id;

COMMENT ON COLUMN idesh.supplier.owner_guest_id IS
  'identity.guest.id of the person whose phone this supplier answers to. No FK: identity is a module.';
