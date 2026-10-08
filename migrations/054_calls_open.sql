-- ── Calls open ────────────────────────────────────────────────────────
--
-- The owner asked for in-app calls to be on (2026-10-08) and could not turn
-- the desk's switch themselves. Opened here, once, the way any admin's save
-- would: the row says who, and the desk's «Систем» page can close it again.

INSERT INTO ops.setting (key, value, updated_by, updated_at)
VALUES ('calls_open', '1'::jsonb, 'deploy:054', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
