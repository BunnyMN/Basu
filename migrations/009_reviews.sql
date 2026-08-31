-- What the guest thought, once they have eaten.
--
-- Two different questions, kept apart on purpose:
--
--   stars    — was it good? The thing another guest wants to know.
--   on_time  — did the food arrive when we said it would? The thing *we*
--              need to know, and the only number this product is judged on
--              (§14: TTFB). A four-star lunch that came ten minutes late is
--              a success by one measure and a failure by the other, and
--              averaging them into one score would hide exactly that.
--
-- A review belongs to an order, not to a guest and a restaurant: it is proof
-- that this person ate this food on this day, which is what makes it worth
-- reading. One order, one review.

CREATE TABLE order_review (
  order_id      uuid PRIMARY KEY REFERENCES dining_order(id) ON DELETE CASCADE,
  guest_id      uuid NOT NULL REFERENCES guest(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurant(id) ON DELETE CASCADE,
  stars         int  NOT NULL CHECK (stars BETWEEN 1 AND 5),
  -- Null until asked. False is a real answer and must not look like silence.
  on_time       boolean,
  comment       text CHECK (comment IS NULL OR length(comment) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_review_restaurant_idx ON order_review (restaurant_id, created_at DESC);

-- A guest who liked the soup and not the хуушуур has said something a single
-- score cannot carry, and it is the restaurant's most useful sentence.
CREATE TABLE dish_review (
  order_id     uuid NOT NULL REFERENCES dining_order(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES menu_item(id) ON DELETE CASCADE,
  stars        int  NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, menu_item_id)
);
CREATE INDEX dish_review_item_idx ON dish_review (menu_item_id);
