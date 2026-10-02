import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db/pool.js';
import type { Ctx } from '../ports.js';

/**
 * Idempotency, because a phone on a patchy connection retries and a guest
 * double-taps. Same key, same answer — never a second order.
 *
 * Kept in Postgres rather than in this process: two API instances behind one
 * address do not share memory, and a retry landing on the other one would
 * order lunch twice, which is precisely what the key is for.
 *
 * An answer is kept for the one it was given to: under the session that
 * asked (its hash — the token itself is never written down), the method and
 * the address, and only then the key. A key is the client's own label, not
 * a secret, and what it was the label of may be an order, a seat at the
 * desk, a session. Kept under the label alone, it went to anybody who sent
 * the same label — without a session, before any route had asked who they
 * were. Now the same key from somebody else is simply their own request,
 * and says nothing about whether the label was ever used.
 *
 * A request without a session is nobody in particular, so nothing is kept
 * for it: the doors it can knock on hand out sessions, and one stranger's
 * answer there replayed to the next would be the first one's session.
 */

/**
 * How long a phone might plausibly still be retrying the same request.
 * Older than this and the same key means a new intention, not a repeat.
 */
const IDEMPOTENCY_TTL_HOURS = 24;

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7);
}

/** The session behind a request, as a hash; null for a request without one. */
function callerOf(request: FastifyRequest): string | null {
  const token = bearer(request);
  return token ? createHash('sha256').update(token).digest('hex') : null;
}

/**
 * Keep every successful answer to a POST that came with a key, and hand it
 * back to its caller when the same request comes again.
 *
 * Registered before any route: the replay joins each POST route's own chain
 * as its last step, after the route's guard, so it answers only a request
 * the route itself let in — a session that has ended since is refused like
 * any other.
 */
export function rememberAnswers(app: FastifyInstance, ctx: Ctx): void {
  const db = getPool();

  const replay = async (request: FastifyRequest, reply: FastifyReply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') return undefined;
    const caller = callerOf(request);
    if (!caller) return undefined;

    const { rows } = await db.query<{ status: number; content_type: string | null; body: string }>(
      `SELECT status, content_type, body FROM idempotency_answer
        WHERE caller = $1 AND method = $2 AND url = $3 AND key = $4
          AND created_at > $5::timestamptz - make_interval(hours => $6)`,
      [caller, request.method, request.url, key, ctx.clock.now(), IDEMPOTENCY_TTL_HOURS],
    );
    const hit = rows[0];
    if (!hit) return undefined;

    reply.header('idempotent-replay', 'true');
    // The content type travels with the body. Without it the replay went out
    // as text/plain and a client parsing by content-type got a string where
    // the first attempt had given it an object.
    if (hit.content_type) reply.header('content-type', hit.content_type);
    return reply.status(hit.status).send(hit.body);
  };

  // A hook on the instance would run before every route's own — that is how
  // the answer used to go out ahead of the guard — so each POST route takes
  // the replay as the last of its own instead.
  app.addHook('onRoute', (route) => {
    if (![route.method].flat().includes('POST')) return;
    route.preHandler = [route.preHandler ?? []].flat().concat(replay);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const key = request.headers['idempotency-key'];
    // Only successful responses are remembered. The key exists to stop a
    // retried request buying lunch twice — not to make a failure permanent.
    // Caching a 401 would mean a client that signs in and tries again gets
    // handed the same rejection forever.
    // Nor a 202: «under way, not done» — the purchase waiting on its invoice. Kept, the same key would be
    // handed «still waiting» for a day after the money arrived.
    if (typeof key !== 'string' || request.method !== 'POST' || reply.statusCode >= 400 || reply.statusCode === 202) {
      return payload;
    }
    // Nothing is kept for a request without a session, and a replay is kept already.
    const caller = callerOf(request);
    if (!caller || reply.getHeader('idempotent-replay')) return payload;
    await db
      .query(
        `INSERT INTO idempotency_answer (caller, method, url, key, status, content_type, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [
          caller,
          request.method,
          request.url,
          key,
          reply.statusCode,
          reply.getHeader('content-type') ?? null,
          typeof payload === 'string' ? payload : JSON.stringify(payload),
          ctx.clock.now(),
        ],
      )
      .catch(() => {});
    return payload;
  });
}

/**
 * Answers past the window a retry can come in: never handed out again, and
 * no longer anybody's to keep — an order, a seat, a person's details, each
 * as it was sent. Swept by the scheduler.
 */
export async function purgeAnswers(now: Date): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM idempotency_answer WHERE created_at <= $1::timestamptz - make_interval(hours => $2)`,
    [now, IDEMPOTENCY_TTL_HOURS],
  );
  return rowCount ?? 0;
}
