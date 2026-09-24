import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  APP_RETURN,
  AuthError,
  appleConfigFromEnv,
  beginGoogle,
  completeGoogle,
  googleConfigFromEnv,
  safeReturn,
  sendEmailCode,
  signInWithApple,
  takeGoogleState,
  verifyEmailCode,
} from '../platform/identity/index.js';
import type { Ctx } from '../ports.js';
import { badRequest, sendError } from './errors.js';
import { limits } from './hardening.js';

/**
 * The ways in that do not need a phone: a code by email, Google, Apple.
 *
 * Google is a redirect: `/v1/auth/google/start` sends the person to Google
 * with a state we remember, Google sends them back to `/callback`, and we
 * send them on to the page they started from with the session in the URL's
 * fragment — `/supplier#auth=…`. A fragment never reaches a server or its
 * logs; the page takes the token and wipes it from the address bar. The
 * iPhone app does the same through the system sign-in sheet, and gets
 * `basu://auth#auth=…` back.
 *
 * The state is also written into a short-lived cookie at the start and must
 * match at the callback, so that nobody can sign a stranger into an account
 * of the attacker's choosing by getting them to open a callback link.
 */

const STATE_COOKIE = 'basu_oauth';

function cookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

const shapeSession = (s: { token: string; guestId: string; expiresAt: Date }) => ({
  token: s.token,
  guest_id: s.guestId,
  expires_at: s.expiresAt.toISOString(),
});

/** Where to go afterwards, with the outcome in the fragment. */
function back(reply: FastifyReply, returnTo: string, fragment: Record<string, string>): FastifyReply {
  const hash = new URLSearchParams(fragment).toString();
  const target = returnTo === APP_RETURN ? `${APP_RETURN}#${hash}` : `${safeReturn(returnTo)}#${hash}`;
  return reply
    .header('set-cookie', `${STATE_COOKIE}=; Path=/v1/auth/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
    .header('cache-control', 'no-store')
    .redirect(target, 302);
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const rate = limits();

  /** Which doors this server has open, so a page shows only those. */
  app.get('/v1/auth/methods', async () => ({
    password: true,
    email: Boolean(ctx.mailer),
    google: Boolean(googleConfigFromEnv()),
    apple: true,
  }));

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
        const session = await completeGoogle(ctx, google, { code, verifier: pending.verifier, label: 'Google' });
        return back(reply, pending.returnTo, { auth: session.token });
      } catch (caught) {
        request.log.warn({ err: caught }, 'google sign-in refused');
        const reason = caught instanceof AuthError ? caught.code : 'SOCIAL_REFUSED';
        return back(reply, pending.returnTo, { auth_error: reason });
      }
    },
  );

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
