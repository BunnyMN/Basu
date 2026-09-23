import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyWireWebhook, WireError, WirePayments } from './wire.js';

/**
 * The payment provider, against a stand-in for Wire.
 *
 * A fake HTTP server rather than a stubbed `fetch`: what has to be right is
 * the shape of the call — the idempotency key, the minor units, the operator
 * — and only a server that receives the real request can check that.
 */

interface Call {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
}

let server: Server;
let base: string;
let calls: Call[] = [];
/** What the stand-in answers next, keyed by `${method} ${path}`. */
let answers = new Map<string, { status: number; body: unknown }>();

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = request.url ?? '';
      calls.push({
        method: request.method ?? '',
        path,
        headers: request.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      });
      const answer = answers.get(`${request.method} ${path}`);
      response.writeHead(answer?.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer?.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  answers = new Map();
});

const live = () => new WirePayments({ secretKey: 'sk_live_test', apiBase: base, returnUrl: 'https://basu.burzai.cloud/' });

describe('taking money through Wire', () => {
  it('asks for an invoice in minor units, on QPay, keyed to the top-up', async () => {
    answers.set('POST /payment_intents', { status: 200, body: { id: 'pi_1', status: 'requires_payment_method', amount: 5_000_000 } });
    answers.set('POST /checkout/sessions', { status: 200, body: { id: 'cs_1', url: 'https://pay.wire.mn/c/abc' } });

    const intent = await live().authorize({ reference: 'topup-uuid', amountMnt: 50_000 });
    expect(intent).toEqual({ providerRef: 'pi_1', actionUrl: 'https://pay.wire.mn/c/abc' });

    const [made, session] = calls;
    expect(made!.headers['authorization']).toBe('Bearer sk_live_test');
    // The retry a dropped connection causes must not become a second invoice.
    expect(made!.headers['idempotency-key']).toBe('pi-topup-uuid');
    expect(made!.body).toMatchObject({
      amount: 5_000_000, // 50,000₮ in minor units
      currency: 'MNT',
      allowed_operators: ['qpay'],
      metadata: { topup_id: 'topup-uuid' },
    });
    expect(session!.headers['idempotency-key']).toBe('cs-topup-uuid');
    expect(session!.body).toMatchObject({ payment_intent: 'pi_1', success_url: 'https://basu.burzai.cloud/' });
  });

  it('pays through the sandbox when the key is a test key', async () => {
    answers.set('POST /payment_intents', { status: 200, body: { id: 'pi_2', status: 'new', amount: 100 } });
    answers.set('POST /checkout/sessions', { status: 200, body: { url: 'https://pay.wire.mn/c/x' } });
    await new WirePayments({ secretKey: 'sk_test_abc', apiBase: base }).authorize({ reference: 'r', amountMnt: 1 });
    expect(calls[0]!.body).toMatchObject({ allowed_operators: ['sandbox'] });
    // With nowhere to return to, the session carries no redirect at all.
    expect(calls[1]!.body).not.toHaveProperty('success_url');
  });

  it('credits nothing until Wire says the money arrived', async () => {
    answers.set('GET /payment_intents/pi_1', { status: 200, body: { id: 'pi_1', status: 'requires_payment_method', amount: 100 } });
    await expect(live().capture('pi_1')).rejects.toMatchObject({ code: 'not_paid' });

    answers.set('GET /payment_intents/pi_1', { status: 200, body: { id: 'pi_1', status: 'processing', amount: 100 } });
    await expect(live().capture('pi_1')).rejects.toMatchObject({ code: 'not_paid' });

    answers.set('GET /payment_intents/pi_1', { status: 200, body: { id: 'pi_1', status: 'succeeded', amount: 100, metadata: { topup_id: 't1' } } });
    await expect(live().capture('pi_1')).resolves.toBeUndefined();
    expect(await live().status('pi_1')).toEqual({ paid: true, status: 'succeeded', amountMnt: 1, topupId: 't1' });
  });

  it('hands back Wire’s own code so callers can branch on it', async () => {
    answers.set('POST /payment_intents', {
      status: 400,
      body: { error: { code: 'amount_too_small', message: 'amount is below the minimum', request_id: 'req_9' } },
    });
    const error = await live().authorize({ reference: 'r', amountMnt: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WireError);
    expect(error).toMatchObject({ code: 'amount_too_small', statusCode: 400, requestId: 'req_9' });
  });

  it('refuses to pretend it can refund', async () => {
    await expect(live().refund()).rejects.toMatchObject({ code: 'refund_unsupported' });
  });
});

describe('a callback from Wire', () => {
  const secret = 'whsec_test';
  const sign = (body: string, at: Date) => {
    const t = Math.floor(at.getTime() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    return `t=${t},v1=${v1}`;
  };
  const now = new Date('2026-09-23T10:00:00Z');
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } });

  it('opens one it really sent', () => {
    const event = verifyWireWebhook(body, sign(body, now), secret, now);
    expect(event).toMatchObject({ id: 'evt_1', type: 'payment_intent.succeeded' });
  });

  it('refuses one whose body was edited on the way', () => {
    const header = sign(body, now);
    const tampered = body.replace('pi_1', 'pi_9');
    expect(() => verifyWireWebhook(tampered, header, secret, now)).toThrow(/invalid signature/);
  });

  it('refuses one signed with another secret', () => {
    const header = `t=${Math.floor(now.getTime() / 1000)},v1=${createHmac('sha256', 'whsec_other').update(`${Math.floor(now.getTime() / 1000)}.${body}`).digest('hex')}`;
    expect(() => verifyWireWebhook(body, header, secret, now)).toThrow(/invalid signature/);
  });

  it('refuses yesterday’s callback replayed today', () => {
    const old = new Date(now.getTime() - 20 * 60 * 1000);
    expect(() => verifyWireWebhook(body, sign(body, old), secret, now)).toThrow(/tolerance/);
  });

  it('refuses one with no signature at all', () => {
    expect(() => verifyWireWebhook(body, undefined, secret, now)).toThrow(/no signature/);
    expect(() => verifyWireWebhook(body, 'garbage', secret, now)).toThrow(/malformed/);
  });
});
