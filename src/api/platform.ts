import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthError,
  ClosureError,
  attachEmail,
  changePassword,
  closeAccount,
  hasPassword,
  profileOf,
  revokeOtherSessions,
  revokeSession,
  sendAttachCode,
  sendFirstPasswordCode,
  sessionsOf,
  updateProfile,
  type Profile,
} from '../platform/identity/index.js';
import {
  LedgerError,
  balance,
  movement,
  settleTopup,
  startTopup,
  wallet,
} from '../platform/ledger/index.js';
import { liveOrderCount } from '../services/orders.js';
import {
  dismiss,
  inbox,
  markRead,
  preferences,
  registerActivityToken,
  registerDevice,
  revokeDevice,
  setPreferences,
  unreadCount,
} from '../platform/notify/index.js';
import { addEmailFirst, badRequest, leaveTheDeskFirst, noSuchSession, sendError, signInAgain } from './errors.js';
import { limits } from './hardening.js';
import { deskSeatFor, seatedAtTheDesk } from './ops.js';
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

/**
 * A field that should be text, or nothing. A code sent as a number, a
 * password as an object: a client's mistake, answered as a missing field —
 * never a crash that reads «Алдаа гарлаа».
 */
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * A refusal about a password, inside the account. The same as anywhere,
 * except NO_EMAIL, which at the door means a number with no address and
 * here an account that must add one first (`addEmailFirst`).
 */
const insideTheAccount = (reply: FastifyReply, error: unknown): FastifyReply =>
  error instanceof AuthError && error.code === 'NO_EMAIL' ? addEmailFirst(reply) : sendError(reply, error);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOPUP_MNT = 2_000_000;
const MIN_TOPUP_MNT = 1_000;

const shape = (profile: Profile) => ({
  id: profile.guestId,
  phone: profile.phone,
  email: profile.email,
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
  const rate = limits();

  /**
   * Basu's desk takes a session signed in within the last
   * `DESK_SESSION_HOURS`, and what an older one does to the account must
   * not undo that. Whoever holds a desk member's session left open
   * somewhere could give the account a password, or an address, of their
   * own, sign in afresh with it and have the desk again — the way in
   * outlasting the session. Or sign the person out of the desk they are at
   * now, from wherever they are, and close the account under their seat.
   * So a desk member on such a session signs in again before any of these,
   * old password in hand or not: it is one sign-in, and nothing is left to
   * weigh. `then` is what the refusal tells them to do once they have.
   * Everybody else keeps the sixty days a session lives. The desk is
   * Basu's own staff, not a vertical: asking it here answers a guest who
   * has only ever taken a taxi exactly as before.
   */
  const recentAtTheDesk =
    (then: string): Guard =>
    async (request, reply) =>
      (await deskSeatFor(ctx, bearer(request) ?? undefined)).stale
        ? signInAgain(reply, `Аюулгүй байдлын үүднээс гараад дахин нэвтэрсний дараа ${then}.`)
        : undefined;
  /** For the ways back in, below. */
  const wayIn = recentAtTheDesk('нууц үг, имэйлээ тохируулна уу');

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
    const [balanceMnt, unread, password] = await Promise.all([balance(guestId), unreadCount(guestId), hasPassword(guestId)]);
    return { ...shape(profile), has_password: password, wallet: { balance_mnt: balanceMnt, currency: 'MNT' }, unread };
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

  /* ── the ways back in ─────────────────────────────────────────────── */

  /**
   * A password: changed knowing the old one, or — for an account made by an
   * address, Google or Apple, which has none — set with the code a letter to
   * the account's own address carried (`/v1/me/password/code`). Never on the
   * session's word alone: a session is only something somebody holds, and
   * one left open in a borrowed browser would give its holder a way in that
   * outlives it. Every other session ends — whoever knew the old one is out —
   * and the one in hand stays. The address hears of it; for a desk member,
   * whatever the day's count of letters says (`seatedAtTheDesk`).
   */
  app.post<{ Body: { current?: unknown; next?: unknown; code?: unknown } }>(
    '/v1/me/password',
    { preHandler: [requireGuest, wayIn], config: { rateLimit: rate.otp } },
    async (request, reply) => {
      const { current, next, code } = request.body ?? {};
      if (typeof next !== 'string' || !next) return badRequest(reply, 'Шинэ нууц үгээ оруулна уу.', 'next is required');
      try {
        await changePassword(ctx, {
          guestId: request.guestId!,
          current: text(current),
          next,
          code: text(code)?.trim() || null,
          alwaysTold: seatedAtTheDesk,
        });
        const revoked = await revokeOtherSessions(request.guestId!, bearer(request) ?? '', ctx.clock.now());
        return { changed: true, revoked };
      } catch (error) {
        return insideTheAccount(reply, error);
      }
    },
  );

  /**
   * The code for a first password, to the address on the account and never
   * to one the request names. `to` says where it went. It is the first half
   * of setting that password, so a desk seat on a stale session is sent to
   * sign in again here already, not after its owner has read the letter.
   */
  app.post('/v1/me/password/code', { preHandler: [requireGuest, wayIn], config: { rateLimit: rate.otp } }, async (request, reply) => {
    try {
      const { sentTo } = await sendFirstPasswordCode(ctx, { guestId: request.guestId! });
      return reply.status(202).send({ sent: true, to: sentTo });
    } catch (error) {
      return insideTheAccount(reply, error);
    }
  });

  /**
   * An address, for an account that has none — the way back when a password
   * is forgotten. A code goes to it first. Before that the session shows it
   * is still its person, so a stolen one cannot give itself a way back: an
   * account with a password types it, one without has signed in a moment ago.
   */
  app.post<{ Body: { email?: unknown; password?: unknown } }>(
    '/v1/me/email/code',
    { preHandler: [requireGuest, wayIn], config: { rateLimit: rate.otp } },
    async (request, reply) => {
      const email = text(request.body?.email);
      if (!email) return badRequest(reply, 'Имэйл хаягаа оруулна уу.', 'email is required');
      try {
        await sendAttachCode(ctx, { guestId: request.guestId!, email, password: text(request.body?.password), token: bearer(request) });
        return reply.status(202).send({ sent: true });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Body: { email?: unknown; code?: unknown } }>(
    '/v1/me/email',
    { preHandler: [requireGuest, wayIn], config: { rateLimit: rate.verify } },
    async (request, reply) => {
      const email = text(request.body?.email);
      const code = text(request.body?.code);
      if (!email || !code) return badRequest(reply, 'Имэйл, кодоо оруулна уу.', 'email and code are required');
      try {
        await attachEmail(ctx, { guestId: request.guestId!, email, code: code.trim() });
        const profile = await profileOf(request.guestId!);
        return profile ? shape(profile) : sendError(reply, new Error('profile missing'));
      } catch (error) {
        return sendError(reply, error);
      }
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
      mid-panic is the wrong end of the tool. A desk member's session the
      desk no longer takes signs in again first (`recentAtTheDesk`). */
  app.post(
    '/v1/me/sessions/revoke',
    { preHandler: [requireGuest, recentAtTheDesk('бусад төхөөрөмжөөсөө гарна уу')] },
    async (request) => {
      const revoked = await revokeOtherSessions(
        request.guestId!,
        bearer(request) ?? '',
        ctx.clock.now(),
      );
      return { revoked };
    },
  );

  /**
   * One session, by its id in the list. Ending the one that asks is
   * signing out here, and nobody is refused that: the app signs out this
   * way, and a session the desk no longer takes is exactly one its person
   * must be able to end. Ending any other is signing somebody out, and a
   * desk member's session that old signs in again first, as above.
   */
  const endingAnother = recentAtTheDesk('тэр төхөөрөмжөөс гарна уу');
  const recentUnlessHere: Guard = async (request, reply) => {
    const id = String((request.params as { id?: unknown }).id ?? '').toLowerCase();
    const here = (await sessionsOf(request.guestId!, bearer(request) ?? '')).some((s) => s.current && s.id === id);
    return here ? undefined : endingAnother(request, reply);
  };

  app.delete<{ Params: { id: string } }>(
    '/v1/me/sessions/:id',
    { preHandler: [requireGuest, recentUnlessHere] },
    async (request, reply) => {
      // The same answer for an id that is nobody's and one that is not an id: never a question put to Postgres.
      if (!UUID.test(request.params.id)) return noSuchSession(reply);
      const gone = await revokeSession(request.guestId!, request.params.id, ctx.clock.now());
      if (!gone) return noSuchSession(reply);
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
   *
   * Refused, too, for an account that sits at Basu's desk in a seat that is
   * on, whatever the session: closing it would take its person off the desk
   * past every rule «Гишүүд» keeps, and leave the seat on over an account
   * nobody can sign in to. The seat is switched off there first, by somebody
   * who may — the desk's own close asks the same (`mayActOnAccount`). Asked
   * before the desk's twelve hours, because it is the true answer whatever
   * the session's age; the twelve hours stand behind it, as for every
   * change here that outlasts the session.
   */
  const notAtTheDesk: Guard = async (request, reply) =>
    (await seatedAtTheDesk(request.guestId!)) ? leaveTheDeskFirst(reply) : undefined;

  app.delete('/v1/me', { preHandler: [requireGuest, notAtTheDesk, recentAtTheDesk('бүртгэлээ хаана уу')] }, async (request, reply) => {
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
   *
   * Somebody else's movement, nobody's, and an id that is not one are the
   * same answer: nothing of theirs by that name. The last is never a
   * question put to Postgres.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/wallet/:id',
    guarded,
    async (request, reply) => {
      const line = UUID.test(request.params.id) ? await movement(request.guestId!, request.params.id) : null;
      if (!line) return sendError(reply, new LedgerError('NOT_FOUND', 'no such movement'));
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

  /**
   * No id marks the whole inbox read — what opening the list means. An id
   * that is not a message's marks nothing, as the swipe below removes
   * nothing, and is never Postgres's to read.
   */
  app.post<{ Body: { id?: unknown } }>('/v1/notifications/read', guarded, async (request) => {
    const id = request.body?.id ?? null;
    if (id === null || (typeof id === 'string' && UUID.test(id))) {
      await markRead(request.guestId!, id, ctx.clock.now());
    }
    return { unread: await unreadCount(request.guestId!) };
  });

  /**
   * The swipe. 204 whether or not the row was there: the guest wants it gone,
   * and it is. A message that was never theirs is simply not found to remove.
   */
  app.delete<{ Params: { id: string } }>(
    '/v1/notifications/:id',
    guarded,
    async (request, reply) => {
      // A non-uuid would make Postgres throw rather than find nothing.
      if (UUID.test(request.params.id)) {
        await dismiss(request.guestId!, request.params.id, ctx.clock.now());
      }
      return reply.code(204).send();
    },
  );

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

  /**
   * ActivityKit's push token for one order's Live Activity. Stored so the
   * lock screen can be moved without the app; sending to it is the relay's job
   * once APNs credentials exist, and until then the phone updates its own
   * activity on every poll.
   */
  app.post<{ Params: { id: string }; Body: { push_token?: string } }>(
    '/v1/activities/:id/token',
    guarded,
    async (request, reply) => {
      const token = request.body?.push_token;
      if (!token) return badRequest(reply, 'Токен заагаагүй байна.', 'push_token is required');
      await registerActivityToken({
        guestId: request.guestId!,
        subject: 'order',
        subjectId: request.params.id,
        pushToken: token,
        at: ctx.clock.now(),
      });
      return reply.code(204).send();
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
