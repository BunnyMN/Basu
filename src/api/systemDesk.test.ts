import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { at } from '../domain/fixtures.js';
import { VirtualClock } from '../domain/time.js';
import { buildServer } from './server.js';
import { opsToken } from './ops.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { failMessage, truncateAll } from '../test/seed.js';
import { enqueue } from '../platform/notify/index.js';

/** What we told people and whether the machine is well, over HTTP. */

let app: FastifyInstance;
let clock: VirtualClock;
let notifier: FakeNotifier;
let ctx: Ctx;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const desk = () => auth(opsToken()!);

/** A signed-in guest with one message queued for them, the way a vertical would. */
async function aTold(): Promise<void> {
  const token = await signIn('+97699004009');
  const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) })).json();
  await enqueue(ctx, { guestId: me.id, template: 'welcome', body: 'Basu-д тавтай морил.', channel: 'sms' });
}

async function signIn(phone: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/v1/auth/otp', payload: { phone } });
  const code = /(\d{6})/.exec(notifier.of('auth.otp').at(-1)?.body ?? '')?.[1];
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone, code } });
  expect(verified.statusCode).toBe(200);
  return verified.json().token as string;
}

beforeEach(async () => {
  await truncateAll();
  clock = new VirtualClock(at('11:40'));
  notifier = new FakeNotifier();
  ctx = { clock, payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier };
  process.env['OPS_TOKEN'] = 'ops-secret-for-the-test';
  app = await buildServer(ctx, { dev: true });
});

afterEach(() => {
  delete process.env['OPS_TOKEN'];
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

describe('what we told people', () => {
  it('logs every message with who it was for, finds them by phone, and puts a failed one back', async () => {
    await aTold();
    await app.inject({ method: 'POST', url: '/dev/tick' });
    const all = (await app.inject({ method: 'GET', url: '/v1/ops/notify/messages', headers: desk() })).json().messages;
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]).toMatchObject({ guest_phone: '+97699004009', channel: expect.any(String), state: expect.any(String) });
    expect((await app.inject({ method: 'GET', url: '/v1/ops/notify/messages?q=9900 4009', headers: desk() })).json().messages).toHaveLength(all.length);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/notify/messages?q=1234', headers: desk() })).json().messages).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/ops/notify/messages?state=failed', headers: desk() })).json().messages).toEqual([]);

    await failMessage(all[0].id);
    const failed = (await app.inject({ method: 'GET', url: '/v1/ops/notify/messages?state=failed', headers: desk() })).json().messages;
    expect(failed.map((m: { id: string }) => m.id)).toEqual([all[0].id]);
    const back = await app.inject({ method: 'POST', url: `/v1/ops/notify/messages/${all[0].id}/retry`, headers: desk(), payload: {} });
    expect(back.json()).toEqual({ id: all[0].id, state: 'queued' });
    expect((await app.inject({ method: 'POST', url: `/v1/ops/notify/messages/${all[0].id}/retry`, headers: desk(), payload: {} })).statusCode).toBe(404);
    // The next pass of the relay sends it.
    await app.inject({ method: 'POST', url: '/dev/tick' });
    expect((await app.inject({ method: 'GET', url: '/v1/ops/notify/messages?state=queued', headers: desk() })).json().messages).toEqual([]);

    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit[0]).toMatchObject({ action: 'message.retry', target_kind: 'message', target_id: all[0].id });
  });

  it('prices the month by the desk’s own unit costs', async () => {
    await aTold();
    await app.inject({ method: 'POST', url: '/dev/tick' });
    const free = (await app.inject({ method: 'GET', url: '/v1/ops/notify/volume', headers: desk() })).json();
    expect(free.unit).toEqual({ sms_mnt: 0, push_mnt: 0 });
    expect(free.months).toHaveLength(1);
    expect(free.months[0].sms.sent).toBeGreaterThan(0);
    expect(free.months[0].cost_mnt).toBe(0);

    const set = await app.inject({ method: 'PUT', url: '/v1/ops/system/settings/sms_unit_mnt', headers: desk(), payload: { value: '45' } });
    expect(set.json()).toMatchObject({ key: 'sms_unit_mnt', value: 45, updated_by: 'ops:Демо' });
    const priced = (await app.inject({ method: 'GET', url: '/v1/ops/notify/volume', headers: desk() })).json();
    expect(priced.months[0].cost_mnt).toBe(priced.months[0].sms.sent * 45);
  });
});

describe('the machine', () => {
  it('says what mode it runs in, whether the scheduler ticked, and how each integration is doing', async () => {
    const cold = (await app.inject({ method: 'GET', url: '/v1/ops/system', headers: desk() })).json();
    expect(cold).toMatchObject({ mode: 'demo', version: expect.any(String), scheduler: { last_at: null, ticks_last_hour: 0 } });
    expect(cold.integrations.map((i: { key: string; flavour: string; ok: boolean }) => [i.key, i.flavour, i.ok])).toEqual([
      ['qpay', 'fake', true],
      ['posapi', 'fake', true],
      ['sms', 'fake', true],
      ['apns', 'fake', true],
    ]);
    expect(cold.database.migrations).toBeGreaterThan(20);
    expect(cold.rules).toEqual({ commission_pct: 2, forfeit_pct: 10, no_show_days: 3 });
    expect(cold.settings.map((s: { key: string; value: unknown }) => [s.key, s.value])).toEqual([['sms_unit_mnt', 0], ['push_unit_mnt', 0], ['desk_banner', '']]);

    await app.inject({ method: 'POST', url: '/dev/tick' });
    const warm = (await app.inject({ method: 'GET', url: '/v1/ops/system', headers: desk() })).json();
    expect(warm.scheduler.last_at).not.toBeNull();
    expect(warm.scheduler).toMatchObject({ ok: true, ticks_last_hour: 1, last_report: expect.objectContaining({ fired: 0 }) });
    const ticks = (await app.inject({ method: 'GET', url: '/v1/ops/system/ticks', headers: desk() })).json().ticks;
    expect(ticks).toHaveLength(1);
    expect(ticks[0].took_ms).toBeGreaterThanOrEqual(0);
  });

  it('turns only the knobs it knows, to values that make sense, and writes down who did', async () => {
    expect((await app.inject({ method: 'PUT', url: '/v1/ops/system/settings/nope', headers: desk(), payload: { value: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/v1/ops/system/settings/sms_unit_mnt', headers: desk(), payload: { value: -5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/v1/ops/system/settings/sms_unit_mnt', headers: desk(), payload: { value: 'abc' } })).statusCode).toBe(400);
    const banner = await app.inject({ method: 'PUT', url: '/v1/ops/system/settings/desk_banner', headers: desk(), payload: { value: '  Маргааш 10:00-д QPay-тэй уулзана  ' } });
    expect(banner.json()).toMatchObject({ value: 'Маргааш 10:00-д QPay-тэй уулзана' });
    const system = (await app.inject({ method: 'GET', url: '/v1/ops/system', headers: desk() })).json();
    expect(system.settings.find((s: { key: string }) => s.key === 'desk_banner')).toMatchObject({ value: 'Маргааш 10:00-д QPay-тэй уулзана', updated_by: 'ops:Демо' });
    const audit = (await app.inject({ method: 'GET', url: '/v1/ops/audit', headers: desk() })).json().audit;
    expect(audit[0]).toMatchObject({ action: 'setting.change', target_kind: 'setting', note: 'desk_banner = Маргааш 10:00-д QPay-тэй уулзана' });
    // Nobody without a seat, and nobody below admin, turns a knob.
    expect((await app.inject({ method: 'PUT', url: '/v1/ops/system/settings/desk_banner', payload: { value: 'x' } })).statusCode).toBe(401);
  });
});
