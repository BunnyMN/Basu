import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import {
  PushTokenGone,
  type ActivityPush,
  type Notifier,
  type OutgoingMessage,
} from '../../ports.js';

/**
 * Apple Push Notification service, spoken directly.
 *
 * Two things go through here: a notification to a device (`send`, the push
 * channel of the relay ladder) and a Live Activity update to a lock screen
 * (`pushActivity`). Both are one HTTP/2 POST with a bearer token that Apple
 * wants signed with the team's `.p8` key — a JWT, ES256, no older than an
 * hour. Node has HTTP/2 and ES256 built in, so there is no dependency to take
 * for it, and a library that hides the request would hide the only part that
 * ever goes wrong: the headers.
 *
 * Failure is reported the way the caller needs it. A dead token — the app was
 * deleted, the activity was dismissed — is `PushTokenGone`, so notify forgets
 * it. Anything else is an error to retry on the next tick.
 */

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** The `.p8` as PEM text. */
  privateKey: string;
  /** `mn.basu.app` — the app's bundle identifier, which is APNs' topic. */
  bundleId: string;
  /** `api.sandbox.push.apple.com` for development builds, `api.push.apple.com` for the store. */
  host: string;
  /** Tests point this at their own server; APNs itself is always https. */
  scheme?: 'https' | 'http';
  port?: number;
}

/** What the environment says, or nothing — the fakes then stay in place. */
export function apnsConfigFromEnv(env = process.env): ApnsConfig | null {
  const teamId = env['APNS_TEAM_ID']?.trim();
  const keyId = env['APNS_KEY_ID']?.trim();
  const bundleId = env['APNS_BUNDLE_ID']?.trim() || 'mn.basu.app';
  const keyFile = env['APNS_KEY_FILE']?.trim();
  const keyInline = env['APNS_KEY']?.trim();
  if (!teamId || !keyId || (!keyFile && !keyInline)) return null;
  const privateKey = keyInline ? keyInline.replace(/\\n/g, '\n') : readFileSync(keyFile!, 'utf8');
  const sandbox = (env['APNS_ENV'] ?? 'sandbox').trim() !== 'production';
  return {
    teamId,
    keyId,
    privateKey,
    bundleId,
    host: env['APNS_HOST']?.trim() || (sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'),
  };
}

/** Base64url, the way JWTs want it. */
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** ES256 signature as JWT wants it: r‖s, 64 bytes — not the DER `crypto` makes. */
function derToJose(der: Buffer): Buffer {
  // DER: 0x30 len 0x02 rlen r 0x02 slen s
  let offset = 2;
  const rLen = der[offset + 1]!;
  const r = der.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;
  const sLen = der[offset + 1]!;
  const s = der.subarray(offset + 2, offset + 2 + sLen);
  const out = Buffer.alloc(64);
  r.subarray(-32).copy(out, 32 - Math.min(32, r.length));
  s.subarray(-32).copy(out, 64 - Math.min(32, s.length));
  return out;
}

export class ApnsClient {
  readonly #config: ApnsConfig;
  readonly #key: KeyObject;
  #jwt: { value: string; issuedAt: number } | null = null;
  #session: http2.ClientHttp2Session | null = null;

  constructor(config: ApnsConfig) {
    this.#config = config;
    this.#key = createPrivateKey(config.privateKey);
  }

  /**
   * The bearer token. Apple refuses one older than an hour and one minted
   * more often than every twenty minutes, so it is reused for fifty.
   */
  token(now = Date.now()): string {
    const issuedAt = Math.floor(now / 1000);
    if (this.#jwt && issuedAt - this.#jwt.issuedAt < 50 * 60) return this.#jwt.value;
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: this.#config.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.#config.teamId, iat: issuedAt }));
    const signer = createSign('SHA256');
    signer.update(`${header}.${claims}`);
    const signature = b64url(derToJose(signer.sign(this.#key)));
    this.#jwt = { value: `${header}.${claims}.${signature}`, issuedAt };
    return this.#jwt.value;
  }

  #connect(): http2.ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) return this.#session;
    const { scheme = 'https', host, port } = this.#config;
    const session = http2.connect(`${scheme}://${host}${port ? `:${port}` : ''}`);
    session.on('error', () => {
      /* the next request reconnects */
    });
    this.#session = session;
    return session;
  }

  close(): void {
    this.#session?.close();
    this.#session = null;
  }

  /** One POST to `/3/device/{token}`. Resolves with `apns-id`; rejects on anything but 200. */
  async post(input: {
    token: string;
    pushType: 'alert' | 'liveactivity';
    topic: string;
    payload: Record<string, unknown>;
    priority?: 5 | 10;
    expiresAt?: Date;
    collapseId?: string;
  }): Promise<string> {
    const session = this.#connect();
    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': `/3/device/${input.token}`,
      authorization: `bearer ${this.token()}`,
      'apns-topic': input.topic,
      'apns-push-type': input.pushType,
      'apns-priority': String(input.priority ?? 10),
      'apns-expiration': String(input.expiresAt ? Math.floor(input.expiresAt.getTime() / 1000) : 0),
      'content-type': 'application/json',
    };
    if (input.collapseId) headers['apns-collapse-id'] = input.collapseId;

    return new Promise((resolve, reject) => {
      const request = session.request(headers);
      let status = 0;
      let apnsId = '';
      const chunks: Buffer[] = [];
      request.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
        apnsId = String(h['apns-id'] ?? '');
      });
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (status === 200) return resolve(apnsId || 'apns');
        const body = Buffer.concat(chunks).toString('utf8');
        let reason = '';
        try {
          reason = String((JSON.parse(body) as { reason?: string }).reason ?? '');
        } catch {
          reason = body;
        }
        // 410 is "this token will never work again"; 400 BadDeviceToken and
        // Unregistered say the same thing in other words.
        if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic') {
          return reject(new PushTokenGone(input.token));
        }
        reject(new Error(`APNs ${status} ${reason || '(no reason)'}`));
      });
      request.on('error', (error) => {
        this.close();
        reject(error);
      });
      request.setTimeout(15_000, () => request.close(http2.constants.NGHTTP2_CANCEL));
      request.end(JSON.stringify(input.payload));
    });
  }
}

/**
 * The `Notifier` the entry points build when APNs credentials are present.
 *
 * Push goes to Apple. SMS is somebody else's gateway — until it exists the
 * fallback is whatever is handed in (the fake, in practice), so an arm
 * question a phone cannot receive still lands on the relay ladder's next rung
 * the way it always did.
 */
export class ApnsNotifier implements Notifier {
  readonly client: ApnsClient;
  readonly #bundleId: string;
  readonly #sms: Notifier;

  constructor(config: ApnsConfig, sms: Notifier) {
    this.client = new ApnsClient(config);
    this.#bundleId = config.bundleId;
    this.#sms = sms;
  }

  async send(message: OutgoingMessage): Promise<{ providerRef: string }> {
    if (message.channel !== 'push') return this.#sms.send(message);
    const providerRef = await this.client.post({
      token: message.to,
      pushType: 'alert',
      topic: this.#bundleId,
      collapseId: message.template,
      payload: {
        aps: { alert: { body: message.body }, sound: 'default' },
        template: message.template,
      },
    });
    return { providerRef };
  }

  async pushActivity(push: ActivityPush): Promise<{ providerRef: string }> {
    const aps: Record<string, unknown> = {
      timestamp: Math.floor(Date.now() / 1000),
      event: push.event,
      'content-state': push.contentState,
      'relevance-score': 100,
    };
    if (push.alert) aps['alert'] = push.alert;
    if (push.staleAt) aps['stale-date'] = Math.floor(push.staleAt.getTime() / 1000);
    if (push.event === 'end' && push.dismissAt) aps['dismissal-date'] = Math.floor(push.dismissAt.getTime() / 1000);
    const providerRef = await this.client.post({
      token: push.token,
      pushType: 'liveactivity',
      topic: `${this.#bundleId}.push-type.liveactivity`,
      priority: 10,
      payload: { aps },
    });
    return { providerRef };
  }
}
