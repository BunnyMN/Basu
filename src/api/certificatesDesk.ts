import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import {
  certificateById,
  certificatePhoto,
  certificatesForDesk,
  checkCertificate,
  IdeshError,
  ownerOf,
  type AuditLine,
  type DeskCertificate,
} from '../idesh/index.js';
import { enqueue } from '../platform/notify/index.js';
import type { Ctx } from '../ports.js';
import { badRequest, sendError } from './errors.js';
import { UUID } from './guards.js';

/**
 * The veterinary certificates suppliers wrote in, for the desk: every one,
 * the unchecked first; its photograph; and the one thing the desk does to
 * one — say what looking its number up in the state's system found. Found
 * false, the meat under it leaves the guests' sight and its supplier is told.
 */

export interface CertificateGuards {
  desk: (permission: string) => RouteShorthandOptions;
  who: (request: FastifyRequest) => string;
  /** A line in the desk's record, under whoever is acting: see `registerOpsRoutes`. */
  audit: (request: FastifyRequest, line: AuditLine) => Promise<void>;
}

const shape = (c: DeskCertificate) => ({
  id: c.id,
  supplier_id: c.supplierId,
  supplier_name: c.supplierName,
  number: c.number,
  issuer: c.issuer,
  issued_on: c.issuedOn,
  has_photo: c.hasPhoto,
  state: c.state,
  checked_by: c.checkedBy,
  checked_at: c.checkedAt?.toISOString() ?? null,
  check_note: c.checkNote,
  listings: c.listings,
  orders: c.orders,
  created_at: c.createdAt.toISOString(),
});

export function registerCertificatesDesk(app: FastifyInstance, ctx: Ctx, { desk, who, audit }: CertificateGuards): void {
  app.get('/v1/ops/certificates', desk('desk.certificates'), async () => {
    const all = await certificatesForDesk();
    return {
      summary: {
        unchecked: all.filter((c) => c.state === 'unchecked').length,
        genuine: all.filter((c) => c.state === 'genuine').length,
        false: all.filter((c) => c.state === 'false').length,
      },
      certificates: all.map(shape),
    };
  });

  app.get<{ Params: { id: string } }>('/v1/ops/certificates/:id/photo', desk('desk.certificates'), async (request, reply) => {
    // An id that is not one is no certificate: 404, never a query Postgres fails.
    const photo = UUID.test(request.params.id) ? await certificatePhoto(request.params.id, null) : null;
    if (!photo) return sendError(reply, new IdeshError('NO_CERTIFICATE', 'no photo of that certificate'));
    return reply.header('content-type', photo.type).header('cache-control', 'private, no-store').send(photo.bytes);
  });

  app.post<{ Params: { id: string }; Body: { genuine?: boolean; note?: string } }>(
    '/v1/ops/certificates/:id/check',
    desk('desk.certificates:check'),
    async (request, reply) => {
      if (!UUID.test(request.params.id)) return sendError(reply, new IdeshError('NOT_FOUND', 'that is not an id'));
      const genuine = request.body?.genuine;
      if (typeof genuine !== 'boolean') return badRequest(reply, 'Шалгалтын дүнгээ сонгоно уу.', 'genuine must be true or false');
      const note = request.body?.note?.trim() || null;
      // Taking meat out of sight needs its reason said, to the supplier and in the record.
      if (!genuine && !note) return badRequest(reply, 'Яагаад хүчингүй гэж үзсэнээ бичнэ үү.', 'a reason is required');
      try {
        const before = await certificateById(request.params.id);
        const checked = await checkCertificate({ id: request.params.id, genuine, by: who(request), note, at: ctx.clock.now() });
        await audit(request, {
          action: genuine ? 'certificate.genuine' : 'certificate.false',
          targetKind: 'certificate',
          targetId: checked.id,
          note: `№${checked.number} · ${checked.supplierName}${note ? ` · ${note}` : ''}`,
        });
        if (!genuine && before?.state !== 'false') {
          const owner = await ownerOf(checked.supplierId);
          if (owner) {
            await enqueue(ctx, {
              guestId: owner,
              subject: 'idesh',
              subjectId: checked.id,
              template: 'supplier.certificate',
              channel: 'push',
              dedupeKey: `certificate:${checked.id}:false`,
              title: 'Гэрчилгээ хүчингүй',
              body: `№${checked.number} гэрчилгээг Basu шалгаад хүчингүй гэж үзлээ: ${note}. Энэ гэрчилгээтэй зар зочдод харагдахгүй.`,
            });
          }
        }
        return reply.send({ certificate: shape(checked) });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
