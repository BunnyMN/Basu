import { wireConfigFromEnv, WirePayments } from '../platform/ledger/index.js';
import { apnsConfigFromEnv, ApnsNotifier, SmtpMailer, smtpConfigFromEnv, smtpHost } from '../platform/notify/index.js';
import {
  ClosedPaymentProvider,
  FakeMailer,
  HostedFakePaymentProvider,
  FakeNotifier,
  FakePaymentProvider,
  FakeTaxProvider,
  type Ctx,
  type Mailer,
  type OutgoingMail,
} from '../ports.js';
import { buildClock, mode } from '../mode.js';
import { sealing } from '../secret.js';

/**
 * What the two processes talk to. One place, so the API and the scheduler
 * cannot disagree about which provider is real — the way they once disagreed
 * about the clock.
 *
 * Each provider is real when its credentials are in the environment and the
 * fake otherwise, and says which at boot. Payments are real wherever
 * `WIRE_SECRET_KEY` is set (Wire fronts QPay); APNs is real wherever
 * `APNS_*` is. The PosAPI is still the fake everywhere, and SMS has no
 * gateway yet, so the push notifier hands that channel to the fake, which is
 * where the relay ladder's last rung ends today.
 */
/**
 * A developer's mail server: the letter is printed, and kept, so /dev/mail
 * can hand a UI test the code the way an inbox hands it to a person.
 */
class ConsoleMailer extends FakeMailer {
  constructor(private readonly log: (line: string) => void) {
    super();
  }

  override async send(mail: OutgoingMail): Promise<{ providerRef: string }> {
    this.log(`[providers] mail to ${mail.to}: ${mail.subject}`);
    return super.send(mail);
  }
}

/** The demo pays on a page of its own, the way production pays on Wire's: FAKE_PAYMENTS=hosted. */
const hostedFake = () => process.env['FAKE_PAYMENTS']?.trim() === 'hosted';

export function buildProviders(log: (line: string) => void = console.log): Ctx {
  const wire = wireConfigFromEnv();
  const apns = apnsConfigFromEnv();
  const smtp = smtpConfigFromEnv();
  // Email is real where SMTP is set. A developer's machine without it prints
  // codes to its own console; a production server without it has no email
  // door at all, rather than a fake that swallows the codes.
  const mailer: Mailer | undefined = smtp
    ? new SmtpMailer(smtp)
    : mode() === 'production'
      ? undefined
      : new ConsoleMailer(log);
  const sms = new FakeNotifier();
  const notifier = apns ? new ApnsNotifier(apns, sms) : sms;
  log(
    apns
      ? `[providers] push: APNs ${apns.host} for ${apns.bundleId} (key ${apns.keyId})`
      : '[providers] push: fake (set APNS_TEAM_ID, APNS_KEY_ID, APNS_KEY_FILE to send)',
  );
  log(
    wire
      ? `[providers] payments: Wire → QPay (${wire.secretKey.startsWith('sk_test_') ? 'sandbox' : 'live'}${wire.webhookSecret ? ', webhook on' : ', polling only'})`
      : mode() === 'production'
        ? '[providers] payments: CLOSED — production without WIRE_SECRET_KEY refuses every top-up'
        : hostedFake()
          ? '[providers] payments: fake, paid on the demo\'s own page /dev/pay (FAKE_PAYMENTS=hosted)'
          : '[providers] payments: fake (set WIRE_SECRET_KEY to take real money)',
  );
  log(
    smtp
      ? `[providers] email: SMTP via ${smtpHost(smtp.url)} from ${smtp.from}`
      : mailer
        ? '[providers] email: printed to this console (set SMTP_URL and MAIL_FROM to send)'
        : '[providers] email: none — the email door is closed (set SMTP_URL and MAIL_FROM)',
  );
  // No gateway yet, so no `smsGateway`: production keeps the phone-code door shut.
  log(
    mode() === 'production'
      ? '[providers] sms: none — the phone-code door is closed until a gateway is configured · tax: fake'
      : '[providers] sms: fake · tax: fake',
  );
  log(sealing() ? '[providers] bank details: encrypted at rest' : '[providers] bank details: PLAIN TEXT (set BANK_KEY to encrypt)');
  return {
    clock: buildClock(),
    payments: wire
      ? new WirePayments(wire)
      : mode() === 'production'
        ? new ClosedPaymentProvider()
        : hostedFake()
          ? new HostedFakePaymentProvider()
          : new FakePaymentProvider(),
    tax: new FakeTaxProvider(),
    notifier,
    ...(mailer ? { mailer } : {}),
  };
}
