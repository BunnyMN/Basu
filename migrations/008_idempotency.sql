-- Idempotency keys, shared rather than remembered per process.
--
-- They were in a Map in the API process, which is wrong in two ways that both
-- showed up in a day:
--
--   · Two API instances behind one address do not share memory, so a phone
--     retrying onto the other instance orders lunch twice — which is the exact
--     thing the key exists to prevent.
--   · The demo reseeds the database without restarting the API, so the map
--     kept handing back 201s naming orders that had been deleted.
--
-- A table fixes both, is cheap at this volume, and gets truncated with
-- everything else when the demo starts over.

CREATE TABLE idempotency_key (
  key          text PRIMARY KEY,
  status       int  NOT NULL,
  content_type text,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The window a phone might retry in. Anything older is a new request.
CREATE INDEX idempotency_key_age_idx ON idempotency_key (created_at);
