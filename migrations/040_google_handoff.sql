-- ── A sign-in from Google reaches the page as a code, never a session ────
--
-- Google sends a person back to our callback, and the callback sent them on
-- to the page they had started from with the session itself in the
-- address's fragment: `/supplier#auth=…`. A fragment never reaches a server,
-- but the browser's history keeps the address as it was visited, fragment
-- and all, and Chrome syncs that history to every device the person is
-- signed in on — a live session, sitting there for the sixty days a session
-- lives. And every page took whatever `#auth=` it was opened with: a link
-- carrying an attacker's own session signed whoever opened it into the
-- attacker's account.
--
-- Now the page gets a code: good once, for a minute, and only together with
-- a cookie the callback sets in the browser that went to Google. The page
-- trades the two for the session in a request of its own. A code read out
-- of a history has been spent; one sent to somebody else in a link arrives
-- without its cookie. Both are kept as hashes, like every other secret here.
-- The iPhone app is not a browser: its system sign-in sheet hands the
-- session straight to the app at `basu://auth`, and that stays as it is.

CREATE TABLE identity.auth_handoff (
  code_hash    text PRIMARY KEY,
  -- The cookie's value, hashed: the code is good only in the browser that holds it.
  binding_hash text NOT NULL,
  guest_id     uuid NOT NULL REFERENCES identity.guest(id) ON DELETE CASCADE,
  -- What the session will be called in the person's list of them: «Google».
  label        text,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL
);

-- ── The sessions already out there end, once ─────────────────────────────
--
-- Every sign-in by Google on the website until now left its session in that
-- browser's history. Those sessions end here, so what a history holds is
-- dead rather than good for weeks more; their people sign in once more.
-- The iPhone app's Google sign-ins carry the same label and cannot be told
-- apart from them, so they sign in once more too.

UPDATE identity.guest_session
   SET revoked_at = now()
 WHERE revoked_at IS NULL
   AND label = 'Google';
