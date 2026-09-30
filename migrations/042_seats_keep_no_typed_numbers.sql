-- ── A seat keeps no number its person only typed ─────────────────────
--
-- Choosing an account for a seat — and before that, saying yes to an
-- account that asked for one — wrote the account's phone number onto the
-- seat: the number typed at sign-up, which proves nothing, since with
-- passwords anybody can type anybody's. A number on a seat says that
-- whoever proves it sits there. So the day SMS codes reach numbers, whoever
-- proved that one would have been handed the seat — a colleague's after
-- they left and somebody took the number up — and until then it kept the
-- number's owner from being named by OPS_MEMBERS at all.
--
-- A seat is named now only by what an account proved. The numbers the
-- choosing wrote are let go here: on a seat an admin gave by choice or by a
-- yes, a number no account sitting in it has proved with a code. The seat
-- stays, its accounts stay in it, and its role and switch are as they were.
-- The one place this migration looks across the line, once.

UPDATE ops.member m
   SET phone = NULL, updated_at = now()
 WHERE m.phone IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM ops.member_account a
          WHERE a.member_id = m.id AND a.how IN ('chosen', 'request'))
   AND NOT EXISTS (
         SELECT 1 FROM ops.member_account a
           JOIN identity.guest g ON g.id = a.guest_id
          WHERE a.member_id = m.id AND g.phone_e164 = m.phone AND g.phone_verified_at IS NOT NULL);
