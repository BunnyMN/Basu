import { createHmac } from 'node:crypto';

/**
 * Where a phone looks for a way through to the other one.
 *
 * Two phones on mobile networks often cannot reach each other directly; then
 * coturn on our own server relays the voice and picture. coturn is told one
 * secret (`static-auth-secret`), and every password is made from it here: a
 * username that says until when it is good, and its HMAC. Nobody holds a
 * password that outlives a call, and coturn keeps no list of users.
 *
 * Without `TURN_SECRET` there is no relay of ours, and the phones get a
 * public STUN server: enough for the calls that can go direct.
 */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Long enough for the longest call (two hours), with the ring before it. */
export const ICE_TTL_S = 3 * 60 * 60;

export function turnConfigFromEnv(env = process.env): { host: string; secret: string; port: number; tlsPort: number | null } | null {
  const secret = env['TURN_SECRET']?.trim();
  const host = env['TURN_HOST']?.trim();
  if (!secret || secret === '-' || !host) return null;
  const tls = env['TURN_TLS_PORT']?.trim();
  return {
    host,
    secret,
    port: Number(env['TURN_PORT'] ?? 3478) || 3478,
    tlsPort: tls === '0' ? null : Number(tls ?? 5349) || 5349,
  };
}

export function iceServersFor(guestId: string, now: Date, env = process.env): { iceServers: IceServer[]; ttlS: number } {
  const turn = turnConfigFromEnv(env);
  if (!turn) return { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], ttlS: ICE_TTL_S };
  const expires = Math.floor(now.getTime() / 1000) + ICE_TTL_S;
  // coturn reads the part before the colon as the expiry; the rest only
  // makes the name somebody's, for its log. Never the whole id.
  const username = `${expires}:${guestId.slice(0, 8)}`;
  const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
  const relay = [`turn:${turn.host}:${turn.port}?transport=udp`, `turn:${turn.host}:${turn.port}?transport=tcp`];
  // TLS on its own port gets through networks that let nothing but HTTPS out.
  if (turn.tlsPort) relay.push(`turns:${turn.host}:${turn.tlsPort}?transport=tcp`);
  return {
    iceServers: [{ urls: [`stun:${turn.host}:${turn.port}`] }, { urls: relay, username, credential }],
    ttlS: ICE_TTL_S,
  };
}
