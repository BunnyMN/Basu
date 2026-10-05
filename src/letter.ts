/**
 * The letter every email from Basu is set in.
 *
 * A code to sign in, an order that is ready, a business that was approved:
 * each arrives on the same paper, so that a person learns what Basu's mail
 * looks like and trusts it — the name over the meat on charcoal at the head,
 * one thing said plainly in the middle, and who we are at the foot.
 *
 * Basu is dark everywhere but here. Mail clients recolour a dark letter in
 * their own dark modes, and badly, so the paper stays light: the charcoal and
 * the meat are a picture no client repaints, and the one button is crimson,
 * as on every screen. The head says the name and no slogan, because the same
 * head opens the letter that says an order was cancelled.
 *
 * Built the way mail clients still need it: tables for layout, every style
 * inline, no web fonts (each face names the system faces that stand in for
 * it), images that say what they were when they are not shown, and nothing
 * that needs script. The plain-text twin is always sent beside it; this is
 * the nicety on top.
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
  /** Something to heed, set apart by a gold rule. */
  note?: string;
  /** The small print under it all. */
  small?: string;
}

/**
 * The banner: «Basu» over the landing page's chops on the charcoal ground,
 * 1200×400 for a 600×200 slot. A new picture takes a new name — the site
 * keeps brand pictures in a browser for a month, and a letter already sent
 * still points at the name it was sent with.
 */
const BANNER = '/brand/email/banner-dark.jpg';

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const C = {
  /** Around the paper: warm, a shade off white. */
  ground: '#F4F1EC',
  paper: '#FFFFFF',
  /** The site's ground, under the banner. */
  charcoal: '#100D0C',
  /** The site's ink on charcoal: the banner's alt text. */
  bone: '#F6F0E8',
  ink: '#140F0E',
  ink2: '#4A423E',
  ink3: '#6A605A',
  line: '#E8E1D8',
  /** The code's box and the note's. */
  soft: '#F6F2EC',
  crimson: '#D21F3C',
  gold: '#C9A96E',
};
const SANS = "Manrope,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/**
 * Basu's condensed display face where a reader has it, else the narrow cut
 * their system has: Avenir Next Condensed on Apple's, Arial Narrow on
 * Windows, Roboto Condensed on Android. For the code and the name only —
 * not every narrow cut has Ө and Ү — and the code bold, not the site's 800,
 * which Avenir draws as a blot.
 */
const CONDENSED =
  "'Noto Sans Display Condensed','Avenir Next Condensed','Arial Narrow','Roboto Condensed',sans-serif-condensed,'Helvetica Neue',Arial,sans-serif";

export function renderLetter(letter: Letter): string {
  const origin = publicOrigin();
  const link = (url: string) => (url.startsWith('/') ? `${origin}${url}` : url);

  const paragraphs = letter.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${C.ink2}">${esc(p)}</p>`)
    .join('');

  // Set apart by its letter-spacing; the same again on the left keeps the
  // digits centred, and the six of them fit a 320px phone.
  const code = letter.code
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr>
        <td align="center" bgcolor="${C.soft}" style="background:${C.soft};border:1px solid ${C.line};border-radius:16px;padding:20px 8px">
          <div style="font-family:${CONDENSED};font-size:44px;line-height:1;font-weight:700;font-stretch:condensed;font-variant-numeric:tabular-nums;letter-spacing:8px;color:${C.ink};padding-left:8px">${esc(letter.code)}</div>
        </td></tr></table>`
    : '';

  // A button every client draws: the cell is the crimson, so Outlook — which
  // pads no link — still shows a pill-sized block (mso-padding-alt), and
  // everywhere else the whole of it is the link.
  const action = letter.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px"><tr>
        <td align="center" bgcolor="${C.crimson}" style="background:${C.crimson};border-radius:999px;mso-padding-alt:15px 30px">
          <a href="${esc(link(letter.action.url))}" style="display:inline-block;padding:15px 30px;font-family:${SANS};font-size:16px;font-weight:700;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:999px;mso-padding-alt:0">${esc(letter.action.label)}&nbsp;→</a>
        </td></tr></table>`
    : '';

  const note = letter.note
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px"><tr>
        <td bgcolor="${C.soft}" style="background:${C.soft};border-left:3px solid ${C.gold};border-radius:4px 12px 12px 4px;padding:14px 16px;font-family:${SANS};font-size:14px;line-height:1.55;color:${C.ink2}">${esc(letter.note)}</td>
      </tr></table>`
    : '';

  const small = letter.small
    ? `<p style="margin:4px 0 0;font-family:${SANS};font-size:13px;line-height:1.55;color:${C.ink3}">${esc(letter.small)}</p>`
    : '';

  // Each promise holds together; the line breaks between them. Joined by
  // spaces that do not break, the three were one 420px word, and every letter
  // was wider than a phone: the whole card scrolled sideways. The checks part
  // them, so no dot is left hanging at the end of a wrapped line.
  const promise = ['Гэрээт нийлүүлэгч', 'Эцсийн үнэ', 'Таны захиалгаар нядална']
    .map((w) => `<span style="display:inline-block;white-space:nowrap;padding:2px 8px"><span style="color:${C.ink};font-weight:700">✓</span>&nbsp;${w}</span>`)
    .join(' ');

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
    <tr><td bgcolor="${C.charcoal}" style="background:${C.charcoal};border-radius:22px 22px 0 0;line-height:0;font-size:0">
      <img src="${origin}${BANNER}" width="600" height="200" alt="Basu" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;border-radius:22px 22px 0 0;font-family:${CONDENSED};font-size:32px;font-weight:800;line-height:1.2;color:${C.bone}">
    </td></tr>
    <tr><td bgcolor="${C.paper}" style="background:${C.paper};padding:32px 28px 26px">
      <h1 style="margin:0 0 14px;font-family:${SANS};font-size:28px;line-height:1.2;font-weight:700;letter-spacing:-0.4px;color:${C.ink}">${esc(letter.title)}</h1>
      ${paragraphs}${code}${action}${note}${small}
    </td></tr>
    <tr><td bgcolor="${C.paper}" style="background:${C.paper};border-top:1px solid ${C.line};border-radius:0 0 22px 22px;padding:16px 28px 20px;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.ink2}" align="center">${promise}</td></tr>
    <tr><td align="center" style="padding:22px 24px 0;font-family:${SANS};font-size:12px;line-height:1.7;color:${C.ink3}">
      <a href="${origin}/" style="color:${C.ink};font-weight:700;text-decoration:none">Basu</a> · Улаанбаатар · <a href="mailto:basuappmn@gmail.com" style="color:${C.ink3}">basuappmn@gmail.com</a><br>
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
