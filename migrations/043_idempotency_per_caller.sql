-- ── A remembered answer belongs to whoever was given it ────────────────
--
-- Idempotency keys were kept by the key alone, and looked up before any
-- route had asked who was calling: a request that sent a key somebody else
-- had used got that person's answer back — an admin's new desk seat, handed
-- to a request with no session at all. A key is the client's own label for
-- a retry, not a secret, and was never meant to say who anybody is.
--
-- An answer is now kept under the session that asked (a hash of it, never
-- the token), the method and the address, and the key within those. What
-- was kept the old way is dropped rather than guessed at: nobody can say
-- whose it was, and a day of retries is all it was ever for.
--
-- The release before this one cannot write into this shape: rolled back to,
-- it stops remembering answers — its insert fails, and it lets it.

TRUNCATE idempotency_key;

ALTER TABLE idempotency_key DROP CONSTRAINT idempotency_key_pkey;
ALTER TABLE idempotency_key
  ADD COLUMN caller text NOT NULL,
  ADD COLUMN method text NOT NULL,
  ADD COLUMN url    text NOT NULL;
ALTER TABLE idempotency_key ADD PRIMARY KEY (caller, method, url, key);
