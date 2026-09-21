-- ── Two people, not one ───────────────────────────────────────────────
--
-- A payout leaves the house by a bank transfer somebody makes by hand and
-- then records here. One person doing both halves is the whole risk: the
-- money and the record of it move together, under one pair of eyes. From
-- now a settlement is released by one member and marked transferred by
-- another, and the row remembers both.
--
-- NOT VALID: the rule binds every row written from here on. The handful
-- paid under the old rule keep their history rather than being back-dated
-- into a story that did not happen.
ALTER TABLE idesh.settlement
  ADD COLUMN approved_by text,
  ADD COLUMN approved_at timestamptz;

ALTER TABLE idesh.settlement
  ADD CONSTRAINT settlement_paid_was_approved
    CHECK (state <> 'paid' OR approved_at IS NOT NULL) NOT VALID;
