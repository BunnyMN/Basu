-- ── One-off: Аргалакс ХХК's two shops, as its own document has them ────
--
-- 060 again. It stopped and changed nothing: the first shop's name had a
-- no-break space in it, pasted in with the name, so it read the same in the log
-- and compared different. The name is now compared whatever its spaces are.
--
-- The company sells as STEPPE MEAT from two shops. On file (059) were
-- «Аргалакс ХХК  Салбар 1», the first shop under the company's name with a
-- second space in it, and «STEPPE MEAT», written in as a third place at the
-- company's address in Төв аймаг, where nobody collects meat, with no account
-- to be paid into. The second shop was not there at all, and the first
-- business had lost its ТТД on the way in (fixed in 0701b30).
--
-- The owner of Basu sent the company's document on 2026-11-06 and asked that
-- it be put right. These two rows become the two shops: nothing is deleted,
-- and neither has a listing, an order or anybody but its owner.
--
--   51649d0d  «STEPPE MEAT · Салбар-1»  Өглөө хүнсний зах, БЗД
--   5204237e  «STEPPE MEAT · Салбар-2»  120 мянгат, ХУД
--
-- The repository is public, so the account is not written here: the second
-- shop is given the first's, sealed as it stands — the document names one
-- account for the company. An account the desk writes in counts as checked,
-- and so does this one. The first shop's pin stays empty: the document gives
-- no point for it, and a guess would send a guest to the wrong gate.
--
-- It does nothing where the company is not (a laptop, CI), and changes nothing
-- if the rows are no longer as 059 found them.

DO $$
DECLARE
  owner_id uuid;
  one      idesh.supplier%ROWTYPE;
  two      idesh.supplier%ROWTYPE;
  story    text;
  n_orders int;
  n_others int;
  r        record;
BEGIN
  SELECT id INTO owner_id FROM identity.guest WHERE lower(email) = 'info@argoluxmeat.com' AND closed_at IS NULL;
  IF owner_id IS NULL THEN
    RAISE NOTICE '061: that company is not in this database — nothing to do';
    RETURN;
  END IF;

  SELECT * INTO one FROM idesh.supplier
   WHERE id::text LIKE '51649d0d-%' AND owner_guest_id = owner_id AND state = 'contracted' FOR UPDATE;
  SELECT * INTO two FROM idesh.supplier
   WHERE id::text LIKE '5204237e-%' AND owner_guest_id = owner_id AND state = 'contracted' FOR UPDATE;

  IF one.id IS NULL OR two.id IS NULL OR one.org_id IS NULL OR two.org_id IS NULL THEN
    RAISE NOTICE '061: stopped, changed nothing: the two rows are not as 059 found them';
    RETURN;
  END IF;
  IF regexp_replace(translate(one.name, U&'\00A0', ' '), ' +', ' ', 'g') <> 'Аргалакс ХХК Салбар 1' OR two.name <> 'STEPPE MEAT' THEN
    RAISE NOTICE '061: stopped, changed nothing: a name has been changed since 059';
    RETURN;
  END IF;
  IF one.bank_account IS NULL OR one.bank_holder IS NULL OR one.bank_verified_at IS NULL THEN
    RAISE NOTICE '061: stopped, changed nothing: the first shop has no checked account to share';
    RETURN;
  END IF;
  IF two.bank_account IS NOT NULL THEN
    RAISE NOTICE '061: stopped, changed nothing: an account has been written in since 059';
    RETURN;
  END IF;

  SELECT count(*) INTO n_orders FROM idesh.idesh_order WHERE supplier_id IN (one.id, two.id);
  IF n_orders <> 0 THEN
    RAISE NOTICE '061: stopped, changed nothing: % orders have come in since 059', n_orders;
    RETURN;
  END IF;

  SELECT count(*) INTO n_others FROM idesh.supplier
   WHERE owner_guest_id = owner_id AND state <> 'declined' AND id NOT IN (one.id, two.id);
  IF n_others <> 0 THEN
    RAISE NOTICE '061: stopped, changed nothing: % more businesses of this owner since 059', n_others;
    RETURN;
  END IF;

  -- The company's own words about itself, which only the row written from its form has.
  story := COALESCE(two.about, (SELECT about FROM org.organization WHERE id = two.org_id));

  UPDATE idesh.supplier
     SET name = 'STEPPE MEAT · Салбар-1',
         pickup_address = 'БЗД, 27-р хороо, Дунд дарь эх 41 гудамж, 2075 тоот, Ulaanbaatar, Mongolia, 13352, Нэрийн барааны салбар-1 Өглөө хүнсний зах 20-р павилон STEPPE MEAT Махны дэлгүүр',
         about = story
   WHERE id = one.id;

  UPDATE idesh.supplier
     SET name = 'STEPPE MEAT · Салбар-2',
         phone = '+97690940083',
         pickup_address = 'ХУД 1-р хороо, 120 мянгат 5-р байр, Улаанбаатар 17030, Нэрийн барааны салбар-2, STEPPE MEAT Махны дэлгүүр',
         lat = 47.9031875,
         lon = 106.9083125,
         ebarimt_merchant_tin = one.ebarimt_merchant_tin,
         about = story,
         bank_name = one.bank_name,
         bank_account = one.bank_account,
         bank_holder = one.bank_holder,
         bank_verified_at = now()
   WHERE id = two.id;

  -- The business and its supplier read the same, everywhere the desk shows either.
  UPDATE org.organization o
     SET name = s.name, phone = s.phone, address = s.pickup_address, lat = s.lat, lon = s.lon,
         tin = s.ebarimt_merchant_tin, about = s.about
    FROM idesh.supplier s
   WHERE s.org_id = o.id AND s.id IN (one.id, two.id);

  -- The desk's record says who changed these, as it does for anything done by hand.
  INSERT INTO idesh.audit (who, action, target_kind, target_id, note)
  VALUES ('migration:061', 'supplier.terms', 'supplier', one.id, 'Аргалакс ХХК-ийн баримтаар зассан: нэр, хаяг, тайлбар'),
         ('migration:061', 'supplier.terms', 'supplier', two.id, 'Аргалакс ХХК-ийн баримтаар зассан: нэр, утас, хаяг, байршил, данс (Салбар-1-тэй ижил)');

  -- Read back what was written, for the log.
  FOR r IN
    SELECT s.name, right(s.phone, 2) AS phone_end, s.lat IS NOT NULL AS pinned, s.ebarimt_merchant_tin AS tin,
           s.about IS NOT NULL AS has_about, s.bank_account IS NOT NULL AS account, s.bank_verified_at IS NOT NULL AS verified,
           s.state, s.active, o.name = s.name AND o.tin IS NOT DISTINCT FROM s.ebarimt_merchant_tin
             AND o.address = s.pickup_address AND o.phone = s.phone AND o.about IS NOT DISTINCT FROM s.about AS org_matches,
           o.state AS org_state
      FROM idesh.supplier s JOIN org.organization o ON o.id = s.org_id
     WHERE s.id IN (one.id, two.id) ORDER BY s.name
  LOOP
    RAISE NOTICE '061: «%» state=% active=% phone_end=% pinned=% tin=% about=% account=% verified=% org=% org_matches=%',
      r.name, r.state, r.active, r.phone_end, r.pinned, r.tin, r.has_about, r.account, r.verified, r.org_state, r.org_matches;
  END LOOP;
END $$;
