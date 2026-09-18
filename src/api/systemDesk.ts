import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { DEFAULT_COMMISSION_PCT, FORFEIT_PCT, IdeshError, NO_SHOW_DAYS, recordAudit } from '../idesh/index.js';
import { mode } from '../mode.js';
import { lastTicks, pulse, SettingError, setSetting, settings } from '../ops/index.js';
import { contactsFor, displayNamesFor, findGuests } from '../platform/identity/index.js';
import { reconciliationForDesk } from '../platform/ledger/index.js';
import { channelPulse, messagesForDesk, monthlyVolume, retryMessage } from '../platform/notify/index.js';
import { getPool } from '../db/pool.js';
import type { Ctx } from '../ports.js';
import { badRequest, sendError } from './errors.js';

/**
 * Two more sections of the desk: what we told people, and whether the
 * machine is well.
 *
 * Health is read off the tables, not off the providers: "when did QPay last
 * confirm a top-up" is a better question than "does QPay answer a ping",
 * because the first one is the thing a guest would notice.
 */

export interface SystemGuards {
  asOps: RouteShorthandOptions;
  asRunner: RouteShorthandOptions;
  asAdmin: RouteShorthandOptions;
  who: (request: FastifyRequest) => string;
}

const NIL = '00000000-0000-0000-0000-000000000000';
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const startedAt = new Date();

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '?';
  }
}

/** A provider is real when it is not one of the fakes in `ports.ts`. */
const flavour = (p: object) => (p.constructor.name.startsWith('Fake') ? 'fake' : 'real');

export function registerSystemDesk(app: FastifyInstance, ctx: Ctx, { asOps, asRunner, asAdmin, who }: SystemGuards): void {
  /* ── what we told people ── */

  type MessageQuery = { state?: string; channel?: string; template?: string; q?: string; from?: string; to?: string; limit?: string };

  app.get<{ Querystring: MessageQuery }>('/v1/ops/notify/messages', asOps, async (request) => {
    const q = request.query.q?.trim();
    let guestIds: string[] | undefined;
    if (q) {
      guestIds = (await findGuests(q, 100)).map((g) => g.id);
      if (!guestIds.length) return { messages: [] };
    }
    const messages = await messagesForDesk({
      state: request.query.state || undefined,
      channel: request.query.channel || undefined,
      template: request.query.template || undefined,
      from: request.query.from || undefined,
      to: request.query.to || undefined,
      limit: Number(request.query.limit) || undefined,
      guestIds,
    });
    const ids = messages.map((m) => m.guestId);
    const [names, contacts] = await Promise.all([displayNamesFor(ids), contactsFor(ids)]);
    return {
      messages: messages.map((m) => ({
        id: m.id,
        guest_id: m.guestId,
        guest: names.get(m.guestId) ?? null,
        guest_phone: contacts.get(m.guestId)?.phone ?? null,
        channel: m.channel,
        template: m.template,
        title: m.title,
        body: m.body,
        subject: m.subject,
        subject_id: m.subjectId,
        state: m.state,
        created_at: m.createdAt.toISOString(),
        sent_at: iso(m.sentAt),
        read_at: iso(m.readAt),
        provider_ref: m.providerRef,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/v1/ops/notify/messages/:id/retry', asRunner, async (request, reply) => {
    if (!(await retryMessage(request.params.id))) return sendError(reply, new IdeshError('NOT_FOUND', 'no failed message under that id'));
    await recordAudit({ who: who(request), action: 'message.retry', targetKind: 'message', targetId: request.params.id });
    return reply.send({ id: request.params.id, state: 'queued' });
  });

  /** The bill: each month's volume by channel, priced by the desk's own unit costs. */
  app.get('/v1/ops/notify/volume', asOps, async () => {
    const [months, knobs] = await Promise.all([monthlyVolume(12), settings()]);
    const unit = (key: string) => Number(knobs.find((s) => s.key === key)?.value ?? 0);
    const sms = unit('sms_unit_mnt');
    const push = unit('push_unit_mnt');
    return {
      unit: { sms_mnt: sms, push_mnt: push },
      months: months.map((m) => ({ month: m.month, sms: m.sms, push: m.push, cost_mnt: m.sms.sent * sms + m.push.sent * push })),
    };
  });

  /* ── the machine ── */

  app.get('/v1/ops/system', asOps, async () => {
    const now = ctx.clock.now();
    const [beat, channels, money, knobs, database] = await Promise.all([
      pulse(now),
      channelPulse(now),
      reconciliationForDesk(now),
      settings(),
      getPool().query<{ migrations: number; size: string; last_migration: string | null }>(
        `SELECT (SELECT count(*)::int FROM schema_migration) AS migrations,
                pg_size_pretty(pg_database_size(current_database())) AS size,
                (SELECT max(name) FROM schema_migration) AS last_migration`,
      ),
    ]);
    const sms = channels.find((c) => c.channel === 'sms')!;
    const push = channels.find((c) => c.channel === 'push')!;
    const ageS = beat.lastAt ? Math.round((now.getTime() - beat.lastAt.getTime()) / 1000) : null;
    const production = mode() === 'production';
    const dbRow = database.rows[0]!;
    return {
      mode: mode(),
      version: version(),
      node: process.version,
      started_at: startedAt.toISOString(),
      now: now.toISOString(),
      scheduler: {
        last_at: iso(beat.lastAt),
        age_s: ageS,
        // Production ticks every second; a minute without one means the process is down.
        ok: production ? ageS !== null && ageS < 60 : true,
        last_took_ms: beat.lastTookMs,
        ticks_last_hour: beat.lastHour,
        day: beat.day,
        last_report: beat.lastReport,
      },
      integrations: [
        {
          key: 'qpay',
          name: 'QPay',
          flavour: flavour(ctx.payments),
          ok: money.qpay.stuck === 0 && money.qpay.gapMnt === 0,
          detail: { last_ok_at: null, pending: money.qpay.pending, stuck: money.qpay.stuck, gap_mnt: money.qpay.gapMnt },
        },
        {
          key: 'posapi',
          name: 'Е-баримт (PosAPI)',
          flavour: flavour(ctx.tax),
          ok: money.receipts.failed === 0,
          detail: { queued: money.receipts.queued, issued: money.receipts.issued, failed: money.receipts.failed },
        },
        {
          key: 'sms',
          name: 'SMS (CallPro)',
          flavour: flavour(ctx.notifier) === 'fake' ? 'fake' : 'real',
          ok: sms.failedDay === 0,
          detail: { last_ok_at: iso(sms.lastSentAt), sent_day: sms.sentDay, failed_day: sms.failedDay, queued: sms.queued },
        },
        {
          key: 'apns',
          name: 'Push (APNs)',
          flavour: ctx.notifier.constructor.name === 'ApnsNotifier' ? 'real' : 'fake',
          ok: push.failedDay === 0,
          detail: { last_ok_at: iso(push.lastSentAt), sent_day: push.sentDay, failed_day: push.failedDay, queued: push.queued },
        },
      ],
      database: { migrations: dbRow.migrations, last_migration: dbRow.last_migration, size: dbRow.size },
      rules: { commission_pct: DEFAULT_COMMISSION_PCT, forfeit_pct: FORFEIT_PCT, no_show_days: NO_SHOW_DAYS },
      settings: knobs.map((s) => ({ key: s.key, label: s.label, hint: s.hint, kind: s.kind, value: s.value, updated_by: s.updatedBy, updated_at: iso(s.updatedAt) })),
    };
  });

  app.get('/v1/ops/system/ticks', asOps, async () => ({
    ticks: (await lastTicks(60)).map((t) => ({ at: t.at.toISOString(), took_ms: t.tookMs, report: t.report })),
  }));

  app.put<{ Params: { key: string }; Body: { value?: unknown } }>('/v1/ops/system/settings/:key', asAdmin, async (request, reply) => {
    try {
      const saved = await setSetting(request.params.key, request.body?.value, who(request));
      await recordAudit({ who: who(request), action: 'setting.change', targetKind: 'setting', targetId: NIL, note: `${saved.key} = ${String(saved.value)}` });
      return reply.send({ key: saved.key, value: saved.value, updated_by: saved.updatedBy, updated_at: iso(saved.updatedAt) });
    } catch (error) {
      if (error instanceof SettingError) return badRequest(reply, error.code === 'UNKNOWN' ? 'Ийм тохиргоо алга.' : 'Утга буруу байна.', error.message);
      return sendError(reply, error);
    }
  });
}
