import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mode } from '../mode.js';
import { WireError } from '../platform/ledger/index.js';
import { sendError } from './errors.js';

/**
 * What every response carries, and how often a caller may knock.
 *
 * The headers are the browser's side of the bargain: a page may only run
 * the scripts we shipped, only talk to us, never be framed by somebody
 * else. Our pages keep their script inline, so the policy names each one by
 * its hash — computed once from the files on disk, so a page edited and
 * deployed is allowed and a script injected into it is not. A script a page
 * loads from a CDN is named by its whole address, read off the same files,
 * and never the CDN itself: a CDN serves every version of every library, an
 * old template engine among them, and with the host allowed a scrap of
 * markup that slipped past an escape could load one and run it here. The
 * address pins the file, not its bytes, so the page's tag carries the
 * file's hash too (`integrity`), and bytes that ever differ do not run.
 */

const WEB_ORIGINS = {
  styles: ['https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
  fonts: ['https://fonts.gstatic.com'],
};

/** `'sha256-…'` for every inline `<script>` in the pages under `webRoot`. */
export function inlineScriptHashes(webRoot: string): string[] {
  const hashes = new Set<string>();
  for (const file of readdirSync(webRoot)) {
    if (!file.endsWith('.html')) continue;
    const html = readFileSync(join(webRoot, file), 'utf8');
    for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      const attrs = match[1] ?? '';
      if (/\ssrc=/.test(attrs)) continue;
      const body = match[2] ?? '';
      if (!body.trim()) continue;
      hashes.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
    }
  }
  return [...hashes];
}

/**
 * The whole address of every script the pages under `webRoot` load from
 * elsewhere (`<script src="https://…">`) — one file each, not the host it
 * comes from. An address that would not read as one source in the policy is
 * left out, and its page's script simply does not load.
 */
export function externalScripts(webRoot: string): string[] {
  const urls = new Set<string>();
  for (const file of readdirSync(webRoot)) {
    if (!file.endsWith('.html')) continue;
    const html = readFileSync(join(webRoot, file), 'utf8');
    for (const match of html.matchAll(/<script\s[^>]*?\bsrc="(https:\/\/[^"]+)"/g)) {
      const url = match[1] ?? '';
      if (/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~\/-]+$/.test(url)) urls.add(url);
    }
  }
  return [...urls].sort();
}

export function contentSecurityPolicy(scriptHashes: string[], scriptFiles: string[] = []): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptFiles.join(' ')} ${scriptHashes.join(' ')}`.replace(/\s+/g, ' ').trim(),
    `style-src 'self' 'unsafe-inline' ${WEB_ORIGINS.styles.join(' ')}`,
    `font-src 'self' data: ${WEB_ORIGINS.fonts.join(' ')}`,
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** The same headers on every response, HTML or JSON: one place, no route forgets. */
export function securityHeaders(app: FastifyInstance, webRoot: string): void {
  const csp = contentSecurityPolicy(inlineScriptHashes(webRoot), externalScripts(webRoot));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Content-Security-Policy', csp);
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  });
}

/**
 * How often one address may knock. Production is strict; the demo, which
 * the tests and the walkthrough hammer from one machine, is loose but not
 * unlimited. Per phone, the OTP has its own limit inside identity.
 */
export interface Limit {
  max: number;
  timeWindow: string;
}

export function limits(): { global: Limit; otp: Limit; verify: Limit; ops: Limit } {
  const strict = mode() === 'production';
  return {
    global: { max: strict ? 600 : 3000, timeWindow: '1 minute' },
    otp: { max: strict ? 10 : 120, timeWindow: '1 minute' },
    verify: { max: strict ? 30 : 240, timeWindow: '1 minute' },
    ops: { max: strict ? 120 : 600, timeWindow: '1 minute' },
  };
}

/**
 * What the plugin throws when the ceiling is hit. Fastify would answer with
 * its own shape; the error handler below sends `body` instead, so a 429
 * reads like every other refusal this API makes.
 */
export function tooManyRequests(_request: FastifyRequest, context: { after: string; max: number }) {
  return {
    statusCode: 429,
    code: 'RATE_LIMITED',
    error: 'Too Many Requests',
    message: `rate limit of ${context.max} exceeded, retry after ${context.after}`,
    body: {
      error: {
        code: 'RATE_LIMITED',
        message_mn: 'Хэт олон оролдлого. Түр хүлээгээд дахин оролдоно уу.',
        message_en: `rate limit of ${context.max} exceeded, retry after ${context.after}`,
      },
    },
  };
}

/**
 * What a request is told when something breaks under it.
 *
 * Left to Fastify, an error goes out as itself: its message, its code and
 * whatever status it carries, to whoever asked. That was Postgres naming
 * the type it could not read an id as, a TypeError quoting a line of ours,
 * and — had one got past its route — the payment provider's own status and
 * words, whose 401 would have signed a website visitor out. None of it is
 * the caller's to read. The server's log keeps a line of it — the route and
 * the kind of error, never what was sent — and the caller is answered as
 * every route answers (`sendError`): a refusal of ours by its name, and
 * anything else «Алдаа гарлаа».
 *
 * A refusal of the request itself is the caller's, and keeps its status:
 * Fastify's own, made before any route runs — a body that is not JSON, or
 * too large — in Fastify's words, which are about what was sent; and the web
 * root's — a path it will not serve, a range the file has not got — in the
 * words of its status alone, whatever the error says. The ceiling on
 * knocking answers in the envelope (`tooManyRequests`).
 */
export function errorHandler(
  error: Error & { statusCode?: unknown; status?: unknown; code?: unknown; body?: unknown },
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error.statusCode === 429 && error.body) return reply.status(429).send(error.body);
  const status = Number(error.statusCode ?? error.status);
  const refused = Number.isInteger(status) && status >= 400 && status < 500 && !(error instanceof WireError);
  if (!refused) return sendError(reply, error);
  if (typeof error.code === 'string' && error.code.startsWith('FST_')) return reply.send(error);
  const words = STATUS_CODES[status] ?? 'Bad Request';
  return reply.status(status).send({ statusCode: status, error: words, message: words });
}

export type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
