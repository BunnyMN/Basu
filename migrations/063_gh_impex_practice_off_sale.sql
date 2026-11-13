-- ── One-off: GH impex's practice listings stop selling ─────────────────
--
-- In October the owner of Basu put seventeen practice listings on their own
-- business, GH impex, to show somebody how the market looks: made-up animals
-- at made-up prices (one of them 10₮ a kilo) under ЖИШЭЭ certificates. They
-- were left open, and strangers have been paying for meat that does not exist
-- (2026-11-13). This takes every one of them off sale. Nothing is deleted: a
-- listing off sale is the same row with `active` false, which the business can
-- turn back on from its own page.
--
-- And the number on that business, which every guest who paid is shown and
-- rings, was the owner's own. It becomes the number of the person who answers
-- for GH impex. Only rows that have an owner are changed: a row nobody owns
-- would be claimed by whoever signs in with that number (suppliers.ts).
--
-- The deploy's log is public, so this says counts and yes/no, never a phone.
-- It does nothing where GH impex is not (a laptop, CI).

DO $$
DECLARE
  the_supplier constant uuid := '4c07878a-63dd-409d-ba04-79104afc9a1d';
  old_tail     constant text := '89533397';
  new_phone    constant text := '+97688102856';
  n_off        int;
  n_suppliers  int;
  n_orgs       int;
  n_unowned    int;
  r            record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM idesh.supplier WHERE id = the_supplier) THEN
    RAISE NOTICE '063: GH impex is not in this database — nothing to change';
    RETURN;
  END IF;

  UPDATE idesh.listing SET active = false, updated_at = now() WHERE supplier_id = the_supplier AND active;
  GET DIAGNOSTICS n_off = ROW_COUNT;
  RAISE NOTICE '063: % GH impex listings taken off sale', n_off;

  -- What strangers left behind, for the desk to give back: counts only.
  FOR r IN
    SELECT state, count(*) AS n, sum(total_mnt + service_fee_mnt) AS paid_mnt
      FROM idesh.idesh_order
     WHERE supplier_id = the_supplier AND state <> 'CLOSED'
     GROUP BY state ORDER BY state
  LOOP
    RAISE NOTICE '063: GH impex orders % = % (% ₮ with the fee)', r.state, r.n, r.paid_mnt;
  END LOOP;

  UPDATE idesh.supplier SET phone = new_phone
   WHERE right(regexp_replace(phone, '\D', '', 'g'), 8) = old_tail AND owner_guest_id IS NOT NULL;
  GET DIAGNOSTICS n_suppliers = ROW_COUNT;

  UPDATE org.organization SET phone = new_phone
   WHERE right(regexp_replace(phone, '\D', '', 'g'), 8) = old_tail;
  GET DIAGNOSTICS n_orgs = ROW_COUNT;

  SELECT count(*) INTO n_unowned FROM idesh.supplier
   WHERE right(regexp_replace(phone, '\D', '', 'g'), 8) = old_tail;
  RAISE NOTICE '063: the number changed on % suppliers and % businesses; % unowned suppliers still carry the old one',
    n_suppliers, n_orgs, n_unowned;
END $$;
