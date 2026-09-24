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
  /**
   * Has the money actually arrived?
   *
   * A provider that can be asked answers here, and a top-up whose answer is
   * "not yet" stays pending: the phone asking early is the normal case, not
   * a failure, and marking it failed would strand money the person is about
   * to send. A provider that cannot be asked leaves this out, and `capture`
   * is taken at its word.
   */
  paid?(providerRef: string): Promise<boolean>;
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

/**
 * A Live Activity on a lock screen, moved from the server.
 *
 * `contentState` is whatever the app's `ActivityAttributes.ContentState`
 * decodes — the shape is the app's, notify carries it untouched. `end` takes
 * the card off the lock screen; iOS keeps it visible until `dismissAt` and
 * then removes it on its own.
 */
export interface ActivityPush {
  token: string;
  event: 'update' | 'end';
  contentState: Record<string, unknown>;
  alert?: { title: string; body: string };
  /** After this the card is greyed as out of date. */
  staleAt?: Date;
  /** With `end`: when the finished card disappears. */
  dismissAt?: Date;
}

export class PushTokenGone extends Error {
  constructor(readonly token: string) {
    super('the push token is no longer valid');
  }
}

export interface Notifier {
  send(message: OutgoingMessage): Promise<{ providerRef: string }>;
  /**
   * Throws `PushTokenGone` when the provider says the token is dead, so the
   * caller can forget it rather than retry it forever.
   */
  pushActivity(push: ActivityPush): Promise<{ providerRef: string }>;
}

/* ── email ─────────────────────────────────────────────────────────── */

export interface OutgoingMail {
  to: string;
  subject: string;
  /** Plain text is what arrives everywhere; html is a nicety on top. */
  text: string;
  html?: string;
}

/**
 * Anything that can put a letter in somebody's inbox.
 *
 * Sign-in codes go out this way now that the phone is not the only way in,
 * and so do messages for a person who never gave a phone.
 */
export interface Mailer {
  /** 'smtp' for a real one, 'fake' for the recording double. */
  readonly name: string;
  send(mail: OutgoingMail): Promise<{ providerRef: string }>;
}

/* ── the bundle services take ──────────────────────────────────────── */

export interface Ctx {
  clock: Clock;
  payments: PaymentProvider;
  tax: TaxProvider;
  notifier: Notifier;
  /**
   * Absent where nothing can send email. A production server without one
   * says so — the email door is closed — rather than handing codes to a fake
   * that would swallow them.
   */
  mailer?: Mailer;
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

/**
 * The payment provider a production server gets when none is configured.
 *
 * The fake says every top-up succeeded, which on a real server is money
 * printed out of nothing — and that money can buy real meat from a real
 * supplier whom the house then really owes. So production without a key
 * does not get the fake; it gets this, which says no, plainly.
 */
export class ClosedPaymentProvider implements PaymentProvider {
  readonly name = 'qpay' as const;

  async authorize(): Promise<PaymentIntent> {
    throw new PaymentsClosed();
  }

  async capture(): Promise<void> {
    throw new PaymentsClosed();
  }

  async refund(): Promise<void> {
    throw new PaymentsClosed();
  }

  async paid(): Promise<boolean> {
    return false;
  }
}

export class PaymentsClosed extends Error {
  constructor() {
    super('payments are not configured on this server');
    this.name = 'PaymentsClosed';
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
  readonly activities: ActivityPush[] = [];
  /** Simulates the push provider dying so traffic falls back to SMS. */
  failChannel: 'push' | 'sms' | null = null;
  /** Tokens APNs would answer 410 for. */
  readonly deadTokens = new Set<string>();
  #seq = 0;

  async send(message: OutgoingMessage): Promise<{ providerRef: string }> {
    if (this.failChannel === message.channel) {
      throw new Error(`${message.channel} provider unavailable`);
    }
    this.sent.push(message);
    return { providerRef: `msg-${++this.#seq}` };
  }

  async pushActivity(push: ActivityPush): Promise<{ providerRef: string }> {
    if (this.deadTokens.has(push.token)) throw new PushTokenGone(push.token);
    if (this.failChannel === 'push') throw new Error('push provider unavailable');
    this.activities.push(push);
    return { providerRef: `act-${++this.#seq}` };
  }

  of(template: string): OutgoingMessage[] {
    return this.sent.filter((m) => m.template === template);
  }
}

/** Keeps every letter it was asked to send, so a test can read the code in it. */
export class FakeMailer implements Mailer {
  readonly name = 'fake';
  readonly sent: OutgoingMail[] = [];
  /** Flip on to rehearse a mail server that refuses. */
  failNext = false;
  #seq = 0;

  async send(mail: OutgoingMail): Promise<{ providerRef: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mail server unavailable');
    }
    this.sent.push(mail);
    return { providerRef: `mail-${++this.#seq}` };
  }

  /** The last letter to this address. */
  to(address: string): OutgoingMail | undefined {
    return [...this.sent].reverse().find((m) => m.to === address);
  }

  /** The six-digit code in the last letter to this address. */
  codeFor(address: string): string | undefined {
    return /(\d{6})/.exec(this.to(address)?.text ?? '')?.[1];
  }
}
