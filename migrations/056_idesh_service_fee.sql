-- ── A small fee, said out loud, from the guest ────────────────────────
--
-- Basu lived on its commission alone: 2% of the meat, out of which the
-- payment provider is paid too. The owner chose (2026-10-14) a small fee
-- the guest pays on every идэш order, shown as its own line before paying
-- — not hidden in the price, not taken from the supplier.
--
-- Each order keeps the fee it was sold with. It is Basu's: it is not in the
-- supplier's total, their commission or their payout, and it goes back to
-- the guest whenever the order is cancelled. `total_mnt` stays what it was
-- — the supplier's sale — and the guest pays total_mnt + service_fee_mnt.
ALTER TABLE idesh.idesh_order
  ADD COLUMN service_fee_mnt bigint NOT NULL DEFAULT 0 CHECK (service_fee_mnt >= 0);

-- The amount is the desk's: «Систем» → «Идэшийн үйлчилгээний хураамж».
-- 2,000₮ to start, as proposed to the owner; 0 turns it off.
INSERT INTO ops.setting (key, value, updated_by, updated_at)
VALUES ('idesh_service_fee_mnt', '2000'::jsonb, 'deploy:056', now())
ON CONFLICT (key) DO NOTHING;
