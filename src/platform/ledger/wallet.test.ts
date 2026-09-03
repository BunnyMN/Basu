import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../db/pool.js';
import { at } from '../../domain/fixtures.js';
import { VirtualClock } from '../../domain/time.js';
import {
  FakeNotifier,
  FakePaymentProvider,
  FakeTaxProvider,
  type Ctx,
  type PaymentProvider,
} from '../../ports.js';
import { seedGuest, truncateAll } from '../../test/seed.js';
import { balance, collect, LedgerError, reconcileLedger, refund, settleTopup, startTopup, wallet } from './index.js';

/**
 * The ledger under pressure.
 *
 * The arithmetic is easy and is proven everywhere else. What is worth a test is
 * the part that only goes wrong when two things happen at once — a guest with
 * 20 000 ₮ and two requests in flight, a callback delivered twice, a crash
 * between the two halves of a movement. Those failures are silent, they are
 * about money, and none of them show up in a walkthrough.
 */

let clock: VirtualClock;
let payments: FakePaymentProvider;
let ctx: Ctx;
let guestId: string;

const pool = () => getPool();

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  payments = new FakePaymentProvider();
  ctx = { clock, payments, tax: new FakeTaxProvider(), notifier: new FakeNotifier() };
  guestId = await seedGuest();
});

afterAll(async () => {
  await closePool();
});

/** Money in the wallet, the way the phone puts it there. */
async function fund(amountMnt: number): Promise<void> {
  const topup = await startTopup(ctx, { guestId, amountMnt });
  await settleTopup(ctx, topup.topupId);
}

describe('two requests at once', () => {
  it('lets exactly one through when the card cannot cover the rest', async () => {
    await fund(20_000);

    // With the provider dead, `collect` has no shortfall to fall back on, so
    // every interleaving has the same answer: one order is paid for out of the
    // balance and the other four are refused. Without the lock on the account
    // row two of them both read 20 000 ₮, both spend it, and the wallet ends
    // the day owing money it never had.
    const broke: Ctx = { ...ctx, payments: new DeadProvider() };
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, n) =>
        collect(broke, {
          guestId,
          amountMnt: 20_000,
          subject: 'order',
          subjectId: crypto.randomUUID(),
          idempotencyKey: `dead:${n}`,
        }),
      ),
    );

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    for (const attempt of attempts.filter((a) => a.status === 'rejected')) {
      expect((attempt as PromiseRejectedResult).reason).toBeInstanceOf(LedgerError);
    }
    expect(await balance(guestId)).toBe(0);
    expect(await reconcileLedger()).toMatchObject({ drift: 0 });
  });

  it('never spends the balance twice, whichever way the requests interleave', async () => {
    await fund(20_000);

    // The provider works this time, so what happens depends on how the reads
    // and the writes fall against each other: a request that reads the balance
    // before anybody spends it will try to pay out of the wallet, and one that
    // reads it afterwards will top up the shortfall instead. Both are correct.
    //
    // So the assertion is the invariant rather than a count. However the five
    // land, the wallet can only ever have paid out the 20 000 ₮ it held.
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, n) =>
        collect(ctx, {
          guestId,
          amountMnt: 20_000,
          subject: 'order',
          subjectId: crypto.randomUUID(),
          idempotencyKey: `race:${n}`,
        }),
      ),
    );

    const paid = attempts.flatMap((a) => (a.status === 'fulfilled' ? [a.value] : []));
    const refused = attempts.flatMap((a) => (a.status === 'rejected' ? [a.reason] : []));

    expect(paid.length).toBeGreaterThan(0);
    for (const reason of refused) {
      // A refusal is allowed; a refusal for any other reason is a bug.
      expect(reason).toBeInstanceOf(LedgerError);
      expect((reason as LedgerError).code).toBe('INSUFFICIENT_FUNDS');
    }

    const fromWallet = paid.reduce((sum, r) => sum + r.fromWalletMnt, 0);
    expect(fromWallet, 'the wallet may only ever spend what it held').toBeLessThanOrEqual(20_000);
    expect(await balance(guestId)).toBeGreaterThanOrEqual(0);
    expect(await reconcileLedger()).toMatchObject({ drift: 0 });
  });

  it('charges once when the same intention arrives five times', async () => {
    await fund(100_000);

    // A double-tapped Pay button, a retried request and a redelivered webhook
    // all carry the same key. They must collapse onto one movement — not
    // "usually", and not "unless they land in the same millisecond".
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        collect(ctx, {
          guestId,
          amountMnt: 18_500,
          subject: 'order',
          subjectId: '9d3f2a1c-0000-4000-8000-00000000abcd',
          idempotencyKey: 'order:once:purchase',
        }),
      ),
    );

    const ids = new Set(results.map((r) => r.transferId));
    expect(ids.size, 'every caller should be handed the same movement').toBe(1);
    expect(await balance(guestId)).toBe(100_000 - 18_500);
    expect(await reconcileLedger()).toMatchObject({ drift: 0 });
  });
});

describe('what the schema refuses', () => {
  it('will not accept a movement with one side', async () => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO ledger.transfer (kind, amount_mnt, idempotency_key)
       VALUES ('adjustment', 5000, 'one-sided') RETURNING id`,
    );
    const account = await guestAccount();

    // The deferred trigger fires at COMMIT, so this is not caught by the
    // INSERT — it is caught by the transaction refusing to finish, which is
    // exactly where a service that crashed between two writes would be stopped.
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO ledger.entry (transfer_id, account_id, amount_mnt) VALUES ($1, $2, -5000)',
        [rows[0]!.id, account],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    expect(await balance(guestId)).toBe(0);
  });

  it('keeps every tugrik somewhere, over a day of movement', async () => {
    await fund(50_000);
    await collect(ctx, {
      guestId,
      amountMnt: 18_500,
      subject: 'order',
      subjectId: '11111111-0000-4000-8000-000000000001',
      idempotencyKey: 'day:1',
    });
    await refund({
      guestId,
      amountMnt: 18_500,
      subject: 'order',
      subjectId: '11111111-0000-4000-8000-000000000001',
      memo: 'цуцалсан',
      idempotencyKey: 'day:1:refund',
    });
    // Spending more than is held pulls the shortfall from the provider rather
    // than refusing — the guest is asked for the difference, not the bill.
    await collect(ctx, {
      guestId,
      amountMnt: 64_000,
      subject: 'order',
      subjectId: '11111111-0000-4000-8000-000000000002',
      idempotencyKey: 'day:2',
    });

    expect(await balance(guestId)).toBe(50_000 - 64_000 + 14_000);
    expect(await reconcileLedger()).toMatchObject({ drift: 0 });

    const statement = await wallet(guestId);
    expect(statement.balanceMnt).toBe(0);
    // Newest first, and the refund nets against the purchase it reverses.
    expect(statement.lines.map((l) => l.kind)).toEqual([
      'purchase',
      'topup',
      'refund',
      'purchase',
      'topup',
    ]);
    expect(statement.lines.reduce((sum, l) => sum + l.amountMnt, 0)).toBe(0);
  });
});

describe('when the provider is having a bad day', () => {
  it('leaves no balance behind when a top-up never settles', async () => {
    const started = await startTopup(ctx, { guestId, amountMnt: 30_000 });

    // Asking is not paying. Nothing may be credited until the money lands,
    // or anyone who can start a top-up can mint balance by never paying.
    expect(await balance(guestId)).toBe(0);

    payments.failNext = true;
    await expect(settleTopup(ctx, started.topupId)).rejects.toBeInstanceOf(LedgerError);

    expect(await balance(guestId)).toBe(0);
    const { rows } = await pool().query<{ state: string }>(
      'SELECT state FROM ledger.topup WHERE id = $1',
      [started.topupId],
    );
    expect(rows[0]!.state).toBe('failed');
    expect(await reconcileLedger()).toMatchObject({ drift: 0 });
  });

  it('does not take the money when the shortfall cannot be collected', async () => {
    await fund(5_000);
    payments.failNext = true;

    await expect(
      collect(ctx, {
        guestId,
        amountMnt: 20_000,
        subject: 'order',
        subjectId: '22222222-0000-4000-8000-000000000001',
        idempotencyKey: 'shortfall:fails',
      }),
    ).rejects.toBeInstanceOf(LedgerError);

    // The wallet is untouched: a failed card must not quietly become a
    // partial payment the guest has to notice on their own.
    expect(await balance(guestId)).toBe(5_000);
    expect(await reconcileLedger()).toMatchObject({ drift: 0 });
  });
});

/** A provider that is having the worst possible day. */
class DeadProvider implements PaymentProvider {
  readonly name = 'qpay' as const;
  async authorize(): Promise<never> {
    throw new Error('payment provider unavailable');
  }
  async capture(): Promise<never> {
    throw new Error('payment provider unavailable');
  }
  async refund(): Promise<never> {
    throw new Error('payment provider unavailable');
  }
}


async function guestAccount(): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO ledger.account (kind, owner_id) VALUES ('guest', $1)
     ON CONFLICT (kind, owner_id, currency) WHERE owner_id IS NOT NULL
     DO UPDATE SET owner_id = EXCLUDED.owner_id
     RETURNING id`,
    [guestId],
  );
  return rows[0]!.id;
}
