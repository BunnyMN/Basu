-- ── Задаргаа: how a whole animal is taken apart for the guest ─────────
--
-- A sheep bought whole reaches a household as one carcass, as joints, or cut
-- small and bagged for the pot — and until now which of those was a sentence
-- in the listing's note and a telephone call after the money had moved.
-- Now the supplier says on the listing what they will do, the guest chooses
-- as they order, and the order keeps the choice: it is what the supplier
-- reads while the animal is on the block, and what both are held to after.
--
-- The words are Basu's (src/idesh/breakdown.ts), not each supplier's, so two
-- listings can be compared and a guest reads the same six parts everywhere.

-- What the supplier offers. Empty is «said nothing»: the guest is asked
-- nothing, as before. Only a whole animal is taken apart to order — meat by
-- the kilogram is already whatever it is.
ALTER TABLE idesh.listing
  ADD COLUMN breakdown_styles text[] NOT NULL DEFAULT '{}'
    CHECK (breakdown_styles <@ ARRAY['carcass','jointed','cut']::text[]),
  -- Per head, for cutting small and bagging. Jointing is part of the price.
  ADD COLUMN cut_fee_mnt bigint NOT NULL DEFAULT 0 CHECK (cut_fee_mnt >= 0),
  ADD CONSTRAINT listing_breakdown_whole_only
    CHECK (unit = 'whole' OR cardinality(breakdown_styles) = 0),
  -- Nobody carries a cow home in one piece.
  ADD CONSTRAINT listing_carcass_small_stock
    CHECK (kind IN ('sheep','goat') OR NOT ('carcass' = ANY (breakdown_styles))),
  -- Whoever cuts small can joint: a guest may keep the legs whole and have the ribs cut.
  ADD CONSTRAINT listing_cut_means_jointed
    CHECK (NOT ('cut' = ANY (breakdown_styles)) OR 'jointed' = ANY (breakdown_styles)),
  ADD CONSTRAINT listing_cut_fee_needs_cut
    CHECK (cut_fee_mnt = 0 OR 'cut' = ANY (breakdown_styles));

-- What the guest chose, copied like everything else on an order. `carcass`
-- is the animal untouched; `parts` is jointed, with `cut_parts` the joints to
-- be cut small — none of them is «мөчилсөн», all of them «хоолны хэмжээгээр».
-- The fee is the whole of it (per head × heads) and part of the meat price:
-- commission and the forfeit are worked out on it, so a supplier gains
-- nothing by moving the price of the animal into the price of the knife.
ALTER TABLE idesh.idesh_order
  ADD COLUMN breakdown text CHECK (breakdown IN ('carcass','parts')),
  ADD COLUMN cut_parts text[] NOT NULL DEFAULT '{}'
    CHECK (cut_parts <@ ARRAY['fore','hind','rump','spine','ribs','neck']::text[]),
  ADD COLUMN breakdown_note text CHECK (breakdown_note IS NULL OR length(breakdown_note) BETWEEN 1 AND 140),
  ADD COLUMN cut_fee_mnt bigint NOT NULL DEFAULT 0 CHECK (cut_fee_mnt >= 0),
  ADD CONSTRAINT idesh_order_cut_parts_of_parts
    CHECK (cardinality(cut_parts) = 0 OR breakdown = 'parts'),
  ADD CONSTRAINT idesh_order_cut_fee_for_cutting
    CHECK (cut_fee_mnt = 0 OR cardinality(cut_parts) > 0),
  ADD CONSTRAINT idesh_order_note_with_breakdown
    CHECK (breakdown_note IS NULL OR breakdown IS NOT NULL);
