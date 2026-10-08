import { getPool } from '../../db/pool.js';
import { PushTokenGone, type Ctx } from '../../ports.js';
import { enqueue } from '../notify/index.js';
import { callKey, guestKey, wake } from './hub.js';

/**
 * A call, from the ring to the hang-up.
 *
 * The voice never comes here. What comes here is the handshake two phones
 * need before they can find each other — the caller's offer, the answer of
 * whoever picks up — and the state the screens on both sides draw:
 *
 *   ringing ─┬─ answered ── ended
 *            ├─ declined      (the person rung said no)
 *            ├─ cancelled     (the caller hung up first)
 *            └─ missed        (nobody answered in RING_SECONDS)
 *
 * Who may ring whom, and about what, is the caller's business: an идэш
 * order knows its guest and its supplier's people; this module is handed
 * the list and does not ask why.
 */

export const RING_SECONDS = 45;
/** A call still «answered» after this was left open by two phones that died. */
export const MAX_CALL_MINUTES = 120;
/** A session description is a few kilobytes; anything near this is not one. */
export const SDP_MAX = 20_000;

export type CallState = 'ringing' | 'answered' | 'ended' | 'declined' | 'missed' | 'cancelled';

export type CallErrorCode = 'NOT_FOUND' | 'CLOSED' | 'OUT_OF_WINDOW' | 'IN_PROGRESS' | 'TAKEN' | 'OVER' | 'BAD_INPUT' | 'NO_ONE';

export class CallError extends Error {
  constructor(
    readonly code: CallErrorCode,
    message: string,
    /** With IN_PROGRESS: the call already going on, which the screen can join. */
    readonly callId?: string,
  ) {
    super(message);
  }
}

export interface Call {
  id: string;
  subject: string;
  subjectId: string;
  about: string;
  callerId: string;
  callees: string[];
  callerName: string;
  calleeName: string;
  state: CallState;
  offer: string | null;
  answer: string | null;
  answeredBy: string | null;
  version: number;
  createdAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  endedBy: string | null;
  endReason: string | null;
}

interface Row {
  id: string;
  subject: string;
  subject_id: string;
  about: string;
  caller_id: string;
  callees: string[];
  caller_name: string;
  callee_name: string;
  state: CallState;
  offer: string | null;
  answer: string | null;
  answered_by: string | null;
  version: number;
  created_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
  ended_by: string | null;
  end_reason: string | null;
}

const COLUMNS = `id, subject, subject_id, about, caller_id, callees, caller_name, callee_name, state, offer, answer,
  answered_by, version, created_at, answered_at, ended_at, ended_by, end_reason`;

const shape = (r: Row): Call => ({
  id: r.id,
  subject: r.subject,
  subjectId: r.subject_id,
  about: r.about,
  callerId: r.caller_id,
  callees: r.callees,
  callerName: r.caller_name,
  calleeName: r.callee_name,
  state: r.state,
  offer: r.offer,
  answer: r.answer,
  answeredBy: r.answered_by,
  version: r.version,
  createdAt: r.created_at,
  answeredAt: r.answered_at,
  endedAt: r.ended_at,
  endedBy: r.ended_by,
  endReason: r.end_reason,
});

export const isLive = (state: CallState) => state === 'ringing' || state === 'answered';

/** Everybody a change to this call matters to: its own screen, and every list it rings on. */
function touched(call: Call): void {
  wake(callKey(call.id), guestKey(call.callerId), ...call.callees.map(guestKey));
}

export function isSdp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SDP_MAX && value.startsWith('v=0');
}

export async function startCall(
  ctx: Ctx,
  input: {
    subject: string;
    subjectId: string;
    about: string;
    callerId: string;
    callees: readonly string[];
    callerName: string;
    calleeName: string;
    offer: string;
  },
): Promise<Call> {
  const now = ctx.clock.now();
  // A ring nobody answered a minute ago must not hold this order's one line.
  await settleCalls(ctx);
  const callees = [...new Set(input.callees)].filter((id) => id !== input.callerId);
  if (callees.length === 0) throw new CallError('NO_ONE', 'there is nobody to ring');
  let row: Row;
  try {
    const { rows } = await getPool().query<Row>(
      `INSERT INTO call.call (subject, subject_id, about, caller_id, callees, caller_name, callee_name, state, offer, created_at)
       VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, 'ringing', $8, $9)
       RETURNING ${COLUMNS}`,
      [input.subject, input.subjectId, input.about, input.callerId, callees, input.callerName, input.calleeName, input.offer, now],
    );
    row = rows[0]!;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id FROM call.call WHERE subject = $1 AND subject_id = $2 AND state IN ('ringing', 'answered')`,
        [input.subject, input.subjectId],
      );
      throw new CallError('IN_PROGRESS', 'a call about this is already going on', rows[0]?.id);
    }
    throw error;
  }
  const call = shape(row);
  touched(call);
  await ring(ctx, call);
  // In production nothing else would notice a ring that ran out while nobody
  // was asking; the missed-call message must not wait for the next caller.
  const sweep = setTimeout(() => void settleCalls(ctx).catch(() => undefined), (RING_SECONDS + 1) * 1000);
  sweep.unref?.();
  return call;
}

/**
 * Wakes every phone rung that can be woken: an iPhone through PushKit, an
 * Android phone through Firebase. A phone that cannot be woken still sees
 * the ring when its app is open.
 */
async function ring(ctx: Ctx, call: Call): Promise<void> {
  const [voip, fcm] = await Promise.all([ringTokensOf(call.callees, 'voip'), ringTokensOf(call.callees, 'fcm')]);
  const expiresAt = new Date(call.createdAt.getTime() + RING_SECONDS * 1000);
  const said = {
    call_id: call.id,
    caller_name: call.callerName,
    about: call.about,
    subject: call.subject,
    subject_id: call.subjectId,
  };
  const attempt = async (token: string, send: () => Promise<unknown>) => {
    try {
      await send();
    } catch (error) {
      if (error instanceof PushTokenGone) await forgetRingToken(token);
      else console.error('[call] ring push failed', error instanceof Error ? error.name : typeof error);
    }
  };
  await Promise.all([
    ...voip.map(({ token }) => attempt(token, () => ctx.notifier.pushVoip({ token, expiresAt, payload: said }))),
    ...fcm.map(({ token }) => attempt(token, () => ctx.notifier.pushData({ token, ttlSeconds: RING_SECONDS, data: { type: 'call', ...said } }))),
  ]);
}

/** The call, if this person is in it: its caller, or anybody it rang. */
export async function callFor(id: string, guestId: string): Promise<Call | null> {
  const { rows } = await getPool().query<Row>(
    `SELECT ${COLUMNS} FROM call.call WHERE id = $1 AND (caller_id = $2 OR $2 = ANY(callees))`,
    [id, guestId],
  );
  return rows[0] ? shape(rows[0]) : null;
}

/** Calls ringing this person right now, oldest first. */
export async function ringingFor(guestId: string): Promise<Call[]> {
  const { rows } = await getPool().query<Row>(
    `SELECT ${COLUMNS} FROM call.call WHERE state = 'ringing' AND $1 = ANY(callees) ORDER BY created_at`,
    [guestId],
  );
  return rows.map(shape);
}

/** The first to answer takes the call; anybody after is told it was taken. */
export async function answerCall(ctx: Ctx, id: string, guestId: string, answer: string): Promise<Call> {
  await settleCalls(ctx);
  const { rows } = await getPool().query<Row>(
    `UPDATE call.call SET state = 'answered', answer = $3, answered_by = $2, answered_at = $4, version = version + 1
      WHERE id = $1 AND state = 'ringing' AND $2 = ANY(callees)
      RETURNING ${COLUMNS}`,
    [id, guestId, answer, ctx.clock.now()],
  );
  if (rows[0]) {
    const call = shape(rows[0]);
    touched(call);
    return call;
  }
  const call = await callFor(id, guestId);
  if (!call || call.callerId === guestId) throw new CallError('NOT_FOUND', 'no such call ringing you');
  if (call.state === 'answered') throw new CallError('TAKEN', 'somebody else answered');
  throw new CallError('OVER', 'the call is over');
}

/**
 * Hanging up, whoever does it and whenever: the caller before an answer
 * cancels, the person rung declines, either of the two talking ends it.
 * Somebody rung who did not pick up, hanging up after it was answered
 * elsewhere, changes nothing. Saying it twice is saying it once.
 */
export async function endCall(ctx: Ctx, id: string, guestId: string): Promise<Call> {
  await settleCalls(ctx);
  const call = await callFor(id, guestId);
  if (!call) throw new CallError('NOT_FOUND', 'no such call of yours');
  let next: { state: CallState; reason: string } | null = null;
  if (call.state === 'ringing') next = call.callerId === guestId ? { state: 'cancelled', reason: 'cancelled' } : { state: 'declined', reason: 'declined' };
  else if (call.state === 'answered' && (call.callerId === guestId || call.answeredBy === guestId)) next = { state: 'ended', reason: 'hangup' };
  if (!next) return call;
  const { rows } = await getPool().query<Row>(
    `UPDATE call.call SET state = $3, end_reason = $4, ended_by = $5, ended_at = $6, offer = NULL, answer = NULL, version = version + 1
      WHERE id = $1 AND state = $2
      RETURNING ${COLUMNS}`,
    [id, call.state, next.state, next.reason, guestId, ctx.clock.now()],
  );
  // Moved under us — answered, or ended by the other side — between the read and the write.
  if (!rows[0]) return endCall(ctx, id, guestId);
  const ended = shape(rows[0]);
  touched(ended);
  if (ended.state === 'cancelled') await tellMissed(ctx, ended);
  return ended;
}

/**
 * Ends what time has ended: a ring nobody answered, a call two phones left
 * open. Cheap — a partial index holds only live calls — so it runs before
 * every change, and on a timer after every ring.
 */
export async function settleCalls(ctx: Ctx): Promise<Call[]> {
  const now = ctx.clock.now();
  const { rows } = await getPool().query<Row>(
    `UPDATE call.call
        SET state = CASE WHEN state = 'ringing' THEN 'missed' ELSE 'ended' END,
            end_reason = CASE WHEN state = 'ringing' THEN 'no_answer' ELSE 'too_long' END,
            ended_at = $1, offer = NULL, answer = NULL, version = version + 1
      WHERE state IN ('ringing', 'answered')
        AND ((state = 'ringing' AND created_at <= $1::timestamptz - make_interval(secs => $2))
          OR (state = 'answered' AND answered_at <= $1::timestamptz - make_interval(mins => $3)))
      RETURNING ${COLUMNS}`,
    [now, RING_SECONDS, MAX_CALL_MINUTES],
  );
  const settled = rows.map(shape);
  for (const call of settled) {
    touched(call);
    if (call.state === 'missed') await tellMissed(ctx, call);
  }
  return settled;
}

/** A ring that was not picked up stays in the inbox, so it can be returned. */
async function tellMissed(ctx: Ctx, call: Call): Promise<void> {
  for (const guestId of call.callees) {
    await enqueue(ctx, {
      guestId,
      subject: call.subject,
      subjectId: call.subjectId,
      template: 'call.missed',
      channel: 'push',
      dedupeKey: `call:${call.id}:missed:${guestId}`,
      title: 'Аваагүй дуудлага',
      body: `${call.callerName} танд залгасан — ${call.about}.`,
    });
  }
}

/* ── how a phone is woken ── */

export type RingKind = 'voip' | 'fcm';

/** A token that turns up under somebody else — a shared phone, a new sign-in — rings them now. */
export async function registerRingToken(guestId: string, kind: RingKind, token: string, now: Date): Promise<void> {
  await getPool().query(
    `INSERT INTO call.ring_token (guest_id, kind, token, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (kind, token) DO UPDATE SET guest_id = EXCLUDED.guest_id, updated_at = EXCLUDED.updated_at`,
    [guestId, kind, token, now],
  );
}

/** Signing out of a phone: it rings for this person no more. */
export async function revokeRingToken(guestId: string, token: string): Promise<void> {
  await getPool().query('DELETE FROM call.ring_token WHERE guest_id = $1 AND token = $2', [guestId, token]);
}

async function forgetRingToken(token: string): Promise<void> {
  await getPool().query('DELETE FROM call.ring_token WHERE token = $1', [token]);
}

export async function ringTokensOf(guestIds: readonly string[], kind: RingKind): Promise<Array<{ guestId: string; token: string }>> {
  if (guestIds.length === 0) return [];
  const { rows } = await getPool().query<{ guest_id: string; token: string }>(
    'SELECT guest_id, token FROM call.ring_token WHERE kind = $1 AND guest_id = ANY($2::uuid[])',
    [kind, [...guestIds]],
  );
  return rows.map((r) => ({ guestId: r.guest_id, token: r.token }));
}
