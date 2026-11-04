-- ── One owner, several suppliers ─────────────────────────────────────
--
-- 014 let a person hold one open supplier: one application, or one
-- contract. A company is more than one shop, though — Аргалакс has its
-- branches and its STEPPE MEAT brand, each with its own pickup point and
-- listings — and on 2026-11-04 the owner asked that one account own them
-- all. Each is its own supplier with its own organisation, opened from its
-- own workspace.
--
-- What stays one per person is an application still waiting on the
-- supplier screen: asking twice there is a slip, not a second business.
DROP INDEX IF EXISTS idesh.supplier_applicant_open_idx;

CREATE UNIQUE INDEX supplier_applicant_waiting_idx
  ON idesh.supplier (owner_guest_id)
  WHERE owner_guest_id IS NOT NULL AND state = 'applied';
