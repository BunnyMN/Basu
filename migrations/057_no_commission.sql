-- ── No commission ────────────────────────────────────────────────────
--
-- Basu took 2% of the meat from every supplier (016). Since 056 the guest
-- pays a small service fee instead, and on 2026-11-03 the owner ended the
-- 2%: a supplier is paid the whole of what the guest paid them.
--
-- The per-contract rate stays, at 0, for a contract that ever needs one.
ALTER TABLE idesh.supplier ALTER COLUMN commission_pct SET DEFAULT 0;
UPDATE idesh.supplier SET commission_pct = 0 WHERE commission_pct <> 0;

-- An order handed over but not yet closed had its share fixed at the old
-- rate; it is paid at none. Closed orders keep what they were paid.
UPDATE idesh.idesh_order
   SET commission_mnt = 0,
       payout_mnt     = total_mnt
 WHERE state = 'HANDED' AND commission_mnt > 0;
