import { createSign } from 'node:crypto';
import { PushTokenGone, type ActivityPush, type DataPush, type Notifier, type OutgoingMessage, type VoipPush } from '../../ports.js';

/**
 * Firebase Cloud Messaging, spoken directly — Android's push, as apns.ts is
 * iOS's.
 *
 * Two things go through here: a message for the tray (an order moved, a
 * missed call) and a call ringing. Both are data messages the app draws
 * itself (android/…/push/Messaging.kt), so a phone shows them the same way
 * open, in the background or closed. FCM's v1 API wants an OAuth token, which
 * a service account's key signs for (a JWT, RS256) and Google trades for an
 * hour's access. Node signs RS256 and has fetch, so there is no SDK to take,
 * and one would hide the only part that ever goes wrong: the request.
 *
 * A dead token — the app uninstalled, the data cleared — is `PushTokenGone`,
 * so the caller forgets it. Anything else is an error to retry on the next tick.
 */
export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** The service account's key, PEM. */
  privateKey: string;
  /** Tests point these at their own server. */
  tokenUrl?: string;
  sendUrl?: string;
}

/**
 * `FCM_SERVICE_ACCOUNT`: the service account's JSON, base64 — one line with
 * no quotes, the way the deploy carries a key to the server's .env. Raw JSON
 * is taken too, for a developer's own shell.
 */
export function fcmConfigFromEnv(env = process.env): FcmConfig | null {
  const raw = env['FCM_SERVICE_ACCOUNT']?.trim();
  if (!raw || raw === '-') return null;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const account = JSON.parse(text) as { project_id?: string; client_email?: string; private_key?: string; token_uri?: string };
    if (!account.project_id || !account.client_email || !account.private_key) return null;
    return {
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey: account.private_key,
      ...(account.token_uri ? { tokenUrl: account.token_uri } : {}),
    };
  } catch {
    return null;
  }
}

export class FcmClient {
  readonly #config: FcmConfig;
  #access: { token: string; until: number } | null = null;

  constructor(config: FcmConfig) {
    this.#config = config;
  }

  get projectId(): string {
    return this.#config.projectId;
  }

  /** An hour's access, asked for again five minutes before it runs out. */
  async accessToken(now = Date.now()): Promise<string> {
    if (this.#access && now < this.#access.until) return this.#access.token;
    const tokenUrl = this.#config.tokenUrl ?? 'https://oauth2.googleapis.com/token';
    const iat = Math.floor(now / 1000);
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
      iss: this.#config.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: tokenUrl,
      iat,
      exp: iat + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.#config.privateKey).toString('base64url');
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) throw new Error(`FCM token ${response.status}`);
    this.#access = { token: body.access_token, until: now + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 };
    return body.access_token;
  }

  /** One data message to one phone. Resolves with FCM's name for it. */
  async send(input: { token: string; data: Record<string, string>; ttlSeconds: number }): Promise<string> {
    const url = this.#config.sendUrl ?? `https://fcm.googleapis.com/v1/projects/${this.#config.projectId}/messages:send`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: input.token,
          data: input.data,
          // High: delivered at once, and the app may draw it even when asleep.
          android: { priority: 'HIGH', ttl: `${input.ttlSeconds}s` },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      name?: string;
      error?: { status?: string; details?: Array<{ errorCode?: string }> };
    };
    if (response.ok) return body.name ?? 'fcm';
    const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? '';
    // UNREGISTERED: the app is gone from that phone. A 400 could as well be our
    // own message at fault, and is not taken as the phone's.
    if (response.status === 404 || code === 'UNREGISTERED') {
      throw new PushTokenGone(input.token);
    }
    if (response.status === 401) this.#access = null;
    throw new Error(`FCM ${response.status} ${code || '(no reason)'}`);
  }
}

/**
 * The `Notifier` with Android in it: a push to an Android phone goes to FCM,
 * everything else to the notifier underneath (APNs, or the fakes).
 */
export class FcmNotifier implements Notifier {
  readonly client: FcmClient;
  readonly base: Notifier;

  constructor(config: FcmConfig, base: Notifier) {
    this.client = new FcmClient(config);
    this.base = base;
  }

  async send(message: OutgoingMessage): Promise<{ providerRef: string }> {
    if (message.channel !== 'push' || message.platform !== 'android') return this.base.send(message);
    const data: Record<string, string> = { type: 'message', template: message.template, body: message.body };
    if (message.title) data['title'] = message.title;
    if (message.subject) data['subject'] = message.subject;
    if (message.subjectId) data['subject_id'] = message.subjectId;
    if (message.badge !== undefined) data['badge'] = String(message.badge);
    return { providerRef: await this.client.send({ token: message.to, data, ttlSeconds: 24 * 60 * 60 }) };
  }

  pushActivity(push: ActivityPush): Promise<{ providerRef: string }> {
    return this.base.pushActivity(push);
  }

  pushVoip(push: VoipPush): Promise<{ providerRef: string }> {
    return this.base.pushVoip(push);
  }

  async pushData(push: DataPush): Promise<{ providerRef: string }> {
    return { providerRef: await this.client.send({ token: push.token, data: push.data, ttlSeconds: push.ttlSeconds }) };
  }
}
