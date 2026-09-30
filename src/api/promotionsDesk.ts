import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { endPromotion, promotionsForDesk, TIER_WORD, type AuditLine, type DeskPromotion } from '../idesh/index.js';
import { contactsFor, displayNamesFor } from '../platform/identity/index.js';
import type { Ctx } from '../ports.js';
import { badRequest, sendError } from './errors.js';

/**
 * Listings suppliers paid to put first, for the desk: every purchase, what
 * it cost, who bought it, whether it holds; and the one thing the desk may
 * do to one, take it off — with a reason, into the record.
 */

export interface PromotionGuards {
  desk: (permission: string) => RouteShorthandOptions;
  who: (request: FastifyRequest) => string;
  /** A line in the desk's record, under whoever is acting: see `registerOpsRoutes`. */
  audit: (request: FastifyRequest, line: AuditLine) => Promise<void>;
}

/** Where a purchase stands now, in one word the desk filters by. */
function standing(p: DeskPromotion, now: Date): 'pending' | 'live' | 'over' | 'ended' | 'cancelled' {
  if (p.state === 'pending') return 'pending';
  if (p.state === 'cancelled') return p.paidAt ? 'ended' : 'cancelled';
  return p.endsAt && p.endsAt > now ? 'live' : 'over';
}

export function registerPromotionsDesk(app: FastifyInstance, ctx: Ctx, { desk, who, audit }: PromotionGuards): void {
  app.get('/v1/ops/promotions', desk('desk.promotions'), async () => {
    const now = ctx.clock.now();
    const all = await promotionsForDesk();
    const buyers = [...new Set(all.map((p) => p.boughtBy))];
    const [names, contacts] = await Promise.all([displayNamesFor(buyers), contactsFor(buyers)]);
    const live = all.filter((p) => standing(p, now) === 'live');
    const month = new Date(now.getTime() - 30 * 86_400_000);
    return {
      summary: {
        live: live.length,
        live_vip: live.filter((p) => p.tier === 'vip').length,
        revenue_30d_mnt: all.filter((p) => p.paidAt && p.paidAt > month).reduce((sum, p) => sum + p.priceMnt, 0),
        pending: all.filter((p) => p.state === 'pending').length,
      },
      promotions: all.map((p) => {
        const c = contacts.get(p.boughtBy);
        return {
          id: p.id,
          listing_id: p.listingId,
          listing_title: p.listingTitle,
          supplier_id: p.supplierId,
          supplier_name: p.supplierName,
          tier: p.tier,
          name: TIER_WORD[p.tier],
          days: p.days,
          price_mnt: p.priceMnt,
          state: p.state,
          standing: standing(p, now),
          buyer: names.get(p.boughtBy) ?? null,
          buyer_contact: c?.email ?? c?.phone ?? null,
          starts_at: p.startsAt?.toISOString() ?? null,
          ends_at: p.endsAt?.toISOString() ?? null,
          paid_at: p.paidAt?.toISOString() ?? null,
          created_at: p.createdAt.toISOString(),
          ended_by: p.endedBy,
          ended_note: p.endedNote,
        };
      }),
    };
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/v1/ops/promotions/:id/end',
    desk('desk.promotions:manage'),
    async (request, reply) => {
      const note = request.body?.note?.trim();
      if (!note) return badRequest(reply, 'Яагаад зогсоож байгаагаа бичнэ үү.', 'a reason is required');
      try {
        const ended = await endPromotion({ id: request.params.id, at: ctx.clock.now(), by: who(request), note });
        await audit(request, {
          action: 'promotion.end',
          targetKind: 'promotion',
          targetId: ended.id,
          note: `${TIER_WORD[ended.tier]} · ${ended.listingTitle} · ${note}`,
        });
        return reply.send({ id: ended.id, state: ended.state, ends_at: ended.endsAt?.toISOString() ?? null });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
