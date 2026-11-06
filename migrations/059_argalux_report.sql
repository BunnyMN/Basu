-- ── One-off, read only: what is on file for Аргалакс / STEPPE MEAT ─────
--
-- On 2026-11-06 the owner of Basu sent the company's own document and asked
-- that its rows be put right. Nobody can read production from outside, so
-- this says what is there before 060 changes anything. It changes nothing.
--
-- The deploy's log is public: a business's name and pickup point, which guests
-- are shown anyway, and otherwise only states, counts and yes/no. Never the
-- account number or anybody's contact.

DO $$
DECLARE
  owner_id uuid;
  r record;
BEGIN
  SELECT id INTO owner_id FROM identity.guest WHERE lower(email) = 'info@argoluxmeat.com' AND closed_at IS NULL;
  RAISE NOTICE '059: owner account %', CASE WHEN owner_id IS NULL THEN 'not found' ELSE 'found' END;

  FOR r IN
    SELECT right(phone_e164, 2) AS phone_end, id = owner_id AS is_owner, closed_at IS NOT NULL AS closed
      FROM identity.guest WHERE phone_e164 IN ('+97691059098', '+97690940083')
  LOOP
    RAISE NOTICE '059: an account has the phone ending %: is_owner=% closed=%', r.phone_end, r.is_owner, r.closed;
  END LOOP;

  FOR r IN
    SELECT s.id, s.name, s.state, s.active, s.pickup_address, s.org_id,
           s.owner_guest_id IS NOT DISTINCT FROM owner_id AS owned,
           right(s.phone, 2) AS phone_end, s.lat IS NOT NULL AS pinned,
           s.ebarimt_merchant_tin AS tin, s.about IS NOT NULL AS has_about,
           s.bank_name IS NOT NULL AS bank_named, s.bank_account IS NOT NULL AS bank_account,
           s.bank_holder IS NOT NULL AS bank_holder, s.bank_verified_at IS NOT NULL AS bank_verified,
           s.contracted_at,
           (SELECT count(*) FROM idesh.listing l WHERE l.supplier_id = s.id) AS listings,
           (SELECT count(*) FROM idesh.idesh_order o WHERE o.supplier_id = s.id) AS orders,
           (SELECT count(*) FROM idesh.certificate c WHERE c.supplier_id = s.id) AS certificates,
           (SELECT count(*) FROM idesh.promotion p WHERE p.supplier_id = s.id) AS promotions,
           (SELECT count(*) FROM idesh.settlement x WHERE x.supplier_id = s.id) AS settlements,
           (SELECT count(*) FROM idesh.payout_batch b WHERE b.supplier_id = s.id) AS batches
      FROM idesh.supplier s
     WHERE s.owner_guest_id = owner_id OR s.name ILIKE '%аргалакс%' OR s.name ILIKE '%steppe%'
        OR s.name ILIKE '%argalux%' OR s.ebarimt_merchant_tin = '45200197789'
     ORDER BY s.created_at
  LOOP
    RAISE NOTICE '059: supplier % «%» state=% active=% owned=% org=% phone_end=% pinned=% tin=% about=% at «%»',
      left(r.id::text, 8), r.name, r.state, r.active, r.owned, left(r.org_id::text, 8), r.phone_end, r.pinned, r.tin, r.has_about, left(r.pickup_address, 60);
    RAISE NOTICE '059:   bank named=% account=% holder=% verified=% | listings=% orders=% certificates=% promotions=% settlements=% batches=%',
      r.bank_named, r.bank_account, r.bank_holder, r.bank_verified, r.listings, r.orders, r.certificates, r.promotions, r.settlements, r.batches;
  END LOOP;

  FOR r IN
    SELECT o.id, o.name, o.state, o.supplier, o.restaurant, o.address, o.lat IS NOT NULL AS pinned, o.tin,
           o.about IS NOT NULL AS has_about,
           o.applied_by IS NOT DISTINCT FROM owner_id AS owned,
           right(o.phone, 2) AS phone_end,
           (SELECT count(*) FROM org.membership m WHERE m.org_id = o.id) AS members,
           (SELECT count(*) FROM org.membership m WHERE m.org_id = o.id AND m.guest_id = owner_id AND m.role = 'owner') AS owner_seats,
           (SELECT count(*) FROM idesh.supplier s WHERE s.org_id = o.id) AS suppliers,
           (SELECT count(*) FROM dine.restaurant d WHERE d.org_id = o.id) AS restaurants
      FROM org.organization o
     WHERE o.applied_by = owner_id
        OR o.id IN (SELECT m.org_id FROM org.membership m WHERE m.guest_id = owner_id)
        OR o.name ILIKE '%аргалакс%' OR o.name ILIKE '%steppe%' OR o.name ILIKE '%argalux%'
        OR o.tin = '45200197789'
     ORDER BY o.created_at
  LOOP
    RAISE NOTICE '059: org % «%» state=% supplier=% restaurant=% owned=% phone_end=% pinned=% tin=% about=% members=% owner_seats=% suppliers=% restaurants=% at «%»',
      left(r.id::text, 8), r.name, r.state, r.supplier, r.restaurant, r.owned, r.phone_end, r.pinned, r.tin, r.has_about, r.members, r.owner_seats, r.suppliers, r.restaurants, left(r.address, 60);
  END LOOP;
END $$;
