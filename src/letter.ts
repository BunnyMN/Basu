/**
 * The letter every email from Basu is set in.
 *
 * A code to sign in, an order that is ready, a business that was approved:
 * each arrives on the same paper, so that a person learns what Basu's mail
 * looks like and trusts it — pine at the head with the name, the meat under
 * it, one thing said plainly in the middle, and who we are at the foot.
 *
 * Built the way mail clients still need it: tables for layout, every style
 * inline, no web fonts, images that say what they were when they are not
 * shown, and nothing that needs script. The plain-text twin is always sent
 * beside it; this is the nicety on top.
 */

/** Where the site lives, for links and the pictures in a letter. */
export const publicOrigin = (): string =>
  (process.env['PUBLIC_ORIGIN']?.trim() || 'https://basu.burzai.cloud').replace(/\/+$/, '');

export interface Letter {
  /** The line an inbox shows after the subject, before the letter is opened. */
  preheader: string;
  title: string;
  /** Plain sentences; each becomes a paragraph. Never markup. */
  paragraphs: string[];
  /** A code to type, set large. */
  code?: string;
  /** The one thing to do next, as a button. `url` may be a path on the site. */
  action?: { label: string; url: string } | undefined;
  /** Something to heed, on honey. */
  note?: string;
  /** The small print under it all. */
  small?: string;
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const C = {
  ground: '#F4F3EE',
  paper: '#FFFFFF',
  deep: '#123A2C',
  pine: '#1F5A43',
  pineInk: '#1C5440',
  pineSoft: '#E3EFE8',
  honey: '#D9A441',
  honeyInk: '#7A5A12',
  honeySoft: '#FBF1DC',
  ink: '#181916',
  ink2: '#575A53',
  ink3: '#696C64',
  line: '#E2E0D8',
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

export function renderLetter(letter: Letter): string {
  const origin = publicOrigin();
  const link = (url: string) => (url.startsWith('/') ? `${origin}${url}` : url);

  const paragraphs = letter.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${C.ink2}">${esc(p)}</p>`)
    .join('');

  const code = letter.code
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr>
        <td align="center" bgcolor="${C.pineSoft}" style="background:${C.pineSoft};border-radius:14px;padding:22px 12px">
          <div style="font-family:${MONO};font-size:36px;line-height:1;font-weight:700;letter-spacing:8px;color:${C.pineInk};padding-left:8px">${esc(letter.code)}</div>
        </td></tr></table>`
    : '';

  const action = letter.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr>
        <td align="center" bgcolor="${C.pine}" style="background:${C.pine};border-radius:999px">
          <a href="${esc(link(letter.action.url))}" style="display:inline-block;padding:15px 30px;font-family:${SANS};font-size:16px;font-weight:600;line-height:1;color:#FFFFFF;text-decoration:none;border-radius:999px">${esc(letter.action.label)} →</a>
        </td></tr></table>`
    : '';

  const note = letter.note
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px"><tr>
        <td bgcolor="${C.honeySoft}" style="background:${C.honeySoft};border-radius:12px;padding:14px 16px;font-family:${SANS};font-size:14px;line-height:1.55;color:${C.honeyInk}">${esc(letter.note)}</td>
      </tr></table>`
    : '';

  const small = letter.small
    ? `<p style="margin:4px 0 0;font-family:${SANS};font-size:13px;line-height:1.55;color:${C.ink3}">${esc(letter.small)}</p>`
    : '';

  // Each promise holds together; the line breaks between them. Joined by
  // spaces that do not break, the three were one 420px word, and every letter
  // was wider than a phone: the whole card scrolled sideways.
  const promise = ['Гэрээт нийлүүлэгч', 'Эцсийн үнэ', 'Таны захиалгаар нядална']
    .map((w) => `<span style="white-space:nowrap"><span style="color:${C.pine}">✓</span>&nbsp;${w}</span>`)
    .join(' · ');

  return `<!doctype html>
<html lang="mn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(letter.title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.ground};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(letter.preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.ground}" style="background:${C.ground}">
<tr><td align="center" style="padding:24px 12px 32px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
    <tr><td bgcolor="${C.deep}" style="background:${C.deep};border-radius:18px 18px 0 0;padding:22px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font-family:${SANS};font-size:26px;font-weight:700;letter-spacing:-0.5px;color:#FFFFFF">Basu</td>
        <td align="right" style="font-family:${SANS};font-size:13px;color:#FFFFFF;opacity:0.85"><span style="color:${C.honey}">●</span>&nbsp;Өвлийн идэш</td>
      </tr></table>
    </td></tr>
    <tr><td bgcolor="${C.deep}" style="background:${C.deep};line-height:0;font-size:0">
      <img src="${origin}/brand/email/banner.jpg" width="600" alt="Шинэ мах. Эцсийн үнэ." style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;font-family:${SANS};font-size:16px;color:#FFFFFF">
    </td></tr>
    <tr><td bgcolor="${C.paper}" style="background:${C.paper};padding:34px 32px 28px">
      <h1 style="margin:0 0 14px;font-family:${SANS};font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-0.4px;color:${C.ink}">${esc(letter.title)}</h1>
      ${paragraphs}${code}${action}${note}${small}
    </td></tr>
    <tr><td bgcolor="${C.paper}" style="background:${C.paper};border-top:1px solid ${C.line};border-radius:0 0 18px 18px;padding:16px 32px 20px;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.ink2}" align="center">${promise}</td></tr>
    <tr><td align="center" style="padding:22px 24px 0;font-family:${SANS};font-size:12px;line-height:1.7;color:${C.ink3}">
      <a href="${origin}/" style="color:${C.pineInk};font-weight:600;text-decoration:none">Basu</a> · Улаанбаатар · <a href="mailto:basuappmn@gmail.com" style="color:${C.ink3}">basuappmn@gmail.com</a><br>
      <a href="${origin}/shop" style="color:${C.ink3}">Өвлийн идэш</a> &nbsp;·&nbsp; <a href="${origin}/orders" style="color:${C.ink3}">Миний захиалга</a> &nbsp;·&nbsp; <a href="${origin}/terms" style="color:${C.ink3}">Үйлчилгээний нөхцөл</a> &nbsp;·&nbsp; <a href="${origin}/privacy" style="color:${C.ink3}">Нууцлалын бодлого</a><br>
      Энэ захидлыг Basu танд илгээв. Асуух зүйл байвал дээрх хаягаар бичээрэй.
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Where a notification's button goes, by what it is about. Lunch lives in
 * the phone app, so a dine-in letter opens Basu's home; everything else has
 * a page on the site.
 */
export function actionFor(template: string, subjectId: string | null): Letter['action'] | undefined {
  if (template === 'auth.otp') return undefined;
  if (template.startsWith('idesh.') && subjectId) return { label: 'Захиалгаа харах', url: `/orders/${subjectId}` };
  if (template.startsWith('supplier.')) return { label: 'Нийлүүлэгчийн хэсэг', url: '/supplier' };
  if (template.startsWith('org.') || template.startsWith('ops.')) return { label: 'Самбар нээх', url: '/dashboard' };
  return { label: 'Basu нээх', url: '/home' };
}
