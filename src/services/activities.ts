import { createHash } from 'node:crypto';
import { getPool } from '../db/pool.js';
import {
  activityCards,
  forgetActivityToken,
  markActivityPushed,
} from '../platform/notify/index.js';
import { ideshCardFacts, type IdeshState } from '../idesh/index.js';
import { PushTokenGone, type ActivityPush, type Ctx } from '../ports.js';

/**
 * The order on the lock screen, kept in step by the server.
 *
 * The phone starts a Live Activity when an order is confirmed and registers
 * its push token with us. From then on the card can only be moved by push —
 * the app is not running, or is asleep — and the moves that matter happen
 * on the server: the kitchen accepts, the planner picks a fire time and then
 * moves it, the fire happens, the food lands.
 *
 * Rather than hooking every one of those places, the scheduler asks once a
 * tick: for every card out there, what should it say now? A digest of that
 * answer is compared with what the token was last sent, and only a change
 * goes out. A replanned fire time is a change; a tick where nothing happened
 * costs one SELECT. The comparison is per token, so a card that missed a push
 * (Apple down, phone off the network) is not caught up by another phone's
 * success.
 *
 * Three stages and their words are the app's (`OrderStage` in BasuKit); the
 * content state here is what its `ContentState` decodes.
 *
 * An идэш has a card of its own (`IdeshActivityAttributes`), up on the day
 * the meat changes hands. Same loop, its own words, and no alert: the
 * order's own messages (`idesh.ready`, `idesh.dispatched`) already say it.
 */

const STAGE: Record<string, 'waiting' | 'cooking' | 'ready'> = {
  FIRED: 'cooking',
  COOKING: 'cooking',
  READY: 'ready',
  SERVED: 'ready',
};

const OVER = new Set(['SERVED', 'CLOSED', 'CANCELLED', 'REFUNDED', 'NO_SHOW', 'REJECTED']);

const LABEL: Record<'waiting' | 'cooking' | 'ready', string> = {
  waiting: 'Хүлээгдэж байна',
  cooking: 'Гал дээр гарлаа',
  ready: 'Ширээ бэлэн',
};

/** The one line worth interrupting a lock screen for. */
const ALERT: Partial<Record<'waiting' | 'cooking' | 'ready', { title: string; body: string }>> = {
  cooking: { title: 'Гал дээр гарлаа', body: 'Таны хоол хийгдэж эхэллээ. Цуцлах боломжгүй боллоо.' },
  ready: { title: 'Ширээ бэлэн', body: 'Хоол чинь ширээн дээр чинь очлоо.' },
};

interface CardState {
  over: boolean;
  contentState: Record<string, unknown>;
  /** After this the card is greyed as out of date. */
  staleAt: Date;
  /** Lit up and buzzed, for the one change worth it. */
  alert?: { title: string; body: string };
  /** A finished card stays up a quarter of an hour past this, or past now if later. */
  lingerFrom?: Date;
  hash: string;
}

const digest = (over: boolean, contentState: Record<string, unknown>): string =>
  createHash('sha256').update(JSON.stringify([over, contentState])).digest('hex').slice(0, 32);

async function cardStates(orderIds: string[]): Promise<Map<string, CardState>> {
  if (orderIds.length === 0) return new Map();
  const { rows } = await getPool().query<{
    id: string;
    state: string;
    slot_starts_at: Date;
    fire_at: Date | null;
  }>(`SELECT id, state, slot_starts_at, fire_at FROM dine.dining_order WHERE id = ANY($1)`, [orderIds]);

  const out = new Map<string, CardState>();
  for (const row of rows) {
    const stage = STAGE[row.state] ?? 'waiting';
    const over = OVER.has(row.state);
    const contentState = {
      stage,
      stageLabel: LABEL[stage],
      seatingTime: row.slot_starts_at.toISOString(),
      fireTime: row.fire_at?.toISOString() ?? null,
    };
    const alert = ALERT[stage];
    out.set(row.id, {
      over,
      contentState,
      staleAt: new Date(row.slot_starts_at.getTime() + 30 * 60_000),
      ...(alert && !over ? { alert } : {}),
      lingerFrom: row.slot_starts_at,
      hash: digest(over, contentState),
    });
  }
  return out;
}

/** The words every Basu screen uses (`IdeshState.word` in the app). */
const IDESH_WORD: Record<IdeshState, string> = {
  DRAFT: 'Төлөгдөөгүй',
  PAID: 'Төлсөн',
  PREPARING: 'Бэлтгэж байна',
  READY: 'Бэлэн',
  DISPATCHED: 'Замд',
  HANDED: 'Хүлээлгэн өгсөн',
  CLOSED: 'Дууслаа',
  CANCELLED: 'Цуцлагдлаа',
  REFUNDED: 'Буцаагдлаа',
};

/** Along the meter of four; nought draws none. */
const IDESH_STEP: Record<IdeshState, number> = {
  DRAFT: 0,
  PAID: 1,
  PREPARING: 2,
  READY: 3,
  DISPATCHED: 4,
  HANDED: 4,
  CLOSED: 4,
  CANCELLED: 0,
  REFUNDED: 0,
};

const IDESH_OVER = new Set<IdeshState>(['HANDED', 'CLOSED', 'CANCELLED', 'REFUNDED']);

async function ideshCardStates(orderIds: string[]): Promise<Map<string, CardState>> {
  const out = new Map<string, CardState>();
  for (const [id, fact] of await ideshCardFacts(orderIds)) {
    const over = IDESH_OVER.has(fact.state);
    const contentState = {
      state: fact.state,
      word: IDESH_WORD[fact.state],
      step: IDESH_STEP[fact.state],
      receiveOn: fact.receiveOn,
    };
    out.set(id, {
      over,
      contentState,
      // The end of the day it was for, in Ulaanbaatar.
      staleAt: new Date(`${fact.receiveOn}T23:59:59+08:00`),
      hash: digest(over, contentState),
    });
  }
  return out;
}

/** The kinds of card, by the subject their tokens are stored under. */
const KINDS: { subject: string; states: (ids: string[]) => Promise<Map<string, CardState>> }[] = [
  { subject: 'order', states: cardStates },
  { subject: 'idesh', states: ideshCardStates },
];

export interface ActivityRelayReport {
  updated: number;
  ended: number;
  forgotten: number;
  failed: number;
}

/** One pass over every card. Called from the scheduler's tick. */
export async function relayActivities(ctx: Ctx): Promise<ActivityRelayReport> {
  const report: ActivityRelayReport = { updated: 0, ended: 0, forgotten: 0, failed: 0 };
  const now = ctx.clock.now();

  for (const kind of KINDS) {
    const cards = await activityCards(kind.subject);
    if (cards.length === 0) continue;
    const states = await kind.states([...new Set(cards.map((c) => c.subjectId))]);

    for (const card of cards) {
      const state = states.get(card.subjectId);
      if (!state) {
        // The order is gone (a reseed, in practice). Nothing to say to the card.
        await forgetActivityToken(card.pushToken, card.subjectId);
        report.forgotten++;
        continue;
      }
      if (state.hash === card.pushedHash) continue;

      // A card that was never told anything and is already over: the phone
      // ended it itself when it learned. No push, just forget the token.
      if (state.over && card.pushedHash === null) {
        await forgetActivityToken(card.pushToken, card.subjectId);
        report.forgotten++;
        continue;
      }

      const push: ActivityPush = {
        token: card.pushToken,
        event: state.over ? 'end' : 'update',
        contentState: state.contentState,
        staleAt: state.staleAt,
      };
      if (state.over) {
        // The last word stays up a quarter of an hour, then goes.
        const from = Math.max(now.getTime(), state.lingerFrom?.getTime() ?? 0);
        push.dismissAt = new Date(from + 15 * 60_000);
      } else if (state.alert) {
        push.alert = state.alert;
      }

      try {
        await ctx.notifier.pushActivity(push);
        if (state.over) {
          await forgetActivityToken(card.pushToken, card.subjectId);
          report.ended++;
        } else {
          await markActivityPushed(card.pushToken, card.subjectId, state.hash, now);
          report.updated++;
        }
      } catch (error) {
        if (error instanceof PushTokenGone) {
          await forgetActivityToken(card.pushToken, card.subjectId);
          report.forgotten++;
        } else {
          // Left as it was: the hash still differs, so the next tick retries.
          report.failed++;
        }
      }
    }
  }
  return report;
}
