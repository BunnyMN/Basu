import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { createListing, registerSupplier, type Listing } from '../idesh/index.js';
import { setSetting } from '../ops/index.js';
import { iceServersFor } from '../platform/call/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { truncateAll } from '../test/seed.js';
import { buildServer } from './server.js';

/**
 * A guest and a supplier ringing each other about an order, driven the way
 * the two screens drive it.
 *
 * What matters most is who may ring whom: a call is a phone ringing in
 * somebody's pocket, and a stranger who can make it ring — or read whose
 * order it was — is worse than no calls at all.
 */
let app: FastifyInstance;
let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;
let supplierId: string;
let sheep: Listing;

const PASSWORD = 'туршилтын нууц үг';
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signIn(phone: string): Promise<{ token: string; guestId: string }> {
  const made = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone, password: PASSWORD } });
  if (made.statusCode === 201) return { token: made.json().token, guestId: made.json().guest_id };
  const back = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { phone, password: PASSWORD } });
  expect(back.statusCode, back.body).toBe(200);
  return { token: back.json().token, guestId: back.json().guest_id };
}

async function paidOrder(token: string): Promise<string> {
  const started = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: auth(token), payload: { amount_mnt: 500_000 } });
  await app.inject({ method: 'POST', url: `/v1/wallet/topup/${started.json().topup_id}/settle`, headers: auth(token) });
  const created = await app.inject({
    method: 'POST',
    url: '/v1/idesh',
    headers: auth(token),
    payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const paid = await app.inject({ method: 'POST', url: `/v1/idesh/${created.json().id}/pay`, headers: auth(token) });
  expect(paid.statusCode, paid.body).toBe(200);
  return created.json().id as string;
}

const ring = (token: string, orderId: string, offer: string = OFFER) =>
  app.inject({ method: 'POST', url: '/v1/calls', headers: auth(token), payload: { subject: 'idesh', subject_id: orderId, offer } });

/** The missed-call messages in this person's inbox, as the inbox screen reads them. */
async function missedCalls(token: string): Promise<Array<{ title: string; body: string; subject: string; subject_id: string }>> {
  const inbox = await app.inject({ method: 'GET', url: '/v1/notifications', headers: auth(token) });
  expect(inbox.statusCode, inbox.body).toBe(200);
  return inbox.json().messages.filter((m: { template: string }) => m.template === 'call.missed');
}

let guest: { token: string; guestId: string };
let owner: { token: string; guestId: string };

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  notifier = new FakeNotifier();
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier };
  app = await buildServer(ctx, { dev: true });
  owner = await signIn('+97688010001');
  supplierId = await registerSupplier({
    ownerId: owner.guestId,
    name: 'Архангай · Дорж',
    phone: '+97688010001',
    merchantTin: '6501234567',
    pickupAddress: 'Нарантуул, хойд хаалга',
  });
  sheep = await createListing(
    supplierId,
    {
      kind: 'sheep',
      unit: 'whole',
      title: 'Хонь, залуу ирэг',
      priceMnt: 460_000,
      approxKg: 38,
      quantity: 5,
      origin: 'Архангай, Их тамир',
      readyFrom: '2026-09-10',
      delivers: true,
      deliveryFeeMnt: 25_000,
    },
    clock.now(),
  );
  guest = await signIn('+97699001122');
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe('closed until Basu opens it', () => {
  it('offers no button and refuses a ring while calls_open is 0', async () => {
    const order = await paidOrder(guest.token);
    const can = await app.inject({ method: 'GET', url: `/v1/calls/can?subject=idesh&subject_id=${order}`, headers: auth(guest.token) });
    expect(can.json()).toEqual({ can_call: false, peer_name: 'Архангай · Дорж' });
    const refused = await ring(guest.token, order);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('CLOSED');
  });
});

describe('a guest ringing the supplier', () => {
  beforeEach(async () => {
    await setSetting('calls_open', 1, 'test');
  });

  it('rings the supplier’s phone, hands over the offer, and brings the answer back', async () => {
    const order = await paidOrder(guest.token);
    const token = await app.inject({ method: 'POST', url: '/v1/calls/tokens', headers: auth(owner.token), payload: { kind: 'voip', token: 'owner-voip' } });
    expect(token.statusCode).toBe(200);

    const can = await app.inject({ method: 'GET', url: `/v1/calls/can?subject=idesh&subject_id=${order}`, headers: auth(guest.token) });
    expect(can.json()).toEqual({ can_call: true, peer_name: 'Архангай · Дорж' });

    const started = await ring(guest.token, order);
    expect(started.statusCode, started.body).toBe(201);
    const call = started.json();
    expect(call).toMatchObject({ state: 'ringing', role: 'caller', peer_name: 'Архангай · Дорж', offer: null, answer: null });
    expect(call.about).toMatch(/^Идэш №/);

    // The supplier's phone is woken, with what the incoming-call screen shows.
    expect(notifier.rings).toHaveLength(1);
    expect(notifier.rings[0]!.token).toBe('owner-voip');
    expect(notifier.rings[0]!.payload).toMatchObject({ call_id: call.id, about: call.about, subject: 'idesh', subject_id: order });

    // An open screen at the supplier sees it ringing, offer and all.
    const ringing = await app.inject({ method: 'GET', url: '/v1/calls/ringing?wait=0', headers: auth(owner.token) });
    expect(ringing.json().calls).toHaveLength(1);
    expect(ringing.json().calls[0]).toMatchObject({ id: call.id, role: 'callee', offer: OFFER });

    // The caller waits for the answer; it comes the moment there is one.
    const waiting = app.inject({ method: 'GET', url: `/v1/calls/${call.id}?after=${call.version}&wait=5`, headers: auth(guest.token) });
    const answered = await app.inject({ method: 'POST', url: `/v1/calls/${call.id}/answer`, headers: auth(owner.token), payload: { answer: ANSWER } });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toMatchObject({ state: 'answered', answered_here: true, offer: null });
    const heard = (await waiting).json();
    expect(heard).toMatchObject({ state: 'answered', answer: ANSWER });

    // Either side hangs up; the description of where the phones were is forgotten.
    const ended = await app.inject({ method: 'POST', url: `/v1/calls/${call.id}/end`, headers: auth(owner.token) });
    expect(ended.json()).toMatchObject({ state: 'ended', end_reason: 'hangup', answer: null });
    const seen = await app.inject({ method: 'GET', url: `/v1/calls/${call.id}?wait=0`, headers: auth(guest.token) });
    expect(seen.json()).toMatchObject({ state: 'ended', answer: null, offer: null });
  });

  it('lets nobody else ring about the order, or read the call', async () => {
    const order = await paidOrder(guest.token);
    const stranger = await signIn('+97699009988');
    expect((await ring(stranger.token, order)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/calls/can?subject=idesh&subject_id=${order}`, headers: auth(stranger.token) })).statusCode).toBe(404);

    const call = (await ring(guest.token, order)).json();
    expect((await app.inject({ method: 'GET', url: `/v1/calls/${call.id}?wait=0`, headers: auth(stranger.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/calls/${call.id}/answer`, headers: auth(stranger.token), payload: { answer: ANSWER } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/calls/${call.id}/end`, headers: auth(stranger.token) })).statusCode).toBe(404);
    // The caller cannot answer their own ring.
    expect((await app.inject({ method: 'POST', url: `/v1/calls/${call.id}/answer`, headers: auth(guest.token), payload: { answer: ANSWER } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/calls/not-an-id', headers: auth(guest.token) })).statusCode).toBe(404);
  });

  it('is not for an order that is not paid, or long handed over', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/idesh',
      headers: auth(guest.token),
      payload: { listing_id: sheep.id, qty: 1, receive: 'pickup', receive_on: '2026-09-12' },
    });
    const draft = created.json().id as string;
    expect((await ring(guest.token, draft)).json().error.code).toBe('OUT_OF_WINDOW');

    const order = await paidOrder(guest.token);
    for (const step of ['prepare', 'ready', 'hand']) {
      const moved = await app.inject({ method: 'POST', url: `/v1/supplier/orders/${order}/${step}`, headers: auth(owner.token), payload: {} });
      expect(moved.statusCode, moved.body).toBe(200);
    }
    // Two days after the handover there is still somebody to ask about the meat…
    clock.advanceMinutes(2 * 24 * 60);
    const asked = await ring(guest.token, order);
    expect(asked.statusCode, asked.body).toBe(201);
    await app.inject({ method: 'POST', url: `/v1/calls/${asked.json().id}/end`, headers: auth(guest.token) });
    // …four days after, there is not.
    clock.advanceMinutes(2 * 24 * 60);
    expect((await ring(guest.token, order)).json().error.code).toBe('OUT_OF_WINDOW');
  });

  it('refuses something that is not a session description', async () => {
    const order = await paidOrder(guest.token);
    expect((await ring(guest.token, order, 'hello')).statusCode).toBe(400);
    expect((await ring(guest.token, order, `v=0${'x'.repeat(30_000)}`)).statusCode).toBe(400);
  });
});

describe('the supplier ringing the guest', () => {
  beforeEach(async () => {
    await setSetting('calls_open', 1, 'test');
  });

  it('rings the guest, under the business’s name; a second ring meets the first', async () => {
    const order = await paidOrder(guest.token);
    const started = await ring(owner.token, order);
    expect(started.statusCode, started.body).toBe(201);
    expect(started.json().peer_name).not.toBe('Архангай · Дорж');

    const ringing = (await app.inject({ method: 'GET', url: '/v1/calls/ringing?wait=0', headers: auth(guest.token) })).json().calls;
    expect(ringing[0]).toMatchObject({ role: 'callee', peer_name: 'Архангай · Дорж' });

    // The guest rings back at the same moment: told there is a call, and which.
    const both = await ring(guest.token, order);
    expect(both.statusCode).toBe(409);
    expect(both.json()).toMatchObject({ error: { code: 'IN_PROGRESS' }, call_id: started.json().id });
  });
});

describe('a ring that is not picked up', () => {
  beforeEach(async () => {
    await setSetting('calls_open', 1, 'test');
  });

  it('is missed after 45 seconds and stays in the inbox to ring back', async () => {
    const order = await paidOrder(guest.token);
    const call = (await ring(guest.token, order)).json();
    clock.advanceSeconds(46);
    const after = await app.inject({ method: 'GET', url: `/v1/calls/${call.id}?wait=0`, headers: auth(guest.token) });
    expect(after.json()).toMatchObject({ state: 'missed', end_reason: 'no_answer' });
    const missed = await missedCalls(owner.token);
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ title: 'Аваагүй дуудлага', subject: 'idesh', subject_id: order });
    expect(missed[0]!.body).toContain(call.about);
    expect(await missedCalls(guest.token)).toHaveLength(0);
    // Too late to pick up now.
    const late = await app.inject({ method: 'POST', url: `/v1/calls/${call.id}/answer`, headers: auth(owner.token), payload: { answer: ANSWER } });
    expect(late.json().error.code).toBe('OVER');
  });

  it('is cancelled by a caller who hangs up — still a missed call — and declined by the person rung', async () => {
    const order = await paidOrder(guest.token);
    const first = (await ring(guest.token, order)).json();
    const cancelled = await app.inject({ method: 'POST', url: `/v1/calls/${first.id}/end`, headers: auth(guest.token) });
    expect(cancelled.json().state).toBe('cancelled');
    expect(await missedCalls(owner.token)).toHaveLength(1);

    const second = (await ring(guest.token, order)).json();
    const declined = await app.inject({ method: 'POST', url: `/v1/calls/${second.id}/end`, headers: auth(owner.token) });
    expect(declined.json().state).toBe('declined');
    // Saying no is not missing it.
    expect(await missedCalls(owner.token)).toHaveLength(1);
    const caller = await app.inject({ method: 'GET', url: `/v1/calls/${second.id}?wait=0`, headers: auth(guest.token) });
    expect(caller.json()).toMatchObject({ state: 'declined', end_reason: 'declined' });
  });
});

describe('the way through', () => {
  it('is a public STUN server until there is a relay of ours', () => {
    expect(iceServersFor('g', new Date(), {}).iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('gives coturn a password it can check without a list: the expiry and its HMAC', async () => {
    const now = new Date('2026-10-07T05:00:00Z');
    const { iceServers, ttlS } = iceServersFor('0b8f2c6e-1111-2222-3333-444455556666', now, { TURN_SECRET: 's3cret', TURN_HOST: 'basu.burzai.cloud' });
    const relay = iceServers[1]!;
    expect(relay.urls).toEqual([
      'turn:basu.burzai.cloud:3478?transport=udp',
      'turn:basu.burzai.cloud:3478?transport=tcp',
      'turns:basu.burzai.cloud:5349?transport=tcp',
    ]);
    expect(relay.username).toBe(`${Math.floor(now.getTime() / 1000) + ttlS}:0b8f2c6e`);
    expect(relay.credential).toBe(createHmac('sha1', 's3cret').update(relay.username!).digest('base64'));

    const asked = await app.inject({ method: 'GET', url: '/v1/calls/ice', headers: auth(guest.token) });
    expect(asked.statusCode).toBe(200);
    expect(asked.json().ice_servers.length).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/v1/calls/ice' })).statusCode).toBe(401);
  });
});
