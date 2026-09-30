-- ── Every desk session ends, once ─────────────────────────────────────
--
-- The dashboard kept its sign-in in the browser under a key of its own,
-- apart from the website's, and nothing on the website ever replaced or
-- cleared it: a browser where the admin had once opened the desk opened it
-- again for whoever signed in there next, with any account. Its «Гарах»
-- only forgot the token, and a sign-in by Google also left the token in
-- the browser's history, so a desk session could outlive the tab by the
-- sixty days a session lives.
--
-- The pages now hold one person per browser and end a session on the
-- server when they sign out. What is left over from before ends here:
-- every open session of an account that sits at the desk. Its people sign
-- in once more. The one place this migration looks across the line, once.

UPDATE identity.guest_session
   SET revoked_at = now()
 WHERE revoked_at IS NULL
   AND guest_id IN (SELECT guest_id FROM ops.member_account);
