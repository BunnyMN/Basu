import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeNotifier, PushTokenGone } from '../../ports.js';
import { FcmClient, FcmNotifier, fcmConfigFromEnv, type FcmConfig } from './fcm.js';

/**
 * Firebase, against a server of our own standing in for Google's two: the one
 * that trades a signed JWT for an hour's access, and the one that sends.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let server: Server;
let base: string;
const tokenAsks: URLSearchParams[] = [];
const sends: Array<{ auth: string; body: { message: { token: string; data: Record<string, string>; android: { priority: string; ttl: string } } } }> = [];

const read = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text));
  });

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const text = await read(request);
    if (request.url === '/token') {
      tokenAsks.push(new URLSearchParams(text));
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3599 }));
      return;
    }
    const body = JSON.parse(text);
    sends.push({ auth: String(request.headers.authorization), body });
    const token = body.message.token as string;
    if (token === 'gone') {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
    } else if (token === 'ours-at-fault') {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }));
    } else {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'projects/basu-test/messages/1' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  tokenAsks.length = 0;
  sends.length = 0;
});

const config = (): FcmConfig => ({
  projectId: 'basu-test',
  clientEmail: 'push@basu-test.iam.gserviceaccount.com',
  privateKey: pem,
  tokenUrl: `${base}/token`,
  sendUrl: `${base}/send`,
});

describe('a message to an Android phone', () => {
  it('is sent with an hour’s access, signed by the service account and asked for once', async () => {
    const client = new FcmClient(config());
    await client.send({ token: 'phone-1', data: { type: 'call', call_id: 'c1' }, ttlSeconds: 45 });
    await client.send({ token: 'phone-2', data: { type: 'message', body: 'Бэлэн' }, ttlSeconds: 86_400 });
    expect(tokenAsks).toHaveLength(1);
    const ask = tokenAsks[0]!;
    expect(ask.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = ask.get('assertion')!.split('.');
    expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      iss: 'push@basu-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: `${base}/token`,
    });
    expect(sends[0]!.auth).toBe('Bearer ya29.test');
    expect(sends[0]!.body.message).toEqual({ token: 'phone-1', data: { type: 'call', call_id: 'c1' }, android: { priority: 'HIGH', ttl: '45s' } });
  });

  it('says a phone without the app is gone, but not a message of ours FCM refused', async () => {
    const client = new FcmClient(config());
    await expect(client.send({ token: 'gone', data: {}, ttlSeconds: 45 })).rejects.toBeInstanceOf(PushTokenGone);
    const refused = client.send({ token: 'ours-at-fault', data: {}, ttlSeconds: 45 });
    await expect(refused).rejects.toThrow(/FCM 400/);
    await expect(refused).rejects.not.toBeInstanceOf(PushTokenGone);
  });
});

describe('the notifier with Firebase on top', () => {
  it('sends an Android phone’s push to Firebase as a message the app draws, and everything else underneath', async () => {
    const apple = new FakeNotifier();
    const notifier = new FcmNotifier(config(), apple);
    await notifier.send({
      channel: 'push',
      to: 'android-token',
      platform: 'android',
      template: 'idesh.ready',
      title: 'Бэлэн',
      body: 'Мах тань бэлэн боллоо.',
      subject: 'idesh',
      subjectId: 'o1',
      badge: 2,
    });
    expect(sends[0]!.body.message.data).toEqual({
      type: 'message',
      template: 'idesh.ready',
      title: 'Бэлэн',
      body: 'Мах тань бэлэн боллоо.',
      subject: 'idesh',
      subject_id: 'o1',
      badge: '2',
    });
    await notifier.send({ channel: 'push', to: 'iphone-token', platform: 'ios', template: 't', body: 'b' });
    await notifier.send({ channel: 'sms', to: '+97699001122', template: 't', body: 'b' });
    expect(apple.sent.map((m) => m.to)).toEqual(['iphone-token', '+97699001122']);
    expect(sends).toHaveLength(1);
  });
});

describe('the environment', () => {
  const account = { project_id: 'basu-4e400', client_email: 'a@b.iam.gserviceaccount.com', private_key: pem };

  it('takes the service account as base64, the way the deploy carries it, or as JSON', () => {
    const b64 = Buffer.from(JSON.stringify(account)).toString('base64');
    expect(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: b64 })).toMatchObject({ projectId: 'basu-4e400', clientEmail: 'a@b.iam.gserviceaccount.com' });
    expect(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: JSON.stringify(account) })?.projectId).toBe('basu-4e400');
  });

  it('is nothing without one, with «-», or with one that is not a service account', () => {
    expect(fcmConfigFromEnv({})).toBeNull();
    expect(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: '-' })).toBeNull();
    expect(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: Buffer.from('{"project_id":"x"}').toString('base64') })).toBeNull();
    expect(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: 'not base64 json' })).toBeNull();
  });
});
