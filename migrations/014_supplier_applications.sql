-- ── Becoming a supplier ────────────────────────────────────────────────
--
-- Until now a supplier existed only once ops had run a script on the server.
-- That kept «гэрээт» honest and made the pilot's first supplier depend on
-- somebody with SSH. Now a person asks from the supplier page, with a phone
-- they have proved by OTP, and ops answers from a page of their own. The
-- contract is still what makes a supplier: an application is a supplier row
-- that is not yet one, and nothing it lists is shown to a guest until it is.

ALTER TABLE idesh.supplier ALTER COLUMN contracted_at DROP NOT NULL;

ALTER TABLE idesh.supplier
  ADD COLUMN state              text NOT NULL DEFAULT 'contracted'
                                CHECK (state IN ('applied', 'contracted', 'declined')),
  -- identity.guest.id of whoever applied. No FK: identity is a module.
  ADD COLUMN applicant_guest_id uuid,
  -- What they said they sell, in their own words. Read by ops, never shown.
  ADD COLUMN about              text,
  ADD COLUMN applied_at         timestamptz,
  ADD COLUMN decided_at         timestamptz,
  ADD COLUMN decline_reason     text;

-- A contract has a date; nothing else does.
ALTER TABLE idesh.supplier
  ADD CONSTRAINT supplier_contract_dated CHECK (state <> 'contracted' OR contracted_at IS NOT NULL);

-- One open application, or one contract, per person. A declined one may
-- apply again — the row that was declined stays, as the record of why.
CREATE UNIQUE INDEX supplier_applicant_open_idx
  ON idesh.supplier (applicant_guest_id)
  WHERE applicant_guest_id IS NOT NULL AND state IN ('applied', 'contracted');

CREATE INDEX supplier_applied_idx ON idesh.supplier (applied_at) WHERE state = 'applied';

COMMENT ON COLUMN idesh.supplier.state IS
  'applied: asked, not yet a supplier. contracted: one of ours. declined: told no, with the reason kept.';
