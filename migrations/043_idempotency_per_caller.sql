-- ── A remembered answer belongs to whoever was given it ────────────────
--
-- Idempotency keys were kept by the key alone, and looked up before any
-- route had asked who was calling: a request that sent a key somebody else
-- had used got that person's answer back — an admin's new desk seat, handed
-- to a request with no session at all. A key is the client's own label for
-- a retry, not a secret, and was never meant to say who anybody is.
--
-- An answer is now kept under the session that asked (a hash of it, never
-- the token), the method and the address, and the key within those — in a
-- table of its own. The old table stays as it is for the release before
-- this one, which still writes to it: rolled back to, that release keeps
-- remembering answers the way it always did. A later release drops it.
--
-- What the old table holds is emptied rather than carried over: nobody can
-- say whose each answer was, and a day of retries is all it was ever for.
-- Nothing swept it, so it held every answer since the database began.

CREATE TABLE idempotency_answer (
  -- The sha256 of the bearer token the request came with.
  caller       text NOT NULL,
  method       text NOT NULL,
  url          text NOT NULL,
  key          text NOT NULL,
  status       int  NOT NULL,
  content_type text,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caller, method, url, key)
);

-- The window a phone might retry in, and the sweep of what is older.
CREATE INDEX idempotency_answer_age_idx ON idempotency_answer (created_at);

TRUNCATE idempotency_key;
