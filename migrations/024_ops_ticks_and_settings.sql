-- ── The desk watches the machine ──────────────────────────────────────
--
-- Two small tables so that "is the scheduler running" and "what is the SMS
-- unit price" are questions the desk can answer without ssh.

-- Every tick leaves a line. Pruned to a week on insert; a week of ticks is
-- what anyone has ever wanted to look back over.
CREATE TABLE ops.tick (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL,
  took_ms integer NOT NULL,
  report  jsonb NOT NULL
);
CREATE INDEX tick_at_idx ON ops.tick (at DESC);

-- Named knobs, few, each with a record of who last turned it.
CREATE TABLE ops.setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE idesh.audit DROP CONSTRAINT audit_target_kind_check;
ALTER TABLE idesh.audit ADD CONSTRAINT audit_target_kind_check
  CHECK (target_kind IN ('supplier','listing','order','settlement','guest','member','restaurant','device','menu_item','receipt','ledger','message','setting'));
