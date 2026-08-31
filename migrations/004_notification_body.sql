-- The rendered message belongs on the row.
--
-- It was being held in a process-local Map, which works right up until the API
-- enqueues a message and the scheduler — a different process — relays it and
-- finds nothing there. Notifications are written by one service and sent by
-- another by design, so the text has to travel with them.

ALTER TABLE notification
  ADD COLUMN body text NOT NULL DEFAULT '';
