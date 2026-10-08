import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../db/pool.js';
import { at } from '../../domain/fixtures.js';
import { VirtualClock } from '../../domain/time.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../../ports.js';
import { truncateAll } from '../../test/seed.js';
import { answerCall, callFor, endCall, registerRingToken, startCall, waitFor, callKey } from './index.js';

/**
 * The ring itself, below the API: who takes a call rung at several people,
 * and what is kept of it afterwards.
 */
const OFFER = 'v=0\r\no=- 1 2 IN IP4 192.168.1.20\r\ns=-\r\nt=0 0\r\n';
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 10.0.0.7\r\ns=-\r\nt=0 0\r\n';

let ctx: Ctx;
let notifier: FakeNotifier;
const guest = randomUUID();
const owner = randomUUID();
const cook = randomUUID();

const ringAll = (subjectId = randomUUID()) =>
  startCall(ctx, {
    subject: 'idesh',
    subjectId,
    about: 'Идэш №T1',
    callerId: guest,
    callees: [owner, cook, guest],
    callerName: 'Зочин',
    calleeName: 'Архангай · Дорж',
    offer: OFFER,
  });

beforeEach(async () => {
  await truncateAll();
  notifier = new FakeNotifier();
  ctx = { clock: new VirtualClock(at('11:40')), payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier };
});

afterAll(async () => {
  await closePool();
});

describe('a call rung at everybody at the supplier', () => {
  it('rings each of them but never the caller; the first to answer takes it', async () => {
    await registerRingToken(owner, 'voip', 'owner-phone', ctx.clock.now());
    await registerRingToken(cook, 'voip', 'cook-phone', ctx.clock.now());
    await registerRingToken(guest, 'voip', 'guest-phone', ctx.clock.now());
    const call = await ringAll();
    expect(call.callees.sort()).toEqual([owner, cook].sort());
    expect(notifier.rings.map((r) => r.token).sort()).toEqual(['cook-phone', 'owner-phone']);

    await answerCall(ctx, call.id, cook, ANSWER);
    await expect(answerCall(ctx, call.id, owner, ANSWER)).rejects.toMatchObject({ code: 'TAKEN' });
    // The owner, who did not pick up, hanging up changes nothing for the cook.
    expect((await endCall(ctx, call.id, owner)).state).toBe('answered');
    expect((await endCall(ctx, call.id, cook)).state).toBe('ended');
  });

  it('rings an Android phone through Firebase, as a call its app draws itself', async () => {
    await registerRingToken(owner, 'fcm', 'owner-android', ctx.clock.now());
    const call = await ringAll();
    expect(notifier.data).toEqual([
      {
        token: 'owner-android',
        ttlSeconds: 45,
        data: { type: 'call', call_id: call.id, caller_name: 'Зочин', about: 'Идэш №T1', subject: 'idesh', subject_id: call.subjectId },
      },
    ]);
    expect(notifier.rings).toHaveLength(0);
  });

  it('forgets where the phones were once it is over', async () => {
    const call = await ringAll();
    await answerCall(ctx, call.id, owner, ANSWER);
    await endCall(ctx, call.id, guest);
    const { rows } = await getPool().query('SELECT offer, answer FROM call.call WHERE id = $1', [call.id]);
    expect(rows[0]).toEqual({ offer: null, answer: null });
    // Hanging up twice is hanging up once.
    expect((await endCall(ctx, call.id, guest)).version).toBe((await callFor(call.id, guest))!.version);
  });

  it('forgets a phone APNs says is gone, and still rings the rest', async () => {
    await registerRingToken(owner, 'voip', 'dead-phone', ctx.clock.now());
    await registerRingToken(cook, 'voip', 'cook-phone', ctx.clock.now());
    notifier.deadTokens.add('dead-phone');
    await ringAll();
    expect(notifier.rings.map((r) => r.token)).toEqual(['cook-phone']);
    const { rows } = await getPool().query('SELECT token FROM call.ring_token ORDER BY token');
    expect(rows.map((r) => r.token)).toEqual(['cook-phone']);
  });

  it('wakes whoever is waiting on it the moment it moves', async () => {
    const call = await ringAll();
    let woken = false;
    const waiting = waitFor([callKey(call.id)], 5_000).then(() => (woken = true));
    expect(woken).toBe(false);
    await answerCall(ctx, call.id, owner, ANSWER);
    await waiting;
    expect(woken).toBe(true);
  });
});
