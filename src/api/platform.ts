import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ClosureError,
  closeAccount,
  profileOf,
  revokeOtherSessions,
  revokeSession,
  sessionsOf,
  updateProfile,
  type Profile,
} from '../platform/identity/index.js';
import {
  balance,
  movement,
  settleTopup,
  startTopup,
  wallet,
} from '../platform/ledger/index.js';
import { liveOrderCount } from '../services/orders.js';
import {
  inbox,
  markRead,
  preferences,
  registerDevice,
  revokeDevice,
  setPreferences,
  unreadCount,
} from '../platform/notify/index.js';
import { badRequest, sendError } from './errors.js';
import type { Ctx } from '../ports.js';

/**
 * The platform's own HTTP surface: who you are, what you have, what you were
 * told.
 *
 * None of it mentions food. That is the test — every route here would answer
 * exactly the same way for a guest who has only ever taken a taxi, which is
 * what makes these the three things a second vertical gets for free.
 *
 * They are mounted separately from `server.ts` for the same reason: when
 * identity, ledger and notify become their own services, this file is what
 * moves, and the dine routes do not have to be picked out of it first.
 */

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** The token on the request, for the routes that need to know which one it is. */
const bearer = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
};

const MAX_TOPUP_MNT = 2_000_000;
const MIN_TOPUP_MNT = 1_000;

const shape = (profile: Profile) => ({
  id: profile.guestId,
  phone: profile.phone,
  display_name: profile.displayName,
  locale: profile.locale,
  avatar_seed: profile.avatarSeed,
  member_since: profile.memberSince.toISOString(),
});

export async function registerPlatformRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  requireGuest: Guard,
): Promise<void> {
  const guarded = { preHandler: requireGuest };

  /* ── profile ──────────────────────────────────────────────────────── */

  /**
   * One call the shell makes on launch.
   *
   * Profile, balance and unread count together, because a launcher that needs
   * three round trips before it can draw its own header is a launcher that
   * flickers on every cold start.
   */
  app.get('/v1/me', guarded, async (request, reply) => {
    const guestId = request.guestId!;
    const profile = await profileOf(guestId);
    if (!profile) return sendError(reply, new Error('profile missing'));
    const [balanceMnt, unread] = await Promise.all([balance(guestId), unreadCount(guestId)]);
    return { ...shape(profile), wallet: { balance_mnt: balanceMnt, currency: 'MNT' }, unread };
  });

  app.patch<{ Body: { display_name?: string | null; locale?: 'mn' | 'en' } }>(
    '/v1/me',
    guarded,
    async (request, reply) => {
      const { display_name, locale } = request.body ?? {};
      if (locale !== undefined && locale !== 'mn' && locale !== 'en') {
        return badRequest(reply, 'Хэл нь mn эсвэл en байх ёстой.', 'locale must be mn or en');
      }
      if (typeof display_name === 'string' && display_name.trim().length > 60) {
        return badRequest(reply, 'Нэр хэтэрхий урт байна.', 'name too long');
      }
      const edit: { displayName?: string | null; locale?: 'mn' | 'en' } = {};
      if (display_name !== undefined) edit.displayName = display_name;
      if (locale !== undefined) edit.locale = locale;
      const profile = await updateProfile(request.guestId!, edit, ctx.clock.now());
      return profile ? shape(profile) : sendError(reply, new Error('profile missing'));
    },
  );

  /* ── where you are signed in ──────────────────────────────────────── */

  /**
   * Not a feature until a phone is lost, and then the only one that matters.
   * It exists so that day needs nobody's help — no email, no support queue,
   * no waiting sixty days for a token to expire on its own.
   */
  app.get('/v1/me/sessions', guarded, async (request) => {
    const sessions = await sessionsOf(request.guestId!, bearer(request) ?? '');
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        label: s.label,
        current: s.current,
        created_at: s.createdAt.toISOString(),
        last_seen_at: s.lastSeenAt?.toISOString() ?? null,
      })),
    };
  });

  /** Everywhere *else*: signing somebody out of the phone in their hand
      mid-panic is the wrong end of the tool. */
  app.post('/v1/me/sessions/revoke', guarded, async (request) => {
    const revoked = await revokeOtherSessions(
      request.guestId!,
      bearer(request) ?? '',
      ctx.clock.now(),
    );
    return { revoked };
  });

  app.delete<{ Params: { id: string } }>(
    '/v1/me/sessions/:id',
    guarded,
    async (request, reply) => {
      const gone = await revokeSession(request.guestId!, request.params.id, ctx.clock.now());
      if (!gone) return sendError(reply, new Error('no such session'));
      return { revoked: 1 };
    },
  );

  /**
   * Leaving.
   *
   * Required by App Store review guideline 5.1.1(v): an app that makes
   * accounts has to let somebody close theirs from inside it. Refused while
   * the wallet holds money or something of theirs is still running — those are
   * not obstacles, they are the two things somebody would be furious to
   * discover they had thrown away.
   */
  app.delete('/v1/me', guarded, async (request, reply) => {
    const guestId = request.guestId!;
    try {
      await closeAccount({
        guestId,
        at: ctx.clock.now(),
        balanceMnt: await balance(guestId),
        // Identity cannot ask dine what a live order is, so dine answers.
        liveWork: await liveOrderCount(guestId),
      });
      return { closed: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ── wallet ───────────────────────────────────────────────────────── */

  app.get<{ Querystring: { before?: string } }>('/v1/wallet', guarded, async (request) => {
    const statement = await wallet(request.guestId!, 25, request.query.before);
    return {
      balance_mnt: statement.balanceMnt,
      currency: statement.currency,
      next: statement.nextCursor ?? null,
      lines: statement.lines.map((line) => ({
        id: line.transferId,
        kind: line.kind,
        // Signed the way the guest reads it: what their balance did.
        amount_mnt: line.amountMnt,
        subject: line.subject,
        subject_id: line.subjectId,
        memo: line.memo,
        at: line.at.toISOString(),
      })),
    };
  });

  /**
   * One movement, in full, with the tax receipt when there is one.
   *
   * The receipt is why this route exists. Somebody claiming lunch back needs
   * the ДДТД and the lottery number, and making them find the order it came
   * from to get at it is making them know how the software is built.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/wallet/:id',
    guarded,
    async (request, reply) => {
      const line = await movement(request.guestId!, request.params.id);
      if (!line) return sendError(reply, new Error('no such movement'));
      return {
        id: line.transferId,
        kind: line.kind,
        amount_mnt: line.amountMnt,
        subject: line.subject,
        subject_id: line.subjectId,
        memo: line.memo,
        at: line.at.toISOString(),
        receipt: line.receipt?.qrPayload
          ? { qr: line.receipt.qrPayload, lottery: line.receipt.lottery }
          : null,
      };
    },
  );

  /**
   * Ask for money. Nothing is credited until `settle`.
   *
   * The bounds are here rather than in the ledger because they are a product
   * decision about this app — a ledger that refused a two million tugrik
   * movement would be a ledger with an opinion about lunch.
   */
  app.post<{ Body: { amount_mnt?: number } }>(
    '/v1/wallet/topup',
    guarded,
    async (request, reply) => {
      const amount = Number(request.body?.amount_mnt);
      if (!Number.isInteger(amount) || amount < MIN_TOPUP_MNT || amount > MAX_TOPUP_MNT) {
        return badRequest(
          reply,
          `Цэнэглэх дүн ${MIN_TOPUP_MNT.toLocaleString('mn-MN')}₮-с ${MAX_TOPUP_MNT.toLocaleString('mn-MN')}₮ хооронд байна.`,
          'top-up amount out of range',
        );
      }
      try {
        const started = await startTopup(ctx, { guestId: request.guestId!, amountMnt: amount });
        return {
          topup_id: started.topupId,
          amount_mnt: started.amountMnt,
          action_url: started.actionUrl ?? null,
          state: started.state,
        };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /**
   * The money arrived.
   *
   * In production QPay's webhook drives this and the phone only polls; the app
   * calls it directly because a guest coming back from the QPay deeplink
   * should not have to wait on a callback that may be seconds behind them.
   * Both paths are safe: settling twice is the same as settling once.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/wallet/topup/:id/settle',
    guarded,
    async (request, reply) => {
      try {
        const balanceMnt = await settleTopup(ctx, request.params.id);
        return { balance_mnt: balanceMnt, currency: 'MNT' };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /* ── notifications ────────────────────────────────────────────────── */

  app.get('/v1/notifications', guarded, async (request) => {
    const guestId = request.guestId!;
    const [items, unread] = await Promise.all([inbox(guestId), unreadCount(guestId)]);
    return {
      unread,
      messages: items.map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        template: item.template,
        subject: item.subject,
        subject_id: item.subjectId,
        channel: item.channel,
        state: item.state,
        at: item.createdAt.toISOString(),
        read: item.readAt !== null,
      })),
    };
  });

  /** No id marks the whole inbox read — what opening the list means. */
  app.post<{ Body: { id?: string } }>('/v1/notifications/read', guarded, async (request) => {
    await markRead(request.guestId!, request.body?.id ?? null, ctx.clock.now());
    return { unread: await unreadCount(request.guestId!) };
  });

  app.get('/v1/notifications/preferences', guarded, async (request) =>
    preferences(request.guestId!),
  );

  app.patch<{ Body: { push?: boolean; sms?: boolean; marketing?: boolean } }>(
    '/v1/notifications/preferences',
    guarded,
    async (request) => {
      const body = request.body ?? {};
      const edit: { push?: boolean; sms?: boolean; marketing?: boolean } = {};
      if (typeof body.push === 'boolean') edit.push = body.push;
      if (typeof body.sms === 'boolean') edit.sms = body.sms;
      if (typeof body.marketing === 'boolean') edit.marketing = body.marketing;
      return setPreferences(request.guestId!, edit, ctx.clock.now());
    },
  );

  app.post<{ Body: { push_token?: string; platform?: string; label?: string } }>(
    '/v1/notifications/devices',
    guarded,
    async (request, reply) => {
      const token = request.body?.push_token;
      const platform = request.body?.platform;
      if (!token || (platform !== 'ios' && platform !== 'android' && platform !== 'web')) {
        return badRequest(
          reply,
          'Төхөөрөмжийн мэдээлэл дутуу байна.',
          'push_token and platform are required',
        );
      }
      await registerDevice({
        guestId: request.guestId!,
        platform,
        pushToken: token,
        label: request.body?.label ?? null,
        at: ctx.clock.now(),
      });
      return { registered: true };
    },
  );

  app.post<{ Body: { push_token?: string } }>(
    '/v1/notifications/devices/revoke',
    guarded,
    async (request, reply) => {
      const token = request.body?.push_token;
      if (!token) return badRequest(reply, 'Төхөөрөмж заагаагүй байна.', 'push_token is required');
      await revokeDevice(request.guestId!, token, ctx.clock.now());
      return { revoked: true };
    },
  );
}
