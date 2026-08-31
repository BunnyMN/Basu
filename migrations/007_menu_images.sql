-- A picture of the food, and a station that steams.
--
-- Menus are chosen with the eyes. A list of names and prices is a spreadsheet;
-- a guest deciding where to walk in ten minutes is looking at pictures.
--
-- The steam station arrives with the same change because буузны газар was
-- impossible to model without it: steaming is its own line, it is slow, and
-- бууз hold their heat far better than anything off a grill — which is exactly
-- the kind of difference the fire planner exists to exploit.

ALTER TABLE menu_item
  ADD COLUMN image_url text,
  ADD COLUMN description text;

COMMENT ON COLUMN menu_item.image_url IS
  'Absolute path or URL. /dishes/<slug>.svg renders one on demand; a real photo drops in here unchanged.';
