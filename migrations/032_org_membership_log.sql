-- ── Who gave whom which role, and when ──────────────────────────────
--
-- A business's roles decide who sees its money and who can cancel an
-- order, so a change to them is worth a line of its own: who registered the
-- business, who the desk was when it said yes, who brought whom in as what,
-- who changed a role and who took somebody out. The owner and the managers
-- read it on the dashboard; nothing reads it back to decide anything.
--
-- Written once, never updated: a mistake is corrected by the next line.

CREATE TABLE org.membership_log (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES org.organization (id) ON DELETE CASCADE,
  -- The account that did it, or the desk member's name when the desk did.
  -- No foreign key to identity, as everywhere.
  actor_guest uuid,
  actor_desk  text,
  action      text NOT NULL CHECK (action IN ('registered', 'approved', 'declined', 'added', 'role', 'removed', 'left')),
  -- Whom it was done to, and the role before and after.
  guest_id    uuid,
  role        text CHECK (role IN ('owner', 'manager', 'staff', 'accountant')),
  was         text CHECK (was IN ('owner', 'manager', 'staff', 'accountant')),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX membership_log_org_idx ON org.membership_log (org_id, at DESC, id DESC);

-- The businesses that exist already begin their record with the people in
-- them now: whoever registered it, then everybody brought in since.
INSERT INTO org.membership_log (org_id, actor_guest, action, guest_id, role, at)
SELECT m.org_id, COALESCE(m.added_by, m.guest_id),
       CASE WHEN m.guest_id = o.applied_by AND m.role = 'owner' THEN 'registered' ELSE 'added' END,
       m.guest_id, m.role, m.added_at
  FROM org.membership m
  JOIN org.organization o ON o.id = m.org_id
 ORDER BY m.added_at;
