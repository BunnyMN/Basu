-- ── The supplier's own photographs of what they sell ───────────────────
--
-- Every listing wore one of Basu's example pictures, marked «Жишээ зураг»:
-- honest, and no help to somebody choosing between two sheep. Now a supplier
-- photographs the animal itself — from the side, from behind, the fat on
-- its back — and the listing shows those instead, the first one on its card.
--
-- A row per photograph, each kept twice: as it is looked at on the stall's
-- own page, and small for a card in a list. Both are made by the page that
-- sends them (a canvas), as a certificate's is: the server keeps no image
-- library and resizes nothing. A photograph is never changed once kept, so
-- its address can be cached for good; taking one away takes its row.

CREATE TABLE idesh.listing_photo (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES idesh.listing(id) ON DELETE CASCADE,
  -- Its place among the listing's photographs: the lowest is the cover.
  position   int  NOT NULL DEFAULT 0 CHECK (position >= 0),
  photo      bytea NOT NULL,
  photo_type text  NOT NULL CHECK (photo_type IN ('image/jpeg', 'image/png')),
  thumb      bytea NOT NULL,
  thumb_type text  NOT NULL CHECK (thumb_type IN ('image/jpeg', 'image/png')),
  -- The person who put it up. No foreign key to identity, as everywhere.
  added_by   uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_photo_listing_idx ON idesh.listing_photo (listing_id, position, created_at);
