-- A top-up raised for one purchase: the shortfall of an order the guest pays
-- for by QPay, on the provider's own page, while the order waits as a draft.
--
-- `for_subject` / `for_subject_id` name the purchase (`idesh` and the order).
-- One open invoice per purchase: a press that comes back — the page polling,
-- the person returning from their bank app, a retry after a lost answer — is
-- shown the same QR, never a second one for the same money. A paid one is
-- what the scheduler and the provider's callback finish the purchase with,
-- whether or not the person ever comes back to the page.
ALTER TABLE ledger.topup
  ADD COLUMN for_subject    text,
  ADD COLUMN for_subject_id uuid;

CREATE UNIQUE INDEX topup_open_per_purchase_idx
  ON ledger.topup (for_subject, for_subject_id)
  WHERE for_subject IS NOT NULL AND state = 'pending';
