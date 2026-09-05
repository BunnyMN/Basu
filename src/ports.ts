import type { Clock } from './domain/time.js';

/**
 * Everything outside the process sits behind one of these.
 *
 * Not for the sake of abstraction: QPay, the tax authority's PosAPI and the SMS
 * gateway are all things that go down, and the failure ladder in the technical
 * spec is only testable if we can make them fail on demand. The fakes below are
 * the test doubles that make that possible.
 */

/* ── payments ──────────────────────────────────────────────────────── */

export interface PaymentIntent {
  providerRef: string;
  /** QPay hands back a deeplink; a card flow hands back a 3DS redirect. */
  actionUrl?: string;
}

export interface PaymentProvider {
  readonly name: 'qpay' | 'card';
  /**
   * Reserve the money. For QPay this is the invoice; for a card, the auth.
   *
   * `reference` is ours, not theirs — a top-up id today, an order id before
   * there were wallets. The provider only echoes it back on the statement, and
   * a provider that thinks in orders cannot be asked to top up a balance.
   */
  authorize(input: { reference: string; amountMnt: number }): Promise<PaymentIntent>;
  capture(providerRef: string): Promise<void>;
  refund(input: { providerRef: string; amountMnt: number }): Promise<void>;
}

/* ── tax ───────────────────────────────────────────────────────────── */

export interface Receipt {
  billId: string;
  lottery: string;
  ddtd: string;
  qrPayload: string;
}

export interface TaxProvider {
  /**
   * The restaurant is the seller and we are the conduit (§06 of the ops
   * playbook), so this always carries the restaurant's own TIN.
   */
  issue(input: {
    merchantTin: string;
    orderCode: string;
    amountMnt: number;
    kind: 'SALE' | 'RETURN';
    originalDdtd?: string;
  }): Promise<Receipt>;
}

/* ── notifications ─────────────────────────────────────────────────── */

export interface OutgoingMessage {
  channel: 'push' | 'sms';
  to: string;
  template: string;
  body: string;
}

export interface Notifier {
  send(message: OutgoingMessage): Promise<{ providerRef: string }>;
}

/* ── the bundle services take ──────────────────────────────────────── */

export interface Ctx {
  clock: Clock;
  payments: PaymentProvider;
  tax: TaxProvider;
  notifier: Notifier;
}

/* ── fakes ─────────────────────────────────────────────────────────── */

export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'qpay' as const;
  readonly authorized: string[] = [];
  readonly captured: string[] = [];
  readonly refunded: Array<{ providerRef: string; amountMnt: number }> = [];
  /** Flip on to rehearse a provider outage. */
  failNext = false;
  #seq = 0;

  async authorize(input: { reference: string; amountMnt: number }): Promise<PaymentIntent> {
    this.#guard();
    const providerRef = `qpay-${++this.#seq}-${input.reference.slice(0, 8)}`;
    this.authorized.push(providerRef);
    return { providerRef, actionUrl: `qpay://invoice/${providerRef}` };
  }

  async capture(providerRef: string): Promise<void> {
    this.#guard();
    this.captured.push(providerRef);
  }

  async refund(input: { providerRef: string; amountMnt: number }): Promise<void> {
    this.#guard();
    this.refunded.push(input);
  }

  #guard() {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('payment provider unavailable');
    }
  }
}

export class FakeTaxProvider implements TaxProvider {
  readonly issued: Array<{ orderCode: string; kind: string; amountMnt: number; merchantTin: string }> = [];
  /** The tax API being down must never block a ticket — this proves it. */
  down = false;
  #seq = 0;

  async issue(input: {
    merchantTin: string;
    orderCode: string;
    amountMnt: number;
    kind: 'SALE' | 'RETURN';
  }): Promise<Receipt> {
    if (this.down) throw new Error('ebarimt unavailable');
    const n = ++this.#seq;
    this.issued.push({
      orderCode: input.orderCode,
      kind: input.kind,
      amountMnt: input.amountMnt,
      merchantTin: input.merchantTin,
    });
    return {
      billId: `BILL${String(n).padStart(8, '0')}`,
      lottery: `AA${String(n).padStart(8, '0')}`,
      ddtd: `DDTD-${n}`,
      qrPayload: `https://ebarimt.mn/?d=DDTD-${n}`,
    };
  }
}

export class FakeNotifier implements Notifier {
  readonly sent: OutgoingMessage[] = [];
  /** Simulates the push provider dying so traffic falls back to SMS. */
  failChannel: 'push' | 'sms' | null = null;
  #seq = 0;

  async send(message: OutgoingMessage): Promise<{ providerRef: string }> {
    if (this.failChannel === message.channel) {
      throw new Error(`${message.channel} provider unavailable`);
    }
    this.sent.push(message);
    return { providerRef: `msg-${++this.#seq}` };
  }

  of(template: string): OutgoingMessage[] {
    return this.sent.filter((m) => m.template === template);
  }
}
