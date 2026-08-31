-- Where the restaurant actually is.
--
-- The product is location-based in a way the schema had not admitted: the ETA
-- model already reasons about geofence_800 and geofence_300 signals, but
-- nothing could emit them because nothing knew where anything was. Walking
-- minutes were a per-venue constant typed in by hand.

ALTER TABLE restaurant
  ADD COLUMN lat numeric(9,6),
  ADD COLUMN lon numeric(9,6);

COMMENT ON COLUMN restaurant.lat IS
  'WGS84. Feeds the map, the walk estimate, and the geofence bands in §04.';

-- Ulaanbaatar only, and generously bounded: a coordinate outside this is a
-- data-entry mistake, not a restaurant.
ALTER TABLE restaurant
  ADD CONSTRAINT restaurant_coords_sane CHECK (
    (lat IS NULL AND lon IS NULL) OR
    (lat BETWEEN 47.7 AND 48.1 AND lon BETWEEN 106.6 AND 107.3)
  );
