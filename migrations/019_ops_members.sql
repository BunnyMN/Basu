-- ── Who ops is ─────────────────────────────────────────────────────────
--
-- Until now the desk was one shared secret in the server's environment:
-- whoever had it was «ops», and the record could only take their word for
-- their name. Now the desk has members — people, by the phone they sign in
-- with like anybody else — each with a role, and every action is recorded
-- under the member the session belongs to. The shared secret retires in
-- production; the demo keeps it for walkthroughs.

CREATE SCHEMA ops;
COMMENT ON SCHEMA ops IS 'The desk: who may sit at it, and with what authority.';

CREATE TABLE ops.member (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The phone they sign in with. Matched against identity by number, not by
  -- id: identity is a module, and a member may be added before they have
  -- ever signed in.
  phone      text UNIQUE NOT NULL CHECK (phone ~ '^\+976[0-9]{8}$'),
  name       text NOT NULL,
  -- admin: everything, including who is a member. finance: money in and out.
  -- ops: orders, suppliers, listings. viewer: looks only.
  role       text NOT NULL CHECK (role IN ('admin','finance','ops','viewer')),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
