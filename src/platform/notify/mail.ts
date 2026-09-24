import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer, OutgoingMail } from '../../ports.js';

/**
 * Email, over SMTP.
 *
 * SMTP rather than one company's HTTP API, so that whatever is at hand today
 * works: a Gmail account with an app password, Resend, Brevo, Amazon SES,
 * Zoho — every one of them speaks it, and moving between them is a change to
 * one line of .env, not to this file.
 *
 *   SMTP_URL=smtps://you%40gmail.com:app-password@smtp.gmail.com:465
 *   SMTP_URL=smtps://resend:re_xxx@smtp.resend.com:465
 *   MAIL_FROM="Basu <noreply@basu.burzai.cloud>"
 *
 * Characters in the user or password that mean something in a URL (@ : / %)
 * are written percent-encoded, as above.
 */

export interface SmtpConfig {
  url: string;
  from: string;
}

/** Null when there is nowhere to send mail from. */
export function smtpConfigFromEnv(): SmtpConfig | null {
  const url = process.env['SMTP_URL']?.trim();
  const from = process.env['MAIL_FROM']?.trim();
  if (!url || !from) return null;
  return { url, from };
}

/** The host a URL points at, for the startup line — never the credentials in it. */
export function smtpHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable SMTP_URL';
  }
}

export class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  readonly #transport: Transporter;
  readonly #from: string;

  constructor(config: SmtpConfig) {
    this.#from = config.from;
    // A sign-in code that takes a minute to leave is a person staring at an
    // empty inbox; better to fail fast and let them ask again.
    const url = new URL(config.url);
    url.searchParams.set('connectionTimeout', '10000');
    url.searchParams.set('greetingTimeout', '10000');
    url.searchParams.set('socketTimeout', '20000');
    this.#transport = nodemailer.createTransport(url.toString());
  }

  async send(mail: OutgoingMail): Promise<{ providerRef: string }> {
    const info = await this.#transport.sendMail({
      from: this.#from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
    });
    return { providerRef: String(info.messageId ?? 'smtp') };
  }
}
