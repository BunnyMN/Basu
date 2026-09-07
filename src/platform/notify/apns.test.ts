import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import http2 from 'node:http2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PushTokenGone } from '../../ports.js';
import { ApnsClient, ApnsNotifier, apnsConfigFromEnv } from './apns.js';

/**
 * Apple's side of the conversation, faked at the wire.
 *
 * What these catch is not "can Node do HTTP/2" but the four things that make
 * a push silently vanish: a JWT Apple will not accept, a topic that does not
 * match the push type, a payload with the wrong keys, and a dead token that
 * keeps being retried. The server below verifies the signature with the real
 * public key, the way Apple does, and answers 410 for one token.
 */

interface Seen {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let server: http2.Http2Server;
let port: number;
let publicKey: KeyObject;
let privateKeyPem: string;
const seen: Seen[] = [];

function joseToDer(sig: Buffer): Buffer {
  const r = sig.subarray(0, 32);
  const s = sig.subarray(32, 64);
  const enc = (n: Buffer) => {
    let i = 0;
    while (i < n.length - 1 && n[i] === 0) i++;
    let v = n.subarray(i);
    if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const body = Buffer.concat([enc(r), enc(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function jwtIsValid(bearer: string): boolean {
  const [header, claims, signature] = bearer.replace(/^bearer /, '').split('.');
  if (!header || !claims || !signature) return false;
  const verifier = createVerify('SHA256');
  verifier.update(`${header}.${claims}`);
  return verifier.verify(publicKey, joseToDer(Buffer.from(signature, 'base64url')));
}

beforeAll(async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  publicKey = pair.publicKey;
  privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  server = http2.createServer();
  server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      const path = String(headers[':path']);
      const plain = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
      seen.push({ path, headers: plain, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      if (!jwtIsValid(plain['authorization'] ?? '')) {
        stream.respond({ ':status': 403 });
        stream.end(JSON.stringify({ reason: 'InvalidProviderToken' }));
        return;
      }
      if (path.endsWith('/dead')) {
        stream.respond({ ':status': 410 });
        stream.end(JSON.stringify({ reason: 'Unregistered' }));
        return;
      }
      stream.respond({ ':status': 200, 'apns-id': 'ABC-123' });
      stream.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(): ApnsClient {
  return new ApnsClient({
    teamId: 'TEAM123',
    keyId: 'KEY456',
    privateKey: privateKeyPem,
    bundleId: 'mn.basu.app',
    host: '127.0.0.1',
    port,
    scheme: 'http',
  });
}

describe('the bearer token', () => {
  it('is an ES256 JWT Apple can verify, reused within the hour', () => {
    const c = client();
    const first = c.token(0);
    expect(jwtIsValid(first)).toBe(true);
    const [header, claims] = first.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY456' });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({ iss: 'TEAM123', iat: 0 });
    // Apple refuses a token minted more than once in twenty minutes.
    expect(c.token(40 * 60 * 1000)).toBe(first);
    // …and one older than an hour.
    expect(c.token(55 * 60 * 1000)).not.toBe(first);
  });
});

describe('a Live Activity push', () => {
  it('goes to the liveactivity topic with the content state Apple expects', async () => {
    const notifier = new ApnsNotifier(
      { teamId: 'TEAM123', keyId: 'KEY456', privateKey: privateKeyPem, bundleId: 'mn.basu.app', host: '127.0.0.1', port, scheme: 'http' },
      { send: async () => ({ providerRef: 'sms' }), pushActivity: async () => ({ providerRef: 'x' }) },
    );
    seen.length = 0;
    const seating = new Date('2026-09-05T04:30:00Z');
    const { providerRef } = await notifier.pushActivity({
      token: 'abc123',
      event: 'update',
      contentState: { stage: 'cooking', stageLabel: 'Гал дээр гарлаа', seatingTime: seating.toISOString(), fireTime: null },
      alert: { title: 'Гал дээр гарлаа', body: 'Цуцлах боломжгүй боллоо.' },
      staleAt: new Date(seating.getTime() + 30 * 60_000),
    });
    expect(providerRef).toBe('ABC-123');

    const push = seen[0]!;
    expect(push.path).toBe('/3/device/abc123');
    expect(push.headers['apns-push-type']).toBe('liveactivity');
    expect(push.headers['apns-topic']).toBe('mn.basu.app.push-type.liveactivity');
    expect(push.headers['apns-priority']).toBe('10');
    const aps = push.body['aps'] as Record<string, unknown>;
    expect(aps['event']).toBe('update');
    expect(aps['content-state']).toEqual({
      stage: 'cooking',
      stageLabel: 'Гал дээр гарлаа',
      seatingTime: '2026-09-05T04:30:00.000Z',
      fireTime: null,
    });
    expect(aps['stale-date']).toBe(Math.floor(seating.getTime() / 1000) + 30 * 60);
    expect(aps['alert']).toEqual({ title: 'Гал дээр гарлаа', body: 'Цуцлах боломжгүй боллоо.' });
    expect(typeof aps['timestamp']).toBe('number');
    notifier.client.close();
  });

  it('ends with a dismissal date, and a dead token is said to be gone', async () => {
    const c = client();
    seen.length = 0;
    const notifier = new ApnsNotifier(
      { teamId: 'TEAM123', keyId: 'KEY456', privateKey: privateKeyPem, bundleId: 'mn.basu.app', host: '127.0.0.1', port, scheme: 'http' },
      { send: async () => ({ providerRef: 'sms' }), pushActivity: async () => ({ providerRef: 'x' }) },
    );
    const dismiss = new Date('2026-09-05T05:00:00Z');
    await notifier.pushActivity({ token: 'live1', event: 'end', contentState: { stage: 'ready' }, dismissAt: dismiss });
    expect((seen[0]!.body['aps'] as Record<string, unknown>)['dismissal-date']).toBe(dismiss.getTime() / 1000);

    await expect(
      notifier.pushActivity({ token: 'dead', event: 'update', contentState: {} }),
    ).rejects.toBeInstanceOf(PushTokenGone);
    notifier.client.close();
    c.close();
  });
});

describe('a notification to a device', () => {
  it('goes to the bundle topic as an alert; SMS goes to whoever handles SMS', async () => {
    const sms: Array<{ to: string; body: string }> = [];
    const notifier = new ApnsNotifier(
      { teamId: 'TEAM123', keyId: 'KEY456', privateKey: privateKeyPem, bundleId: 'mn.basu.app', host: '127.0.0.1', port, scheme: 'http' },
      {
        send: async (m) => {
          sms.push({ to: m.to, body: m.body });
          return { providerRef: 'sms-1' };
        },
        pushActivity: async () => ({ providerRef: 'x' }),
      },
    );
    seen.length = 0;
    await notifier.send({ channel: 'push', to: 'devtoken', template: 'arrival.arm', body: 'Та замд гарсан уу?' });
    expect(seen[0]!.headers['apns-topic']).toBe('mn.basu.app');
    expect(seen[0]!.headers['apns-push-type']).toBe('alert');
    expect(seen[0]!.headers['apns-collapse-id']).toBe('arrival.arm');
    expect((seen[0]!.body['aps'] as { alert: { body: string } }).alert.body).toBe('Та замд гарсан уу?');

    const ref = await notifier.send({ channel: 'sms', to: '+97699001122', template: 'auth.otp', body: '1234' });
    expect(ref.providerRef).toBe('sms-1');
    expect(sms).toEqual([{ to: '+97699001122', body: '1234' }]);
    notifier.client.close();
  });
});

describe('the environment', () => {
  it('is the fake until all three of team, key id and key are there', () => {
    expect(apnsConfigFromEnv({})).toBeNull();
    expect(apnsConfigFromEnv({ APNS_TEAM_ID: 'T', APNS_KEY_ID: 'K' })).toBeNull();
    const config = apnsConfigFromEnv({ APNS_TEAM_ID: 'T', APNS_KEY_ID: 'K', APNS_KEY: privateKeyPem.replace(/\n/g, '\\n') });
    expect(config?.host).toBe('api.sandbox.push.apple.com');
    expect(config?.bundleId).toBe('mn.basu.app');
    expect(config?.privateKey).toBe(privateKeyPem);
    expect(apnsConfigFromEnv({ APNS_TEAM_ID: 'T', APNS_KEY_ID: 'K', APNS_KEY: privateKeyPem, APNS_ENV: 'production' })?.host).toBe(
      'api.push.apple.com',
    );
  });
});
