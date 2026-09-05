import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  approveSupplier,
  createSupplierCode,
  declineSupplier,
  IdeshError,
  listSuppliers,
  registerSupplier,
  type SupplierRow,
} from '../idesh/index.js';
import { mode } from '../mode.js';
import { badRequest, sendError, unauthorized } from './errors.js';
import type { Ctx } from '../ports.js';

/**
 * Ops: the few people at Basu who sign contracts.
 *
 * One shared secret, `OPS_TOKEN` in the server's `.env`, sent as a bearer
 * token by the ops page. Not a user system — there are two or three of these
 * people and they sit in one room — and deliberately not a guest with a
 * flag, which would put «who may approve a supplier» into a table anybody
 * with the database could edit. A secret in the environment is exactly as
 * hard to change as the deploy, which is the right amount.
 *
 * In demo mode the token is minted at boot and handed out by `/dev/ops-token`
 * so a walkthrough can approve somebody. In production it has to be set; if
 * it is not, the ops surface says so and stays shut rather than opening.
 */

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

let minted: string | null = null;

/** The token in force, or null when production has none configured. */
export function opsToken(): string | null {
  const configured = process.env['OPS_TOKEN']?.trim();
  if (configured) return configured;
  if (mode() === 'production') return null;
  minted ??= randomBytes(18).toString('base64url');
  return minted;
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7);
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const shape = (s: SupplierRow) => ({
  id: s.id,
  name: s.name,
  phone: s.phone,
  merchant_tin: s.merchantTin,
  pickup_address: s.pickupAddress,
  about: s.about,
  lat: s.lat,
  lon: s.lon,
  state: s.state,
  active: s.active,
  applied_at: s.appliedAt?.toISOString() ?? null,
  contracted_at: s.contractedAt?.toISOString() ?? null,
  decline_reason: s.declineReason,
  watched: s.watched,
  listings: s.listings,
});

export async function registerOpsRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  opts: { dev: boolean },
): Promise<void> {
  const requireOps: Guard = async (request, reply) => {
    const token = opsToken();
    if (!token) {
      return sendError(reply, new IdeshError('OPS_CLOSED', 'OPS_TOKEN is not configured'));
    }
    const sent = bearer(request);
    if (!sent || !same(sent, token)) return unauthorized(reply);
    return undefined;
  };
  const asOps = { preHandler: requireOps };

  /** Everybody who is, or asked to be, a supplier. Applications first. */
  app.get('/v1/ops/suppliers', asOps, async () => ({
    suppliers: (await listSuppliers()).map(shape),
  }));

  /** Ops writes a contracted supplier straight in, as the script does. */
  app.post<{
    Body: { name?: string; phone?: string; tin?: string; address?: string; lat?: number; lon?: number };
  }>('/v1/ops/suppliers', asOps, async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name?.trim() || !body.phone || !body.address?.trim()) {
      return badRequest(reply, 'Нэр, утас, авах цэгээ оруулна уу.', 'name, phone and address are required');
    }
    if (!/^\+976\d{8}$/.test(body.phone)) {
      return badRequest(reply, 'Утас +976XXXXXXXX хэлбэртэй байх ёстой.', 'phone must be +976XXXXXXXX');
    }
    try {
      const id = await registerSupplier({
        name: body.name,
        phone: body.phone,
        merchantTin: body.tin?.trim() || null,
        pickupAddress: body.address,
        lat: typeof body.lat === 'number' ? body.lat : null,
        lon: typeof body.lon === 'number' ? body.lon : null,
      });
      const code = await createSupplierCode(ctx, id, 'Нийлүүлэгчийн дэлгэц', 24 * 60);
      return reply.status(201).send({ id, pairing_code: code, expires_in_minutes: 24 * 60 });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/v1/ops/suppliers/:id/approve', asOps, async (request, reply) => {
    try {
      const { pairingCode } = await approveSupplier(ctx, request.params.id);
      return reply.send({ state: 'contracted', pairing_code: pairingCode });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/v1/ops/suppliers/:id/decline',
    asOps,
    async (request, reply) => {
      try {
        await declineSupplier(ctx, request.params.id, request.body?.reason ?? '');
        return reply.send({ state: 'declined' });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /** A fresh code — a lost phone, a code that expired unread. */
  app.post<{ Params: { id: string } }>('/v1/ops/suppliers/:id/code', asOps, async (request, reply) => {
    const known = (await listSuppliers()).find((s) => s.id === request.params.id);
    if (!known || known.state !== 'contracted') {
      return sendError(reply, new IdeshError('NOT_FOUND', 'no contracted supplier under that id'));
    }
    const code = await createSupplierCode(ctx, request.params.id, 'Нийлүүлэгчийн дэлгэц', 24 * 60);
    return reply.send({ pairing_code: code, expires_in_minutes: 24 * 60 });
  });

  if (!opts.dev) return;

  /** The demo's ops secret, so a walkthrough can approve somebody. */
  app.get('/dev/ops-token', async (_request, reply) => {
    const token = opsToken();
    if (!token) return sendError(reply, new IdeshError('OPS_CLOSED', 'OPS_TOKEN is not configured'));
    return reply.send({ token });
  });
}
