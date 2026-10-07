import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { callTermsFor } from '../idesh/index.js';
import { setting } from '../ops/index.js';
import {
  answerCall,
  callFor,
  CallError,
  callKey,
  endCall,
  guestKey,
  iceServersFor,
  isLive,
  isSdp,
  registerRingToken,
  revokeRingToken,
  RING_SECONDS,
  ringingFor,
  settleCalls,
  startCall,
  waitFor,
  type Call,
  type CallErrorCode,
} from '../platform/call/index.js';
import type { Ctx } from '../ports.js';
import { badRequest, sendError } from './errors.js';
import { knownId, UUID, type Guard } from './guards.js';
import { limits } from './hardening.js';

/**
 * Calls over HTTP: the handshake two phones make through us, and the ring.
 *
 * A screen waiting for the other side does not poll every second: it asks
 * «anything after version N?» and is held until there is, or for `wait`
 * seconds (at most MAX_WAIT_S), and then asks again. The same for a phone
 * or a desk waiting to be rung. Nothing here needs a socket, or anything of
 * nginx's beyond what an ordinary request does.
 *
 * Only идэш orders can be called about today; `subject` says so, so the
 * second thing that can be called about is a line here, not a new API.
 */
const MAX_WAIT_S = 25;

const CALL_ERRORS: Record<CallErrorCode, { status: number; mn: string }> = {
  NOT_FOUND: { status: 404, mn: 'Дуудлага олдсонгүй.' },
  CLOSED: { status: 403, mn: 'Апп доторх дуудлага одоогоор хаалттай байна.' },
  OUT_OF_WINDOW: { status: 409, mn: 'Энэ захиалгын талаар одоо залгах боломжгүй.' },
  IN_PROGRESS: { status: 409, mn: 'Энэ захиалгын талаар дуудлага явагдаж байна.' },
  TAKEN: { status: 409, mn: 'Өөр хүн дуудлагыг авсан байна.' },
  OVER: { status: 409, mn: 'Дуудлага дууссан байна.' },
  BAD_INPUT: { status: 400, mn: 'Дуудлагын мэдээлэл буруу байна.' },
  NO_ONE: { status: 409, mn: 'Залгах хүн олдсонгүй.' },
};

function refuse(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof CallError)) return sendError(reply, error);
  const spec = CALL_ERRORS[error.code];
  return reply.status(spec.status).send({
    error: { code: error.code, message_mn: spec.mn, message_en: error.message },
    // Two people ringing each other at once: the second is pointed at the first's call.
    ...(error.callId ? { call_id: error.callId } : {}),
  });
}

/** What one side of a call is shown of it — never the other side's people, only the half of the handshake it needs. */
export function shapeCall(call: Call, me: string) {
  const role = call.callerId === me ? 'caller' : 'callee';
  return {
    id: call.id,
    state: call.state,
    version: call.version,
    role,
    subject: call.subject,
    subject_id: call.subjectId,
    about: call.about,
    peer_name: role === 'caller' ? call.calleeName : call.callerName,
    offer: role === 'callee' && call.state === 'ringing' ? call.offer : null,
    answer: role === 'caller' && call.state === 'answered' ? call.answer : null,
    // At a supplier everybody is rung; this says whether it was this person who picked up.
    answered_here: call.answeredBy === me,
    ring_until: new Date(call.createdAt.getTime() + RING_SECONDS * 1000).toISOString(),
    created_at: call.createdAt.toISOString(),
    answered_at: call.answeredAt?.toISOString() ?? null,
    ended_at: call.endedAt?.toISOString() ?? null,
    end_reason: call.endReason,
  };
}

/** Whether Basu has opened calls at all, from the desk's settings. */
async function callsOpen(): Promise<boolean> {
  return Number(await setting<number>('calls_open')) >= 1;
}

function waitSeconds(raw: string | undefined): number {
  const n = raw === undefined ? MAX_WAIT_S : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_WAIT_S, n)) : MAX_WAIT_S;
}

/** Stops waiting the moment the person asking has gone. */
function goneSignal(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.on('close', () => abort.abort());
  return abort.signal;
}

export async function registerCallRoutes(app: FastifyInstance, ctx: Ctx, requireGuest: Guard): Promise<void> {
  const guarded = { preHandler: requireGuest };
  const aCall = { preHandler: [requireGuest, knownId((reply) => refuse(reply, new CallError('NOT_FOUND', 'no such call')))] };
  const rate = limits();

  /** Where to look for a way through, with a relay password good for one call. */
  app.get('/v1/calls/ice', guarded, async (request) => {
    const { iceServers, ttlS } = iceServersFor(request.guestId!, ctx.clock.now());
    return { ice_servers: iceServers, ttl_s: ttlS };
  });

  /** Whether the order screen shows «Залгах», and whom it would ring. */
  app.get<{ Querystring: { subject?: string; subject_id?: string } }>('/v1/calls/can', guarded, async (request, reply) => {
    const { subject, subject_id: subjectId } = request.query;
    if (subject !== 'idesh' || !subjectId || !UUID.test(subjectId)) return refuse(reply, new CallError('NOT_FOUND', 'nothing to call about'));
    const terms = await callTermsFor(subjectId, request.guestId!, ctx.clock.now());
    if (!terms) return refuse(reply, new CallError('NOT_FOUND', 'not your order'));
    const open = await callsOpen();
    return { can_call: open && terms.open && terms.ring.length > 0, peer_name: terms.calleeName };
  });

  app.post<{ Body: { subject?: unknown; subject_id?: unknown; offer?: unknown } }>(
    '/v1/calls',
    { preHandler: requireGuest, config: { rateLimit: rate.call } },
    async (request, reply) => {
      const { subject, subject_id: subjectId, offer } = request.body ?? {};
      if (subject !== 'idesh') return badRequest(reply, 'Юуны талаар залгахыг заана уу.', 'subject must be idesh');
      if (!isSdp(offer)) return badRequest(reply, 'Дуудлагын мэдээлэл буруу байна.', 'offer must be an SDP');
      if (typeof subjectId !== 'string' || !UUID.test(subjectId)) return refuse(reply, new CallError('NOT_FOUND', 'no such order'));
      try {
        if (!(await callsOpen())) throw new CallError('CLOSED', 'calls are closed');
        const me = request.guestId!;
        const terms = await callTermsFor(subjectId, me, ctx.clock.now());
        if (!terms) throw new CallError('NOT_FOUND', 'not your order');
        if (!terms.open) throw new CallError('OUT_OF_WINDOW', 'this order is not one to call about now');
        const call = await startCall(ctx, {
          subject,
          subjectId,
          about: terms.about,
          callerId: me,
          callees: terms.ring,
          callerName: terms.callerName,
          calleeName: terms.calleeName,
          offer,
        });
        return reply.status(201).send(shapeCall(call, me));
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  /**
   * The calls ringing this person. `known` is the ids the screen already
   * shows: while the list is still those, the answer waits for a change.
   */
  app.get<{ Querystring: { known?: string; wait?: string } }>('/v1/calls/ringing', guarded, async (request, reply) => {
    const me = request.guestId!;
    const known = new Set((request.query.known ?? '').split(',').filter(Boolean));
    const same = (list: Call[]) => list.length === known.size && list.every((c) => known.has(c.id));
    await settleCalls(ctx);
    let list = await ringingFor(me);
    const wait = waitSeconds(request.query.wait);
    if (wait > 0 && same(list)) {
      await waitFor([guestKey(me)], wait * 1000, goneSignal(reply));
      list = await ringingFor(me);
    }
    return { calls: list.map((c) => shapeCall(c, me)) };
  });

  /** One call, as soon as it is past `after` — or as it is, once `wait` runs out. */
  app.get<{ Params: { id: string }; Querystring: { after?: string; wait?: string } }>('/v1/calls/:id', aCall, async (request, reply) => {
    const me = request.guestId!;
    await settleCalls(ctx);
    let call = await callFor(request.params.id, me);
    if (!call) return refuse(reply, new CallError('NOT_FOUND', 'no such call of yours'));
    const after = Number(request.query.after ?? -1);
    const wait = waitSeconds(request.query.wait);
    if (wait > 0 && isLive(call.state) && Number.isFinite(after) && call.version <= after) {
      await waitFor([callKey(call.id)], wait * 1000, goneSignal(reply));
      call = (await callFor(request.params.id, me)) ?? call;
    }
    return shapeCall(call, me);
  });

  app.post<{ Params: { id: string }; Body: { answer?: unknown } }>('/v1/calls/:id/answer', aCall, async (request, reply) => {
    const answer = request.body?.answer;
    if (!isSdp(answer)) return badRequest(reply, 'Дуудлагын мэдээлэл буруу байна.', 'answer must be an SDP');
    try {
      return shapeCall(await answerCall(ctx, request.params.id, request.guestId!, answer), request.guestId!);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /** Hanging up: cancel, decline or end, whichever it is for this person now. */
  app.post<{ Params: { id: string } }>('/v1/calls/:id/end', aCall, async (request, reply) => {
    try {
      return shapeCall(await endCall(ctx, request.params.id, request.guestId!), request.guestId!);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /** A phone saying how to wake it for a call: iOS's PushKit token, or Android's FCM one. */
  app.post<{ Body: { kind?: unknown; token?: unknown } }>('/v1/calls/tokens', guarded, async (request, reply) => {
    const { kind, token } = request.body ?? {};
    if ((kind !== 'voip' && kind !== 'fcm') || typeof token !== 'string' || !token || token.length > 512) {
      return badRequest(reply, 'Төхөөрөмжийн мэдээлэл дутуу байна.', 'kind (voip|fcm) and token are required');
    }
    await registerRingToken(request.guestId!, kind, token, ctx.clock.now());
    return { registered: true };
  });

  app.post<{ Body: { token?: unknown } }>('/v1/calls/tokens/revoke', guarded, async (request: FastifyRequest<{ Body: { token?: unknown } }>, reply) => {
    const token = request.body?.token;
    if (typeof token !== 'string' || !token) return badRequest(reply, 'Төхөөрөмж заагаагүй байна.', 'token is required');
    await revokeRingToken(request.guestId!, token);
    return { revoked: true };
  });
}
