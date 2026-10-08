-- ── A certificate as it is printed ───────────────────────────────────
--
-- The first certificate table (047) was drawn before anybody here had held
-- one: a number, who gave it, a day, a photograph. The real paper — the
-- domestic certificate of МЭЕГ order А/67 (2021), and the electronic one
-- the state's system prints with its QR — says a good deal more, and most
-- of it is what makes a certificate worth reading:
--
--   * where the animals came from: аймаг, сум, баг, and the herder;
--   * how long it holds for, the route the meat took, where it was going;
--   * what it covers: which animals, what product, how many;
--   * the laboratory's tests, every one of them negative;
--   * the state inspector who confirmed it, beside the vet who wrote it;
--   * its QR, unique to the one certificate — what the state's site reads.
--
-- All of it nullable here: certificates written in before today stay as
-- they were, and the supplier can fill them in. The module asks the origin
-- of every new one.
ALTER TABLE idesh.certificate
  ADD COLUMN valid_until  date,
  ADD COLUMN inspector    text CHECK (length(inspector) BETWEEN 2 AND 120),
  ADD COLUMN origin_aimag text CHECK (length(origin_aimag) BETWEEN 2 AND 40),
  ADD COLUMN origin_soum  text CHECK (length(origin_soum) BETWEEN 2 AND 60),
  ADD COLUMN origin_bag   text CHECK (length(origin_bag) BETWEEN 1 AND 60),
  -- The herder names a person: supplier and desk only, never a guest.
  ADD COLUMN herder       text CHECK (length(herder) BETWEEN 2 AND 120),
  ADD COLUMN route        text CHECK (length(route) BETWEEN 2 AND 200),
  -- [{kind, what, unit, quantity}] — the certificate's product table.
  ADD COLUMN products     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(products) = 'array'),
  -- [{disease, tested_on?, lab?}] — tests the laboratory found negative.
  ADD COLUMN tests        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tests) = 'array'),
  -- What the QR says, as the supplier's camera read it.
  ADD COLUMN qr           text CHECK (length(qr) BETWEEN 1 AND 1000),
  ADD CONSTRAINT certificate_valid_after_issue CHECK (valid_until IS NULL OR valid_until >= issued_on);

-- One certificate written in by two suppliers is worth a look at the desk:
-- the same number, or the same QR, under another name.
CREATE INDEX certificate_number_idx ON idesh.certificate (number);
CREATE INDEX certificate_qr_idx ON idesh.certificate (qr) WHERE qr IS NOT NULL;
