-- ── The veterinary certificate the meat came with ────────────────────
--
-- Meat that crosses a soum's border travels with a «мал эмнэлгийн гэрчилгээ»
-- — what people call the «гарал үүслийн бичиг» — given by the soum's vet for
-- one shipment, numbered, and since 2020 kept in the state's own system
-- (МЭНС). The number is what anybody can look up there; Basu keeps it beside
-- the meat it came with, so a guest reads which certificate their meat has
-- and the desk can check the ones it chooses to.
--
-- One row per certificate, the supplier's own. A shipment is many listings
-- and many orders, so both point here rather than each holding a copy.
-- The photograph is for the supplier and the desk only: a certificate names
-- the herder and the lorry, and neither is a guest's to read.

CREATE TABLE idesh.certificate (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES idesh.supplier(id) ON DELETE CASCADE,
  -- As printed on the certificate. Kept as typed but for case and spaces.
  number      text NOT NULL CHECK (length(number) BETWEEN 3 AND 40),
  -- Who gave it: «Архангай, Их тамир сумын мал эмнэлэг».
  issuer      text NOT NULL CHECK (length(issuer) BETWEEN 2 AND 120),
  issued_on   date NOT NULL,
  photo       bytea,
  photo_type  text CHECK (photo_type IN ('image/jpeg', 'image/png')),
  -- unchecked: as the supplier wrote it. genuine / false: somebody at the
  -- desk looked the number up in the state's system and says so.
  state       text NOT NULL DEFAULT 'unchecked' CHECK (state IN ('unchecked', 'genuine', 'false')),
  checked_by  text,
  checked_at  timestamptz,
  check_note  text,
  -- The person who wrote it in. No foreign key to identity, as everywhere.
  added_by    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, number),
  CHECK ((photo IS NULL) = (photo_type IS NULL)),
  CHECK (state = 'unchecked' OR (checked_by IS NOT NULL AND checked_at IS NOT NULL))
);
CREATE INDEX certificate_supplier_idx ON idesh.certificate (supplier_id, issued_on DESC);
CREATE INDEX certificate_unchecked_idx ON idesh.certificate (created_at) WHERE state = 'unchecked';

-- Meat by the kilogram is already slaughtered and already has its
-- certificate: the listing carries it. A whole animal is slaughtered after
-- it is paid for, so its certificate arrives with the order, at «Бэлэн».
ALTER TABLE idesh.listing     ADD COLUMN certificate_id uuid REFERENCES idesh.certificate(id);
ALTER TABLE idesh.idesh_order ADD COLUMN certificate_id uuid REFERENCES idesh.certificate(id);
CREATE INDEX listing_certificate_idx ON idesh.listing (certificate_id) WHERE certificate_id IS NOT NULL;
CREATE INDEX order_certificate_idx ON idesh.idesh_order (certificate_id) WHERE certificate_id IS NOT NULL;

-- The desk's record names certificates too: checked, with what was found.
ALTER TABLE idesh.audit DROP CONSTRAINT audit_target_kind_check;
ALTER TABLE idesh.audit ADD CONSTRAINT audit_target_kind_check
  CHECK (target_kind IN ('supplier','listing','order','settlement','guest','member','restaurant','device','menu_item','receipt','ledger','message','setting','org','role','menu','promotion','certificate'));

-- A new desk page, «Гэрчилгээ». On a server that already has its roles,
-- whoever reads suppliers reads certificates, and whoever manages suppliers
-- may say what a check found. A fresh server gets both from the code.
UPDATE access.role
   SET permissions = array_append(permissions, 'desk.certificates')
 WHERE scope = 'desk' AND 'desk.suppliers' = ANY (permissions)
   AND NOT ('desk.certificates' = ANY (permissions));
UPDATE access.role
   SET permissions = array_append(permissions, 'desk.certificates:check')
 WHERE scope = 'desk' AND 'desk.suppliers:manage' = ANY (permissions)
   AND NOT ('desk.certificates:check' = ANY (permissions));
