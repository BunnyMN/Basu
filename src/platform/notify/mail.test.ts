import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../db/pool.js';
import { at } from '../../domain/fixtures.js';
import { VirtualClock } from '../../domain/time.js';
import { FakeMailer, FakeNotifier, FakePaymentProvider, FakeTaxProvider, type Ctx } from '../../ports.js';
import { seedPerson, truncateAll } from '../../test/seed.js';
import { SmtpMailer, smtpConfigFromEnv, smtpHost } from './mail.js';
import { enqueue, relay } from './messages.js';

/**
 * Email, faked at the wire, and the relay's use of it.
 *
 * The SMTP server below speaks just enough of the protocol to take a letter.
 * What it catches is the mailer we ship not producing a letter at all — a
 * transport option nodemailer does not understand, a missing From — which a
 * fake behind the port would never notice.
 */

let server: Server;
let port: number;
const letters: string[] = [];

beforeAll(async () => {
  server = createServer((socket) => {
    let inData = false;
    let buffer = '';
    let letter = '';
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            letters.push(letter);
            letter = '';
            socket.write(`250 OK queued as t${letters.length}\r\n`);
          } else {
            letter += `${line}\n`;
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-test\r\n250 8BITMIME\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT' || verb === 'RSET' || verb === 'NOOP') socket.write('250 OK\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
        } else socket.write('502 not here\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('the SMTP mailer', () => {
  it('hands the server a letter with the sender, the subject and the words', async () => {
    const mailer = new SmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: 'Basu <noreply@basu.test>' });
    const sent = await mailer.send({ to: 'bat@example.mn', subject: 'Basu нэвтрэх код: 123456', text: 'Таны код: 123456' });
    expect(sent.providerRef).toBeTruthy();
    const letter = letters.at(-1)!;
    expect(letter).toMatch(/^From: Basu <noreply@basu\.test>$/m);
    expect(letter).toMatch(/^To: bat@example\.mn$/m);
    // Mongolian travels base64-encoded, in the subject and in the body alike;
    // read back, it is what was sent.
    const [head = '', body = ''] = letter.split('\n\n');
    const subject = /^Subject: (.*(?:\n .*)*)/m.exec(head)![1]!;
    const words = [...subject.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)].map((m) => Buffer.from(m[1]!, 'base64'));
    expect(Buffer.concat(words).toString('utf8')).toBe('Basu нэвтрэх код: 123456');
    expect(head).toMatch(/^Content-Transfer-Encoding: base64$/m);
    expect(Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8')).toBe('Таны код: 123456');
  });

  it('is configured from two lines of .env, and never says the password out loud', () => {
    process.env['SMTP_URL'] = 'smtps://bat%40gmail.com:very-secret@smtp.gmail.com:465';
    delete process.env['MAIL_FROM'];
    expect(smtpConfigFromEnv()).toBeNull();
    process.env['MAIL_FROM'] = 'Basu <bat@gmail.com>';
    expect(smtpConfigFromEnv()).toEqual({ url: process.env['SMTP_URL'], from: 'Basu <bat@gmail.com>' });
    expect(smtpHost(process.env['SMTP_URL'])).toBe('smtp.gmail.com:465');
    delete process.env['SMTP_URL'];
    delete process.env['MAIL_FROM'];
  });
});

describe('the relay', () => {
  let ctx: Ctx;
  let mailer: FakeMailer;
  let notifier: FakeNotifier;

  beforeEach(async () => {
    await truncateAll();
    mailer = new FakeMailer();
    notifier = new FakeNotifier();
    ctx = { clock: new VirtualClock(at('11:40')), payments: new FakePaymentProvider(), tax: new FakeTaxProvider(), notifier, mailer };
  });

  it('reaches somebody who signed up with only an address, by email', async () => {
    const id = await seedPerson({ email: 'bat@example.mn' });
    await enqueue(ctx, { guestId: id, template: 'idesh.ready', title: 'Захиалга бэлэн', body: 'Таны мах бэлэн боллоо.', channel: 'push' });
    expect(await relay(ctx)).toBe(1);
    expect(mailer.to('bat@example.mn')).toMatchObject({ subject: 'Basu · Захиалга бэлэн', text: 'Таны мах бэлэн боллоо.' });
    const { rows } = await getPool().query('SELECT state, channel FROM notify.message');
    expect(rows).toEqual([{ state: 'sent', channel: 'email' }]);
  });

  it('prefers email to the phone while SMS is not running, and falls back to the phone if the letter fails', async () => {
    const id = await seedPerson({ phone: '+97699001122', email: 'bat@example.mn' });
    await enqueue(ctx, { guestId: id, template: 'a', body: 'нэг', channel: 'sms', dedupeKey: 'one' });
    await relay(ctx);
    expect(mailer.sent).toHaveLength(1);

    mailer.failNext = true;
    await enqueue(ctx, { guestId: id, template: 'b', body: 'хоёр', channel: 'sms', dedupeKey: 'two' });
    await relay(ctx);
    expect(notifier.sent.at(-1)).toMatchObject({ channel: 'sms', to: '+97699001122', body: 'хоёр' });
  });

  it('marks a message failed when there is no way to reach the person', async () => {
    const { mailer: _, ...noMail } = ctx;
    const id = await seedPerson({ email: 'bat@example.mn' });
    await enqueue(noMail, { guestId: id, template: 'a', body: 'нэг', channel: 'push' });
    expect(await relay(noMail)).toBe(0);
    const { rows } = await getPool().query('SELECT state FROM notify.message');
    expect(rows).toEqual([{ state: 'failed' }]);
  });
});
