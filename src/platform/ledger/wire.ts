import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentIntent, PaymentProvider } from '../../ports.js';

/**
 * Real money, through Wire (wire.mn) onto QPay.
 *
 * Wire fronts QPay: we create a payment intent and a checkout session, the
 * phone opens the hosted page, the person pays from their bank app, and Wire
 * tells us. Two things matter to the rest of Basu and nothing else does.
 *
 * First, `authorize` is idempotent on the top-up id. A phone on a Mongolian
 * mobile network retries; without the idempotency key each retry would be a
 * second invoice for the same money, and the person would see two QR codes
 * and rightly not know which to pay.
 *
 * Second, `capture` does not move money — Wire's hosted checkout already
 * took it — it *asks whether the money arrived* and refuses when it has not.
 * That is what makes `POST /v1/wallet/topup/:id/settle` safe to leave open to
 * the guest: a person calling it on an unpaid top-up gets a refusal from
 * Wire, not a credited wallet. The fake provider says yes to everything,
 * which is exactly why the demo must never be the production server.
 *
 * Amounts: Wire counts in minor units (1₮ = 100). Basu counts whole tugriks
 * everywhere, so the conversion lives here and nowhere else.
 */

const DEFAULT_API_BASE = 'https://api.wire.mn/v1';
export const WIRE_SIGNATURE_HEADER = 'wirepayment-signature';

export interface WireConfig {
  secretKey: string;
  /** Only needed to accept webhooks; polling works without one. */
  webhookSecret?: string | undefined;
  /** Where the hosted checkout sends the person back to. */
  returnUrl?: string | undefined;
  /** Overridden by the tests, which run a stand-in for Wire. */
  apiBase?: string | undefined;
}

/** Null when the key is absent, which is how `buildProviders` picks the fake. */
export function wireConfigFromEnv(): WireConfig | null {
  const secretKey = process.env['WIRE_SECRET_KEY']?.trim();
  if (!secretKey) return null;
  return {
    secretKey,
    webhookSecret: process.env['WIRE_WEBHOOK_SECRET']?.trim() || undefined,
    returnUrl: process.env['WIRE_RETURN_URL']?.trim() || undefined,
    apiBase: process.env['WIRE_API_BASE']?.trim() || undefined,
  };
}

export class WireError extends Error {
  constructor(
    readonly statusCode: number,
    /** Wire's stable machine-readable code; branch on this, never on the message. */
    readonly code: string | undefined,
    /** Quote this to Wire's support and they can find the call. */
    readonly requestId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'WireError';
  }
}

interface WireIntent {
  id: string;
  status: string;
  amount: number;
  expires_at?: number | null;
  metadata?: Record<string, string>;
}

export class WirePayments implements PaymentProvider {
  /** The money arrives over QPay, whoever carries it. */
  readonly name = 'qpay' as const;
  readonly #config: WireConfig;

  constructor(config: WireConfig) {
    this.#config = config;
  }

  /** A test key pays with Wire's sandbox operator; a live key with QPay. */
  get #operators(): string[] {
    return this.#config.secretKey.startsWith('sk_test_') ? ['sandbox'] : ['qpay'];
  }

  async #call<T>(method: string, path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#config.secretKey}` };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    // A retry that arrives while the first call is still running gets 409
    // rather than a second invoice. Waiting is the whole point of the key.
    for (let attempt = 0; ; attempt++) {
      const init: RequestInit = { method, headers };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      const response = await fetch(`${this.#config.apiBase ?? DEFAULT_API_BASE}${path}`, init);
      const data = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string; request_id?: string } };
      if (response.ok) return data as T;
      if (response.status === 409 && data.error?.code === 'idempotency_in_flight' && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      throw new WireError(
        response.status,
        data.error?.code,
        data.error?.request_id,
        data.error?.message ?? `Wire answered ${response.status}`,
      );
    }
  }

  async authorize(input: { reference: string; amountMnt: number }): Promise<PaymentIntent> {
    const intent = await this.#call<WireIntent>('POST', '/payment_intents', {
      idempotencyKey: `pi-${input.reference}`,
      body: {
        amount: input.amountMnt * 100,
        currency: 'MNT',
        description: `Basu түрийвч цэнэглэлт`,
        allowed_operators: this.#operators,
        metadata: { topup_id: input.reference },
      },
    });
    // The intent cancels itself after about ten minutes, so the session is
    // made in the same breath rather than when the phone gets round to it.
    const session = await this.#call<{ url: string }>('POST', '/checkout/sessions', {
      idempotencyKey: `cs-${input.reference}`,
      body: {
        payment_intent: intent.id,
        ...(this.#config.returnUrl ? { success_url: this.#config.returnUrl, cancel_url: this.#config.returnUrl } : {}),
      },
    });
    return { providerRef: intent.id, actionUrl: session.url };
  }

  /** The ledger asks this before crediting; "no" leaves the top-up pending. */
  async paid(providerRef: string): Promise<boolean> {
    return (await this.status(providerRef)).paid;
  }

  /** Did the money actually arrive? Anything but yes is a refusal. */
  async capture(providerRef: string): Promise<void> {
    const state = await this.status(providerRef);
    if (!state.paid) {
      throw new WireError(409, 'not_paid', undefined, `the payment is ${state.status}, not paid`);
    }
  }

  async status(providerRef: string): Promise<{ paid: boolean; status: string; amountMnt: number; topupId: string | null }> {
    const intent = await this.#call<WireIntent>('GET', `/payment_intents/${encodeURIComponent(providerRef)}`);
    return {
      paid: intent.status === 'succeeded',
      status: intent.status,
      amountMnt: Math.round(intent.amount / 100),
      topupId: intent.metadata?.['topup_id'] ?? null,
    };
  }

  async cancel(providerRef: string): Promise<void> {
    await this.#call('POST', `/payment_intents/${encodeURIComponent(providerRef)}/cancel`, {
      idempotencyKey: `cancel-${providerRef}`,
      body: {},
    });
  }

  /**
   * Wire has no refund call, and Basu does not need one: a cancelled lunch
   * puts the money back in the wallet, and an idesh refund leaves by a bank
   * transfer somebody makes by hand. Throwing here is the honest answer —
   * silently doing nothing would let a caller believe money went back.
   */
  async refund(): Promise<void> {
    throw new WireError(501, 'refund_unsupported', undefined, 'Wire does not refund; money goes back through the wallet or by bank transfer');
  }
}

/**
 * A webhook Wire really sent, and recently.
 *
 * The signature covers `${timestamp}.${raw body}`, so the body must be the
 * bytes that arrived: re-serialising the parsed JSON changes a space and the
 * signature fails. The timestamp is what stops somebody replaying yesterday's
 * "you were paid" an hour after the refund.
 */
export function verifyWireWebhook(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
  now: Date,
  toleranceSeconds = 300,
): { id?: string; type?: string; data?: { object?: Record<string, unknown> } } {
  if (!signatureHeader) throw new WireError(400, 'signature_missing', undefined, 'no signature header');
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of String(signatureHeader).split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't') timestamp = value;
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || !signatures.length) throw new WireError(400, 'signature_malformed', undefined, 'malformed signature header');

  const age = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    throw new WireError(400, 'signature_stale', undefined, 'signature timestamp outside tolerance');
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const expected = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), body])).digest();
  const ok = signatures.some((given) => {
    const bytes = Buffer.from(given, 'hex');
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  });
  if (!ok) throw new WireError(400, 'signature_invalid', undefined, 'invalid signature');

  return JSON.parse(body.toString('utf8')) as { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
}
