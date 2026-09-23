import type { FastifyInstance } from 'fastify';
import {
  settleTopup,
  topupByProviderRef,
  verifyWireWebhook,
  WIRE_SIGNATURE_HEADER,
  type WireConfig,
} from '../platform/ledger/index.js';
import type { Ctx } from '../ports.js';

/**
 * Where Wire tells us the money arrived.
 *
 * The phone can ask too — `POST /v1/wallet/topup/:id/settle` checks with the
 * provider and credits the wallet — so this endpoint is the faster of two
 * paths to the same place, not the only one. If the callback never comes,
 * nothing is lost; the next time the app asks, the wallet fills.
 *
 * Three things keep it honest. The signature proves Wire sent it. The
 * timestamp inside the signature stops a captured callback being replayed
 * later. And crediting still goes through `settleTopup`, which asks the
 * provider itself whether the money is really there — so even a forged
 * callback that somehow passed the first two would credit nothing.
 *
 * It answers 200 to anything it recognises, including an event it has
 * already handled: a provider that gets an error retries, and there is
 * nothing to retry.
 */
export async function registerPaymentRoutes(app: FastifyInstance, ctx: Ctx, wire: WireConfig | null): Promise<void> {
  if (!wire?.webhookSecret) return;
  const secret = wire.webhookSecret;

  await app.register(async (scope) => {
    // The signature covers the bytes that arrived, so this scope — and only
    // this scope — keeps the body as a Buffer instead of parsing it.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    scope.post('/v1/payments/wire/webhook', async (request, reply) => {
      let event;
      try {
        event = verifyWireWebhook(
          request.body as Buffer,
          request.headers[WIRE_SIGNATURE_HEADER] as string | undefined,
          secret,
          new Date(),
        );
      } catch (error) {
        request.log.warn({ err: error }, 'wire webhook refused');
        return reply.status(400).send({ error: { code: 'BAD_SIGNATURE', message_en: 'signature did not verify' } });
      }

      if (event.type !== 'payment_intent.succeeded') return reply.send({ received: true });
      const providerRef = typeof event.data?.object?.['id'] === 'string' ? (event.data.object['id'] as string) : null;
      if (!providerRef) return reply.send({ received: true });

      const topupId = await topupByProviderRef('qpay', providerRef);
      if (!topupId) return reply.send({ received: true, known: false });
      try {
        await settleTopup(ctx, topupId);
      } catch (error) {
        // Already settled, or the provider says it is not paid after all.
        // Either way the callback has been heard and must not be retried.
        request.log.warn({ err: error, topupId }, 'wire webhook could not settle');
      }
      return reply.send({ received: true });
    });
  });
}
