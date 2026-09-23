import { wireConfigFromEnv, WirePayments } from '../platform/ledger/index.js';
import { apnsConfigFromEnv, ApnsNotifier } from '../platform/notify/index.js';
import { FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../ports.js';
import { buildClock } from '../mode.js';
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
export function buildProviders(log: (line: string) => void = console.log): Ctx {
  const wire = wireConfigFromEnv();
  const apns = apnsConfigFromEnv();
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
      : '[providers] payments: fake (set WIRE_SECRET_KEY to take real money)',
  );
  log('[providers] sms: fake · tax: fake');
  log(sealing() ? '[providers] bank details: encrypted at rest' : '[providers] bank details: PLAIN TEXT (set BANK_KEY to encrypt)');
  return {
    clock: buildClock(),
    payments: wire ? new WirePayments(wire) : new FakePaymentProvider(),
    tax: new FakeTaxProvider(),
    notifier,
  };
}
