-- ── Roles are data, and the menu is Basu's to arrange ───────────────
--
-- Until now a role was one of four words in the code and the menu was a
-- list in the code, so nobody at Basu could make a role, give it pages, or
-- decide which roles a business may hand out without a release. Now:
--
--   access.role      every role, at Basu's desk or inside a business: its
--                    name and the pages and actions it opens. The desk's
--                    admin is locked — it opens everything, so Basu can
--                    never lock itself out. Everything else is Basu's to edit.
--   access.org_role  which roles a business may hand out, beyond the ones
--                    open to every business.
--   access.module,   the menu: the modules down the left, and where each
--   access.page      page sits under them, named and ordered by Basu. A page
--                    the code draws that has no row here sits where the code
--                    first put it; a page with an `href` is a link Basu added.
--
-- A member's role stays in the text column it always was in — it is now the
-- key of a row in access.role rather than one of four fixed words, so the
-- fixed lists go. The built-in roles are written by the server at start.

CREATE SCHEMA access;
COMMENT ON SCHEMA access IS 'Who may do what: roles and the pages they open, and how the menu is laid out.';

CREATE TABLE access.role (
  scope       text NOT NULL CHECK (scope IN ('desk', 'org')),
  -- A short, fixed name the members' rows point at; the name people read is `name`.
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,31}$'),
  name        text NOT NULL,
  description text,
  -- Page and action permissions, as `platform/access` names them.
  permissions text[] NOT NULL DEFAULT '{}',
  -- The desk's admin: everything, never narrowed, never removed.
  locked      boolean NOT NULL DEFAULT false,
  -- A business's head: what its registrant becomes; a business always keeps one.
  head        boolean NOT NULL DEFAULT false,
  -- Open to every business. Otherwise only to those chosen in access.org_role.
  everyone    boolean NOT NULL DEFAULT true,
  -- One the server writes at start: edited freely, never deleted.
  builtin     boolean NOT NULL DEFAULT false,
  sort        integer NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (scope, key)
);
CREATE UNIQUE INDEX role_name_key ON access.role (scope, lower(name));

-- A business, and a role it may hand out that is not open to everyone. No
-- foreign key to org, as everywhere.
CREATE TABLE access.org_role (
  org_id     uuid NOT NULL,
  role_key   text NOT NULL,
  granted_by text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, role_key)
);

CREATE TABLE access.module (
  scope      text NOT NULL CHECK (scope IN ('desk', 'org')),
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,31}$'),
  name       text NOT NULL,
  icon       text NOT NULL DEFAULT 'layers',
  sort       integer NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (scope, key)
);

CREATE TABLE access.page (
  scope      text NOT NULL CHECK (scope IN ('desk', 'org')),
  key        text NOT NULL,
  module_key text NOT NULL,
  name       text NOT NULL,
  icon       text,
  sort       integer NOT NULL DEFAULT 100,
  hidden     boolean NOT NULL DEFAULT false,
  -- Set for a link Basu added to the menu; a page the code draws has none.
  href       text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (scope, key)
);

-- The four fixed words go: a role is any key access.role has.
ALTER TABLE ops.member DROP CONSTRAINT member_role_check;
ALTER TABLE ops.access_request DROP CONSTRAINT access_request_role_check;
ALTER TABLE org.membership DROP CONSTRAINT membership_role_check;
ALTER TABLE org.membership_log DROP CONSTRAINT membership_log_role_check;
ALTER TABLE org.membership_log DROP CONSTRAINT membership_log_was_check;

-- The record keeps the role's name as it was that day, and says when Basu
-- changed what a business may hand out.
ALTER TABLE org.membership_log ADD COLUMN role_name text;
ALTER TABLE org.membership_log ADD COLUMN was_name text;
ALTER TABLE org.membership_log DROP CONSTRAINT membership_log_action_check;
ALTER TABLE org.membership_log ADD CONSTRAINT membership_log_action_check
  CHECK (action IN ('registered', 'approved', 'declined', 'added', 'role', 'removed', 'left', 'roles'));

-- The desk's record names roles and the menu too.
ALTER TABLE idesh.audit DROP CONSTRAINT audit_target_kind_check;
ALTER TABLE idesh.audit ADD CONSTRAINT audit_target_kind_check
  CHECK (target_kind IN ('supplier','listing','order','settlement','guest','member','restaurant','device','menu_item','receipt','ledger','message','setting','org','role','menu'));
