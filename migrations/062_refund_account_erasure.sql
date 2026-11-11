-- A guest's refund account is kept only while it is needed.
--
-- The account a guest names for a refund is there so finance can send the
-- money, and for a while after so a «it never came» can be checked against
-- the bank. Once that is over the number and the name on it go. The bank
-- and the last four digits stay, so the row still says where the money went
-- and the guest can still recognise it. The scheduler does the erasing
-- (idesh/settlements.ts, eraseRefundAccounts): thirty days after the refund
-- was paid, or at once when the guest has closed their account.
ALTER TABLE idesh.settlement
  ADD COLUMN bank_tail      text,
  ADD COLUMN bank_erased_at timestamptz;
