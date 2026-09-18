import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { IdeshError, listSuppliers, recordAudit } from '../idesh/index.js';
import { contactsFor, displayNamesFor } from '../platform/identity/index.js';
import {
  accountsForDesk,
  processReceipts,
  receiptsForDesk,
  reconcile,
  reconcileLedger,
  reconciliationForDesk,
  retryReceipt,
  topupsForDesk,
  transfersForDesk,
  type DeskTransfer,
} from '../platform/ledger/index.js';
import type { Ctx } from '../ports.js';
import { sendError } from './errors.js';

/**
 * The money side of the desk.
 *
 * Finance reads the books by account and by movement, sees what QPay has
 * and has not confirmed, what the tax authority has and has not issued,
 * exports any of it as CSV for the accountant, and runs the checks. The
 * ledger itself is never edited from here: a mistake is corrected by a
 * new movement, made by the code that owns the mistake.
 */

export interface MoneyGuards {
  asOps: RouteShorthandOptions;
  asFinance: RouteShorthandOptions;
  who: (request: FastifyRequest) => string;
}

/** The whole ledger, as a target: there is one. */
const LEDGER_ID = '00000000-0000-0000-0000-000000000000';

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** `payable:supplier:<id>` reads as the supplier's name; `guest:<id>` as the person's. */
async function namesFor(labels: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const guestIds = new Set<string>();
  const supplierIds = new Set<string>();
  for (const label of labels) {
    const guest = /^(?:payable:)?guest:([0-9a-f-]{36})$/.exec(label);
    const supplier = /^payable:supplier:([0-9a-f-]{36})$/.exec(label);
    if (guest) guestIds.add(guest[1]!);
    if (supplier) supplierIds.add(supplier[1]!);
  }
  const [names, contacts, suppliers] = await Promise.all([
    displayNamesFor([...guestIds]),
    contactsFor([...guestIds]),
    supplierIds.size ? listSuppliers() : Promise.resolve([]),
  ]);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const WORD: Record<string, string> = {
    'house:revenue': 'Basu · орлого',
    'house:promotions': 'Basu · урамшуулал',
    'qpay:clearing': 'QPay · клиринг',
    'bank:out': 'Банк · гадагш',
  };
  for (const label of labels) {
    const guest = /^(?:payable:)?guest:([0-9a-f-]{36})$/.exec(label);
    const supplier = /^payable:supplier:([0-9a-f-]{36})$/.exec(label);
    if (guest) {
      const id = guest[1]!;
      const person = `${names.get(id) ?? 'зочин'}${contacts.get(id)?.phone ? ` · ${contacts.get(id)!.phone}` : ''}`;
      out.set(label, label.startsWith('payable:') ? `Буцаалт · ${person}` : person);
    } else if (supplier) {
      out.set(label, `Олголт · ${supplierName.get(supplier[1]!) ?? 'нийлүүлэгч'}`);
    } else {
      out.set(label, WORD[label] ?? label);
    }
  }
  return out;
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: string[], rows: unknown[][]): string => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const sendCsv = (reply: FastifyReply, name: string, body: string) =>
  reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send('﻿' + body);

const shapeTransfer = (t: DeskTransfer, names: Map<string, string>) => ({
  id: t.id,
  kind: t.kind,
  amount_mnt: t.amountMnt,
  subject: t.subject,
  subject_id: t.subjectId,
  memo: t.memo,
  from: { label: t.from, name: names.get(t.from) ?? t.from },
  to: { label: t.to, name: names.get(t.to) ?? t.to },
  at: t.at.toISOString(),
});

type TransferQuery = { kind?: string; from?: string; to?: string; guest?: string; limit?: string };
type TopupQuery = { state?: string; from?: string; to?: string; limit?: string };

export function registerMoneyDesk(app: FastifyInstance, ctx: Ctx, { asOps, asFinance, who }: MoneyGuards): void {
  /** The books at a glance: the checks, and every named account. */
  app.get('/v1/ops/money', asOps, async () => {
    const [checks, accounts] = await Promise.all([reconciliationForDesk(ctx.clock.now()), accountsForDesk()]);
    const names = await namesFor(accounts.named.map((a) => a.label ?? ''));
    return {
      checks: {
        drift: checks.drift,
        accounts: checks.accounts,
        qpay: { settled_mnt: checks.qpay.settledMnt, clearing_mnt: checks.qpay.clearingMnt, gap_mnt: checks.qpay.gapMnt, pending: checks.qpay.pending, stuck: checks.qpay.stuck },
        bank: { out_mnt: checks.bank.outMnt },
        wallets: { liability_mnt: checks.wallets.liabilityMnt, payable_mnt: checks.wallets.payableMnt },
        receipts: checks.receipts,
      },
      wallets: { count: accounts.wallets.count, holding: accounts.wallets.holding, balance_mnt: accounts.wallets.balanceMnt },
      accounts: accounts.named.map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        name: names.get(a.label ?? '') ?? a.label,
        balance_mnt: a.balanceMnt,
        entries: a.entries,
        last_at: iso(a.lastAt),
      })),
    };
  });

  const transferFilter = (q: TransferQuery, limit?: number) => ({
    kind: q.kind || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    guestId: q.guest || undefined,
    limit: limit ?? (Number(q.limit) || undefined),
  });

  app.get<{ Querystring: TransferQuery }>('/v1/ops/money/transfers', asOps, async (request) => {
    const transfers = await transfersForDesk(transferFilter(request.query));
    const names = await namesFor(transfers.flatMap((t) => [t.from, t.to]));
    return { transfers: transfers.map((t) => shapeTransfer(t, names)) };
  });

  /** For the accountant: every movement in the window, one line each. */
  app.get<{ Querystring: TransferQuery }>('/v1/ops/money/transfers.csv', asFinance, async (request, reply) => {
    const transfers = await transfersForDesk(transferFilter(request.query, 5000));
    const names = await namesFor(transfers.flatMap((t) => [t.from, t.to]));
    await recordAudit({ who: who(request), action: 'ledger.export', targetKind: 'ledger', targetId: LEDGER_ID, note: `transfers ${request.query.from ?? ''}..${request.query.to ?? ''} (${transfers.length})` });
    return sendCsv(
      reply,
      `basu-transfers-${request.query.from ?? 'all'}-${request.query.to ?? 'all'}.csv`,
      csv(
        ['at', 'kind', 'amount_mnt', 'from', 'to', 'subject', 'subject_id', 'memo', 'transfer_id'],
        transfers.map((t) => [t.at.toISOString(), t.kind, t.amountMnt, names.get(t.from) ?? t.from, names.get(t.to) ?? t.to, t.subject, t.subjectId, t.memo, t.id]),
      ),
    );
  });

  const topupFilter = (q: TopupQuery, limit?: number) => ({ state: q.state || undefined, from: q.from || undefined, to: q.to || undefined, limit: limit ?? (Number(q.limit) || undefined) });

  app.get<{ Querystring: TopupQuery }>('/v1/ops/money/topups', asOps, async (request) => {
    const topups = await topupsForDesk(topupFilter(request.query));
    const ids = topups.map((t) => t.guestId);
    const [names, contacts] = await Promise.all([displayNamesFor(ids), contactsFor(ids)]);
    return {
      topups: topups.map((t) => ({
        id: t.id,
        guest_id: t.guestId,
        guest: names.get(t.guestId) ?? null,
        guest_phone: contacts.get(t.guestId)?.phone ?? null,
        amount_mnt: t.amountMnt,
        provider: t.provider,
        provider_ref: t.providerRef,
        state: t.state,
        created_at: t.createdAt.toISOString(),
        settled_at: iso(t.settledAt),
      })),
    };
  });

  /** For the QPay statement: what we think they sent, to hold against what they say. */
  app.get<{ Querystring: TopupQuery }>('/v1/ops/money/topups.csv', asFinance, async (request, reply) => {
    const topups = await topupsForDesk(topupFilter(request.query, 5000));
    const contacts = await contactsFor(topups.map((t) => t.guestId));
    await recordAudit({ who: who(request), action: 'ledger.export', targetKind: 'ledger', targetId: LEDGER_ID, note: `topups ${request.query.from ?? ''}..${request.query.to ?? ''} (${topups.length})` });
    return sendCsv(
      reply,
      `basu-topups-${request.query.from ?? 'all'}-${request.query.to ?? 'all'}.csv`,
      csv(
        ['created_at', 'settled_at', 'state', 'provider', 'provider_ref', 'amount_mnt', 'guest_phone', 'topup_id'],
        topups.map((t) => [t.createdAt.toISOString(), iso(t.settledAt), t.state, t.provider, t.providerRef, t.amountMnt, contacts.get(t.guestId)?.phone ?? '', t.id]),
      ),
    );
  });

  app.get<{ Querystring: { state?: string } }>('/v1/ops/money/receipts', asOps, async (request) => ({
    receipts: (await receiptsForDesk(request.query.state || undefined)).map((r) => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      order_code: r.orderCode,
      merchant_tin: r.merchantTin,
      amount_mnt: r.amountMnt,
      attempts: r.attempts,
      last_error: r.lastError,
      bill_id: r.billId,
      lottery: r.lottery,
      issued_at: iso(r.issuedAt),
      created_at: r.createdAt.toISOString(),
    })),
  }));

  app.post<{ Params: { id: string } }>('/v1/ops/money/receipts/:id/retry', asFinance, async (request, reply) => {
    if (!(await retryReceipt(request.params.id))) return sendError(reply, new IdeshError('NOT_FOUND', 'no failed receipt under that id'));
    await recordAudit({ who: who(request), action: 'receipt.retry', targetKind: 'receipt', targetId: request.params.id });
    return reply.send({ id: request.params.id, state: 'queued' });
  });

  /** Run the checks now rather than at 23:30, and push the receipt queue while at it. */
  app.post('/v1/ops/money/checks', asFinance, async (request) => {
    const [ledger, receipts, pushed] = await Promise.all([reconcileLedger(), reconcile(), processReceipts(ctx)]);
    await recordAudit({
      who: who(request),
      action: 'ledger.checks',
      targetKind: 'ledger',
      targetId: LEDGER_ID,
      note: `drift ${ledger.drift} · receipts gap ${receipts.gap} · issued ${pushed.issued}, failed ${pushed.failed}`,
    });
    return { ledger, receipts, pushed };
  });
}
