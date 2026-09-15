import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mode } from '../mode.js';

/**
 * What every response carries, and how often a caller may knock.
 *
 * The headers are the browser's side of the bargain: a page may only run
 * the scripts we shipped, only talk to us, never be framed by somebody
 * else. Our pages keep their script inline, so the policy names each one by
 * its hash — computed once from the files on disk, so a page edited and
 * deployed is allowed and a script injected into it is not.
 */

const WEB_ORIGINS = {
  scripts: ['https://cdnjs.cloudflare.com'],
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

export function contentSecurityPolicy(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${WEB_ORIGINS.scripts.join(' ')} ${scriptHashes.join(' ')}`.trim(),
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
  const csp = contentSecurityPolicy(inlineScriptHashes(webRoot));
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

export function limits(): { global: Limit; otp: Limit; verify: Limit; pair: Limit; ops: Limit } {
  const strict = mode() === 'production';
  return {
    global: { max: strict ? 600 : 3000, timeWindow: '1 minute' },
    otp: { max: strict ? 10 : 120, timeWindow: '1 minute' },
    verify: { max: strict ? 30 : 240, timeWindow: '1 minute' },
    pair: { max: strict ? 5 : 60, timeWindow: '1 minute' },
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

/** A thrown ceiling answers in the envelope; everything else as Fastify would. */
export function errorHandler(error: Error & { statusCode?: number; body?: unknown }, _request: FastifyRequest, reply: FastifyReply) {
  if (error.statusCode === 429 && error.body) return reply.status(429).send(error.body);
  return reply.send(error);
}

export type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
