import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  APP_RETURN,
  AuthError,
  appleConfigFromEnv,
  beginGoogle,
  claimHandoff,
  completeGoogle,
  endSession,
  googleConfigFromEnv,
  handOff,
  safeReturn,
  sendEmailCode,
  sendPasswordCode,
  setPasswordWithCode,
  signInWithApple,
  startSessionFor,
  takeGoogleState,
  verifyEmailCode,
} from '../platform/identity/index.js';
import type { Ctx } from '../ports.js';
import { badRequest, sendError } from './errors.js';
import { limits } from './hardening.js';

/**
 * The ways in that do not need a phone: a code by email, Google, Apple — and
 * a password, which is set only by proving an inbox (see `register.ts`).
 *
 * Google is a redirect: `/v1/auth/google/start` sends the person to Google
 * with a state we remember, Google sends them back to `/callback`, and we
 * send them on to the page they started from with a one-time code in the
 * URL's fragment — `/supplier#auth_code=…` — never the session. A fragment
 * stays out of every request and every server log, but not out of the
 * browser's history, which keeps the address as it was visited and syncs
 * it to the person's other devices. The page trades the code for the
 * session at `/v1/auth/handoff`, together with a cookie set here, so the
 * code is good once, for a minute, and only in the browser that went to
 * Google.
 *
 * The iPhone app goes through the system sign-in sheet and gets
 * `basu://auth#auth=…` — the session itself, as the builds on phones expect.
 * The sheet hands that address straight to the app; no page ever loads it,
 * so no history keeps it.
 *
 * The state is also written into a short-lived cookie at the start and must
 * match at the callback, so that nobody can sign a stranger into an account
 * of the attacker's choosing by getting them to open a callback link.
 */

const STATE_COOKIE = 'basu_oauth';
/** The binding a page's code is good only with, in the browser the callback sent it to. */
const HANDOFF_COOKIE = 'basu_handoff';

function cookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      // Nothing we set is spelled like that: the same as no cookie, not a crash.
      return null;
    }
  }
  return null;
}

const shapeSession = (s: { token: string; guestId: string; expiresAt: Date }) => ({
  token: s.token,
  guest_id: s.guestId,
  expires_at: s.expiresAt.toISOString(),
});

/** Where to go afterwards, with the outcome in the fragment and any cookie that goes with it. */
function back(reply: FastifyReply, returnTo: string, fragment: Record<string, string>, cookies: string[] = []): FastifyReply {
  const hash = new URLSearchParams(fragment).toString();
  const target = returnTo === APP_RETURN ? `${APP_RETURN}#${hash}` : `${safeReturn(returnTo)}#${hash}`;
  return reply
    .header('set-cookie', [`${STATE_COOKIE}=; Path=/v1/auth/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, ...cookies])
    .header('cache-control', 'no-store')
    .redirect(target, 302);
}

/** The handoff's cookie: sent only to the one address that claims it, and gone soon after the code is. */
const handoffCookie = (binding: string, maxAge = 120) =>
  `${HANDOFF_COOKIE}=${binding}; Path=/v1/auth/handoff; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

export async function registerAuthRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const rate = limits();

  /** Which doors this server has open, so a page shows only those. */
  app.get('/v1/auth/methods', async () => ({
    password: true,
    email: Boolean(ctx.mailer),
    google: Boolean(googleConfigFromEnv()),
    apple: true,
  }));

  /**
   * Signing out: the session that asks ends on the server, and nothing else
   * does. The same answer whether or not there was one to end, so it tells
   * nobody anything about a token they try.
   */
  app.post('/v1/auth/sign-out', async (request, reply) => {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) await endSession(header.slice(7), ctx.clock.now());
    return reply.status(204).send();
  });

  /* ── a code by email ── */

  app.post<{ Body: { email?: string } }>('/v1/auth/email/start', { config: { rateLimit: rate.otp } }, async (request, reply) => {
    const email = request.body?.email;
    if (!email) return badRequest(reply, 'Имэйл хаягаа оруулна уу.', 'email is required');
    try {
      // The code goes by email and is never returned in the response body.
      await sendEmailCode(ctx, email);
      return reply.status(202).send({ sent: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Body: { email?: string; code?: string; device?: string } }>(
    '/v1/auth/email/verify',
    { config: { rateLimit: rate.verify } },
    async (request, reply) => {
      const { email, code, device } = request.body ?? {};
      if (!email || !code) return badRequest(reply, 'Имэйл, кодоо оруулна уу.', 'email and code are required');
      try {
        return reply.send(shapeSession(await verifyEmailCode(ctx, email, code.trim(), device ?? null)));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /* ── a password, by way of a code to an inbox ── */

  /**
   * A code for setting a password: `sign_up` for a new account by email,
   * `reset` for a forgotten one, named by its address or its phone number.
   * `to` says where the letter went — masked when only a number was typed.
   */
  app.post<{ Body: { login?: string; purpose?: string } }>(
    '/v1/auth/password/code',
    { config: { rateLimit: rate.otp } },
    async (request, reply) => {
      const login = request.body?.login?.trim();
      const purpose = request.body?.purpose ?? 'reset';
      if (!login) return badRequest(reply, 'Имэйл эсвэл утасны дугаараа оруулна уу.', 'login is required');
      if (purpose !== 'sign_up' && purpose !== 'reset') {
        return badRequest(reply, 'Хүсэлт буруу байна.', 'purpose must be sign_up or reset');
      }
      try {
        const { sentTo } = await sendPasswordCode(ctx, { login, purpose });
        return reply.status(202).send({ sent: true, to: sentTo });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /**
   * The code, the password, and a session. `created` says whether an account
   * was made — false means the address already had one, now with this password.
   */
  app.post<{ Body: { login?: string; code?: string; password?: string; name?: string; device?: string } }>(
    '/v1/auth/password',
    { config: { rateLimit: rate.verify } },
    async (request, reply) => {
      const { code, password, name, device } = request.body ?? {};
      const login = request.body?.login?.trim();
      if (!login || !code || !password) {
        return badRequest(reply, 'Код, шинэ нууц үгээ оруулна уу.', 'login, code and password are required');
      }
      try {
        const { session, created } = await setPasswordWithCode(ctx, {
          login,
          code: code.trim(),
          password,
          name: name ?? null,
          device: device ?? null,
        });
        return reply.status(created ? 201 : 200).send({ ...shapeSession(session), created });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /* ── Google ── */

  app.get<{ Querystring: { return?: string } }>(
    '/v1/auth/google/start',
    { config: { rateLimit: rate.otp } },
    async (request, reply) => {
      const google = googleConfigFromEnv();
      const returnTo = safeReturn(request.query.return);
      if (!google) return back(reply, returnTo, { auth_error: 'SOCIAL_CLOSED' });
      const { url, state } = await beginGoogle(google, returnTo, ctx.clock.now());
      return reply
        .header('set-cookie', `${STATE_COOKIE}=${encodeURIComponent(state)}; Path=/v1/auth/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax`)
        .header('cache-control', 'no-store')
        .redirect(url, 302);
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/v1/auth/google/callback',
    { config: { rateLimit: rate.verify } },
    async (request, reply) => {
      const google = googleConfigFromEnv();
      const { code, state, error } = request.query;
      if (!google) return back(reply, '/', { auth_error: 'SOCIAL_CLOSED' });

      // The state is spent here, first, whatever happens next: where to send
      // the person back to lives with it, and a state seen once is never
      // good again.
      const pending = state ? await takeGoogleState(state, ctx.clock.now()) : null;
      if (!pending) return back(reply, '/', { auth_error: 'SOCIAL_REFUSED' });

      // The person pressed «Cancel» at Google, or Google refused.
      if (error || !code) {
        return back(reply, pending.returnTo, { auth_error: error === 'access_denied' ? 'CANCELLED' : 'SOCIAL_REFUSED' });
      }
      // Started in this browser, or not at all.
      if (cookie(request, STATE_COOKIE) !== state) {
        return back(reply, pending.returnTo, { auth_error: 'SOCIAL_REFUSED' });
      }
      try {
        const guestId = await completeGoogle(ctx, google, { code, verifier: pending.verifier });
        // The app: the session itself, where the builds on phones read it.
        if (pending.returnTo === APP_RETURN) {
          const session = await startSessionFor(ctx, guestId, 'Google');
          return back(reply, APP_RETURN, { auth: session.token });
        }
        // A page: a code for the session, and the cookie it is good only with.
        const handoff = await handOff(guestId, 'Google', ctx.clock.now());
        return back(reply, pending.returnTo, { auth_code: handoff.code }, [handoffCookie(handoff.binding)]);
      } catch (caught) {
        request.log.warn({ err: caught }, 'google sign-in refused');
        const reason = caught instanceof AuthError ? caught.code : 'SOCIAL_REFUSED';
        return back(reply, pending.returnTo, { auth_error: reason });
      }
    },
  );

  /**
   * The page's half of a Google sign-in: the code from its address, and the
   * cookie the callback set in this browser. A session, once, answered like
   * every other way in. The cookie has done its one job whatever the answer,
   * and goes.
   */
  app.post<{ Body: { code?: unknown } }>('/v1/auth/handoff', { config: { rateLimit: rate.verify } }, async (request, reply) => {
    reply.header('set-cookie', handoffCookie('', 0));
    const code = typeof request.body?.code === 'string' ? request.body.code : '';
    try {
      return reply.send(shapeSession(await claimHandoff(ctx, { code, binding: cookie(request, HANDOFF_COOKIE) })));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ── Apple, from the iPhone app ── */

  app.post<{ Body: { identity_token?: string; nonce?: string; name?: string; device?: string } }>(
    '/v1/auth/apple',
    { config: { rateLimit: rate.verify } },
    async (request, reply) => {
      const { identity_token: identityToken, nonce, name, device } = request.body ?? {};
      if (!identityToken || !nonce) {
        return badRequest(reply, 'Apple-аас ирсэн токен алга.', 'identity_token and nonce are required');
      }
      try {
        const session = await signInWithApple(ctx, appleConfigFromEnv(), {
          identityToken,
          nonce,
          name: name ?? null,
          label: device ?? 'iPhone · Apple',
        });
        return reply.send(shapeSession(session));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
