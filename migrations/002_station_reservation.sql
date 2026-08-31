-- The station load ledger, persisted.
--
-- In the simulator this lives in memory, which is fine for one process. In
-- production two API instances and a scheduler all plan against the same
-- kitchen, so the ledger has to be somewhere they can all see and lock.
--
-- One row per (order, station, minute) a lane is spoken for. Counting rows in
-- a minute gives occupancy; deleting by order_id releases everything at once.

CREATE TABLE station_reservation (
  order_id      uuid NOT NULL REFERENCES dining_order(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurant(id) ON DELETE CASCADE,
  station_code  text NOT NULL,
  -- Epoch minute. Integers make the occupancy query a plain range scan.
  minute        int  NOT NULL,
  PRIMARY KEY (order_id, station_code, minute)
);

CREATE INDEX station_reservation_load_idx
  ON station_reservation (restaurant_id, station_code, minute);
