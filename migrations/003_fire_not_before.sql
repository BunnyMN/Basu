-- «+5 минут» has to outlive the next re-plan.
--
-- The chef pressing hold is not a suggestion the planner may reconsider thirty
-- seconds later; it is the kitchen telling us the earliest minute it can start.
-- Without this the sweep recomputed the ideal fire time and quietly undid them.

ALTER TABLE dining_order
  ADD COLUMN fire_not_before timestamptz;

COMMENT ON COLUMN dining_order.fire_not_before IS
  'Earliest minute the kitchen will accept, set by the +5 button. The planner treats it as "now".';
