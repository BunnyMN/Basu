-- ── One-off: the pilot's first orders were its owner trying the door ───
--
-- Before the pilot had a real customer, its owner bought from their own
-- business, GH impex, to see the whole road work: eighteen orders, paid,
-- walked through and closed, between people who were all the same household.
-- They read as sales on the supplier's «Захиалгууд», in the desk's numbers
-- and as money owed to a supplier — and the owner asked for them gone before
-- real orders arrive beside them (2026-10-06).
--
-- So this removes exactly those: every order of that one supplier made before
-- the moment the owner looked at the list, with everything that was written
-- because of them — the purchase and its top-up, what was set aside for the
-- supplier and paid out, refunds, receipts, messages, the desk's notes on
-- them — and gives their animals back to the listings. Whole transfers go,
-- never half of one, so the ledger still sums to nothing afterwards.
--
-- The ledger is append-only and this is the exception that says so: a wrong
-- entry is put right by writing its opposite, and that stays the rule. These
-- were never wrong entries, only rehearsal, and reversing them would leave
-- thirty-six lines of rehearsal in the books for good. The deploy dumps the
-- database before it migrates; that dump is the way back.
--
-- It does nothing anywhere the supplier is not (a laptop, CI), and it stops —
-- changing nothing — if it finds any number of orders but the eighteen that
-- were on the screen.

DO $$
DECLARE
  the_supplier constant uuid := '4c07878a-63dd-409d-ba04-79104afc9a1d';
  -- When the owner looked: the list read «18 захиалга».
  seen_at      constant timestamptz := '2026-10-06 07:13:28+00';
  expected     constant int := 18;
  n_listed     int;
  n_orders     int;
  n_transfers  int;
  n_topups     int;
  n_messages   int;
  n_wallets    int;
  n_overdrawn  int;
  o            record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM idesh.supplier WHERE id = the_supplier) THEN
    RAISE NOTICE '050: that supplier is not in this database — nothing to remove';
    RETURN;
  END IF;

  -- Nothing moves them along while they are being taken away.
  PERFORM 1 FROM idesh.idesh_order WHERE supplier_id = the_supplier AND created_at < seen_at FOR UPDATE;

  CREATE TEMP TABLE gone_order ON COMMIT DROP AS
    SELECT id, guest_id, listing_id, qty, state, paid_at, ledger_transfer_id,
           -- Still counted as sold: never cancelled, or cancelled after the animal was slaughtered.
           (cancelled_at IS NULL OR preparing_at IS NOT NULL) AS holds
      FROM idesh.idesh_order
     WHERE supplier_id = the_supplier AND created_at < seen_at;

  -- What the supplier's list counts: everything but an unpaid draft.
  SELECT count(*) INTO n_listed FROM gone_order WHERE state <> 'DRAFT';
  IF n_listed <> expected THEN
    RAISE EXCEPTION '050: expected % orders on that supplier''s list, found % — nothing removed', expected, n_listed;
  END IF;
  SELECT count(*) INTO n_orders FROM gone_order;

  CREATE TEMP TABLE gone_settlement ON COMMIT DROP AS
    SELECT id, ledger_accrual_id, ledger_payout_id FROM idesh.settlement WHERE order_id IN (SELECT id FROM gone_order);

  -- The invoices raised to pay for them, paid or not.
  CREATE TEMP TABLE gone_topup ON COMMIT DROP AS
    SELECT id, transfer_id, provider, provider_ref
      FROM ledger.topup
     WHERE for_subject = 'idesh' AND for_subject_id IN (SELECT id FROM gone_order);

  -- A top-up from before invoices named their order (045) carries no such name. The order's own
  -- record says how much of its price was topped up as it was paid: the same guest's top-up of
  -- exactly that much, settled as the order was paid, is the one — each taken once.
  FOR o IN
    SELECT g.id, g.guest_id, g.paid_at, (e.payload->>'toppedUpMnt')::bigint AS topped
      FROM gone_order g
      JOIN idesh.order_event e ON e.order_id = g.id AND e.type = 'PAID'
     WHERE g.paid_at IS NOT NULL
       AND COALESCE((e.payload->>'toppedUpMnt')::bigint, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM ledger.topup t WHERE t.for_subject = 'idesh' AND t.for_subject_id = g.id AND t.state = 'settled')
     ORDER BY g.paid_at
  LOOP
    INSERT INTO gone_topup
      SELECT t.id, t.transfer_id, t.provider, t.provider_ref
        FROM ledger.topup t
       WHERE t.guest_id = o.guest_id AND t.state = 'settled' AND t.for_subject IS NULL
         AND t.amount_mnt = o.topped
         AND t.settled_at BETWEEN o.paid_at - interval '2 hours' AND o.paid_at + interval '5 minutes'
         AND t.id NOT IN (SELECT id FROM gone_topup)
       ORDER BY abs(extract(epoch FROM (o.paid_at - t.settled_at)))
       LIMIT 1;
  END LOOP;

  -- Every transfer written for them, by each of the ways one is tied to an order.
  CREATE TEMP TABLE gone_transfer ON COMMIT DROP AS
    SELECT id FROM ledger.transfer WHERE subject = 'idesh' AND subject_id IN (SELECT id FROM gone_order)
    UNION SELECT ledger_transfer_id FROM gone_order WHERE ledger_transfer_id IS NOT NULL
    UNION SELECT ledger_accrual_id FROM gone_settlement WHERE ledger_accrual_id IS NOT NULL
    UNION SELECT ledger_payout_id FROM gone_settlement WHERE ledger_payout_id IS NOT NULL
    UNION SELECT transfer_id FROM gone_topup WHERE transfer_id IS NOT NULL
    UNION SELECT id FROM ledger.transfer WHERE subject = 'topup' AND subject_id IN (SELECT id FROM gone_topup);
  SELECT count(*) INTO n_transfers FROM gone_transfer;
  SELECT count(*) INTO n_topups FROM gone_topup;

  -- Receipts first, then the provider's side of each top-up, then the top-ups, then the money itself.
  DELETE FROM ledger.ebarimt_receipt
   WHERE transfer_id IN (SELECT id FROM gone_transfer)
      OR payment_id IN (
           SELECT p.id FROM ledger.payment p
            WHERE p.order_id IN (SELECT id FROM gone_order)
               OR EXISTS (SELECT 1 FROM gone_topup t WHERE p.provider = t.provider AND p.provider_ref = COALESCE(t.provider_ref, 'topup-' || t.id::text)));
  DELETE FROM ledger.payment p
   WHERE p.order_id IN (SELECT id FROM gone_order)
      OR EXISTS (SELECT 1 FROM gone_topup t WHERE p.provider = t.provider AND p.provider_ref = COALESCE(t.provider_ref, 'topup-' || t.id::text));
  DELETE FROM ledger.topup WHERE id IN (SELECT id FROM gone_topup);
  DELETE FROM ledger.entry WHERE transfer_id IN (SELECT id FROM gone_transfer);
  DELETE FROM ledger.transfer WHERE id IN (SELECT id FROM gone_transfer);

  -- What people were told about them, and the lock screen cards that followed them.
  DELETE FROM notify.message WHERE subject = 'idesh' AND subject_id IN (SELECT id FROM gone_order);
  GET DIAGNOSTICS n_messages = ROW_COUNT;
  DELETE FROM notify.activity_token WHERE subject = 'idesh' AND subject_id IN (SELECT id::text FROM gone_order);

  -- The desk's notes on them: a note about an order that is not there explains nothing.
  DELETE FROM idesh.audit
   WHERE (target_kind = 'order' AND target_id IN (SELECT id FROM gone_order))
      OR (target_kind = 'settlement' AND target_id IN (SELECT id FROM gone_settlement));

  -- Their animals go back on offer.
  UPDATE idesh.listing l
     SET sold = greatest(l.sold - back.qty, 0)
    FROM (SELECT listing_id, sum(qty)::int AS qty FROM gone_order WHERE holds GROUP BY listing_id) back
   WHERE l.id = back.listing_id;

  -- The orders themselves; their events and settlements go with them.
  DELETE FROM idesh.idesh_order WHERE id IN (SELECT id FROM gone_order);

  -- Taking a purchase away puts its price back in the wallet, and taking its top-up away takes it
  -- out again. A wallet left below nothing would mean a top-up was taken that paid for something
  -- still here: stop, and change nothing.
  SELECT count(*) INTO n_overdrawn
    FROM ledger.account a
   WHERE a.kind = 'guest' AND a.owner_id IN (SELECT guest_id FROM gone_order)
     AND (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e WHERE e.account_id = a.id) < 0;
  IF n_overdrawn > 0 THEN
    RAISE EXCEPTION '050: % wallets would be left below nothing — nothing removed', n_overdrawn;
  END IF;

  -- A wallet topped up on its own, not for one of these orders, was not theirs to take:
  -- what it spent on them is back in it. Counted, so the desk knows to look.
  SELECT count(*) INTO n_wallets
    FROM ledger.account a
   WHERE a.kind = 'guest' AND a.owner_id IN (SELECT guest_id FROM gone_order)
     AND (SELECT COALESCE(sum(e.amount_mnt), 0) FROM ledger.entry e WHERE e.account_id = a.id) <> 0;

  RAISE NOTICE '050: removed % orders (% on the list), % transfers, % top-ups, % messages; % of their wallets still hold a balance',
    n_orders, n_listed, n_transfers, n_topups, n_messages, n_wallets;
END
$$;
