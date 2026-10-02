/* Shared plumbing for the demo pages: fetch with the right token, the
   clock strip, and a toast. Kept dependency-free — a PWA that has to compile
   before it can be looked at is a PWA nobody looks at. */

export const store = {
  /**
   * The person signed in on this browser — on the website, the dashboard and
   * the supplier's screen alike. One browser holds one person. The dashboard
   * once kept a sign-in of its own beside this one; nothing on the website
   * touched it, and a browser where the admin had opened the desk opened it
   * again for whoever signed in there next.
   */
  get guestToken() {
    return localStorage.getItem('basu.guest');
  },
  set guestToken(v) {
    v ? localStorage.setItem('basu.guest', v) : localStorage.removeItem('basu.guest');
  },
  /** The kitchen screen's own session: the person running it, apart from any guest on the same browser. */
  get kitchenToken() {
    return localStorage.getItem('basu.kitchen');
  },
  set kitchenToken(v) {
    v ? localStorage.setItem('basu.kitchen', v) : localStorage.removeItem('basu.kitchen');
  },
};

/**
 * End a session on the server, not only in this browser: a token forgotten
 * here but alive there is still a way in for whoever copies it. Nothing to
 * wait for — forgotten here is signed out here, and the request outlives
 * the page that sent it.
 */
export function endSession(token) {
  if (!token) return;
  fetch('/v1/auth/sign-out', { method: 'POST', headers: { authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {});
}

/**
 * A sign-in came in: from now on it is this browser's person. Whoever was
 * signed in here before is signed out, on the server too — their session is
 * not left alive in a browser that has moved on to somebody else.
 */
export function takeSession(token) {
  const before = store.guestToken;
  store.guestToken = token;
  if (before && before !== token) endSession(before);
}

/** Sign the person out: forget the session here and end it there. */
export function dropSession() {
  const token = store.guestToken;
  store.guestToken = null;
  endSession(token);
}

// Earlier builds kept the dashboard's sign-in under a key of its own, and it
// outlived every sign-in and sign-out on the rest of the site. It is dropped,
// and ended on the server unless it is the very session the site holds.
try {
  const legacy = localStorage.getItem('basu.ops');
  if (legacy) {
    localStorage.removeItem('basu.ops');
    if (legacy !== store.guestToken) endSession(legacy);
  }
} catch {
  // No storage here: nothing was kept.
}

export class ApiError extends Error {
  constructor(status, body) {
    // The server already wrote this in Mongolian; showing anything else would
    // be inventing a second, worse explanation of the same thing.
    super(body?.error?.message_mn ?? 'Алдаа гарлаа.');
    this.status = status;
    this.code = body?.error?.code ?? 'UNKNOWN';
  }
}

/**
 * What a failure says to the person in front of it: the server's own words
 * when it answered, and plain ones when it never could. A request the
 * network dropped fails in the browser's words — «Failed to fetch», «Load
 * failed» — which are English, and do not say to try again.
 */
export function whatWentWrong(error) {
  return error instanceof ApiError ? error.message : 'Холболт тасарлаа. Дахин оролдоно уу.';
}

export async function api(path, { method = 'GET', body, token, idempotencyKey, headers: extra = {}, signal } = {}) {
  const headers = { ...extra };
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed;
}

/* ── the Basu shell ────────────────────────────────────────────────── */

/**
 * The native app, when this page is inside it.
 *
 * On a phone the launcher, the wallet and the lock screen are Swift, and this
 * page is one icon inside them — loaded in a web view, signed in as the
 * shell's guest. The shell puts its token in `localStorage['basu.guest']`
 * before the page runs, so nothing here changes. Two things do need the
 * shell: signing in, which is the shell's sheet and not this page's, and
 * telling it that an order moved so the card outside the page catches up now
 * rather than on its next poll.
 *
 * In a browser `present` is false and every call here is a no-op — the page
 * signs itself in the demo way, as it always did.
 */
export const shell = {
  get present() {
    return Boolean(globalThis.webkit?.messageHandlers?.basu);
  },

  post(message) {
    if (shell.present) globalThis.webkit.messageHandlers.basu.postMessage(message);
  },

  /**
   * Ask the shell for a guest. Resolves with the token once the person has
   * signed in on the shell's own sheet; rejects if they closed it instead.
   */
  signIn() {
    return new Promise((resolve, reject) => {
      globalThis.__basuSignedIn = (token) => {
        delete globalThis.__basuSignedIn;
        if (token) {
          store.guestToken = token;
          resolve(token);
        } else {
          reject(new ApiError(401, { error: { code: 'SIGN_IN', message_mn: 'Нэвтрээгүй байна.' } }));
        }
      };
      shell.post({ type: 'signIn' });
    });
  },

  /** An order of the guest's changed — the shell's card should say so too. */
  ordersChanged() {
    shell.post({ type: 'orders' });
  },
};

// Pages style the seam with one class: inside the shell the way back sits
// where iOS puts a back control, on the leading edge, and nothing a
// developer needs is drawn.
if (shell.present && typeof document !== 'undefined') {
  document.documentElement.classList.add('in-shell');
  // «‹ Basu» is the web launcher (/app) in a browser and the shell's own
  // launcher in the app. Said to the shell as a message rather than left for
  // it to recognise the address: the builds already on phones knew only /,
  // and loaded the web launcher inside themselves once it moved to /app.
  document.addEventListener('click', (event) => {
    const home = event.target instanceof Element ? event.target.closest('a#home') : null;
    if (!home) return;
    event.preventDefault();
    shell.post({ type: 'home' });
  });
}

/* ── signing in on the web ─────────────────────────────────────────── */

/** Which doors this server has open. Asked once; a failed ask leaves the password door alone. */
let doorsAsked;
export function authMethods() {
  doorsAsked ??= api('/v1/auth/methods').catch(() => ({ password: true, email: false, google: false, apple: false }));
  return doorsAsked;
}

/** Why a round trip to Google came back without a session. */
const GOOGLE_REFUSALS = {
  CANCELLED: 'Google-ээр нэвтрэхийг цуцаллаа.',
  SOCIAL_CLOSED: 'Google-ээр нэвтрэх одоогоор нээгдээгүй байна.',
  SOCIAL_REFUSED: 'Google-ээр нэвтэрч чадсангүй. Дахин оролдоно уу.',
};

/**
 * How long a page waits for the server to trade its code (below). Every page
 * that came back from Google waits for that before it draws anything, so a
 * claim that never answers — a stalled connection, a server restarting —
 * would leave it blank. Past this it is a refused claim like any other: the
 * page draws its door and says so, and the person signs in again.
 */
const CLAIM_WAIT_MS = 15_000;

/**
 * A signal that gives up after `ms`. Safari before 16 has no
 * AbortSignal.timeout, and there a timer does the same: a limit there too,
 * rather than none.
 */
function giveUpAfter(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Back from Google. The server sends the person to the page they started on
 * with a one-time code in the address's fragment — `/login#auth_code=…` —
 * and never the session. A fragment reaches no server and no log, but the
 * browser's history keeps the address as it was visited, fragment and all,
 * and Chrome syncs that history to the person's other devices; wiping the
 * address bar does not reach it. So the page trades the code for the session
 * here, and the server gives it only once, within a minute, and only to the
 * browser that went to Google — it set a cookie there on the way back, and
 * wants it with the code. A code read out of a history is spent; one sent to
 * somebody else in a link opens nothing in their browser.
 *
 * A session in the address — `#auth=…`, the way this once worked — is never
 * taken: a page that took one signed whoever opened a link into the account
 * of whoever made it.
 *
 * The fragment is wiped at once, before the page's own script runs and
 * before anything waits on the network. Pages await this before asking who
 * is signed in: `{ token }` once the code has become a session, `{ refused }`
 * when Google or the server said no — or never answered (`CLAIM_WAIT_MS`) —
 * and null when the page did not come back from Google at all.
 */
export const authReturn = (async () => {
  if (typeof location === 'undefined' || !location.hash.includes('auth')) return null;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const code = fragment.get('auth_code');
  const refused = fragment.get('auth_error');
  if (!code && !refused && !fragment.has('auth')) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (refused) {
    setTimeout(() => toast(GOOGLE_REFUSALS[refused] ?? GOOGLE_REFUSALS.SOCIAL_REFUSED, 'bad'), 0);
    return { refused };
  }
  if (!code) return null;
  try {
    const { token } = await api('/v1/auth/handoff', { method: 'POST', body: { code }, signal: giveUpAfter(CLAIM_WAIT_MS) });
    // The kitchen screen keeps a session of its own (`data-session` on its
    // root) and decides where this one goes. Everywhere else — the dashboard
    // too — the sign-in that just came back is the person, whoever was
    // signed in here before.
    if (!document.documentElement.dataset.session) takeSession(token);
    return { token };
  } catch (error) {
    // Anything but the server's own answer — a timeout, a dropped connection
    // — is a refusal in general words; a timeout's `code` is a number of the
    // browser's, not one of ours.
    toast(error instanceof ApiError ? error.message : GOOGLE_REFUSALS.SOCIAL_REFUSED, 'bad');
    return { refused: error instanceof ApiError ? error.code : 'SOCIAL_REFUSED' };
  }
})();

/**
 * Facebook's, Instagram's and LINE's own browsers — where a link shared there
 * opens. Google refuses to sign anybody in inside them, with a page of its
 * own in English, so the doors leave Google out there, lead with the code by
 * email, and say where Google does work.
 */
export const inAppBrowser = () => typeof navigator !== 'undefined' && /FBAN|FBAV|FB_IAB|Instagram|Line\//.test(navigator.userAgent ?? '');

/** Why Google is not offered in an in-app browser, and where it is. */
export const IN_APP_GOOGLE = 'Google-ээр нэвтрэх бол Safari эсвэл Chrome-д нээнэ үү.';

/** Google's mark, in Google's colours — its button guidelines ask for exactly this. */
const GOOGLE_MARK = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

/**
 * The ways in, as one block a page puts in a sheet or on a card.
 *
 * Google first: one tap for most people here. Then a code by email, which
 * needs nothing but an inbox — the address becomes the account the first
 * time a code sent to it comes back. A password is one fold down: signing in
 * with an address or a phone number, signing up with an address, and getting
 * a forgotten password back — each of the last two by a code to the inbox,
 * because there is no SMS and a password nobody can reset is a door that
 * locks for good. Only the doors this server has open are drawn; with
 * neither Google nor email set up, the password is the whole block, open,
 * and signing up falls back to a phone number.
 *
 * `onToken(token)` is called once there is a session. Google does not call
 * it: the page is left for Google's and comes back to `returnTo`, where
 * `authReturn` above claims the sign-in. `keep: false` leaves the token for
 * `onToken` to put where it belongs (the kitchen keeps its own);
 * `password: false` leaves the fold out. `box.ready` resolves with which
 * doors were drawn.
 */
const EMAIL_HINT = 'Хаяг руу тань 6 оронтой код илгээнэ. Анх удаа бол бүртгэл шууд үүснэ.';

export function signInDoors({
  device = 'Вэб',
  returnTo = location.pathname,
  onToken,
  keep = true,
  password: withPassword = true,
  emailHint = EMAIL_HINT,
}) {
  const box = document.createElement('div');
  box.className = 'ways';
  box.innerHTML = `
    <a class="btn" data-size="lg" data-google hidden>${GOOGLE_MARK}<span>Google-ээр нэвтрэх</span></a>
    <div class="or" data-or hidden>эсвэл</div>
    <div data-email hidden>
      <label class="field"><span>Имэйл хаяг</span><input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="нэр@gmail.com"></label>
      <p class="cap" data-email-hint></p>
      <div class="field" data-code hidden><input name="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" aria-label="Имэйлд ирсэн код"></div>
      <p class="ways-say" data-email-say role="alert" hidden></p>
      <button class="btn" data-v="primary" data-size="lg" type="button" data-email-go>Код авах</button>
      <div class="again" data-again-row hidden>
        <button class="link" type="button" data-resend>Код дахин авах</button>
        <button class="link" type="button" data-change>Хаяг солих</button>
      </div>
    </div>
    <p class="cap" data-in-app style="margin:14px 0 0;text-align:center" hidden></p>
    <details class="fold" data-password>
      <summary>Нууц үгээр нэвтрэх, бүртгүүлэх</summary>
      <div class="body">
        <label class="field" data-f="name" hidden><span>Нэр</span><input name="name" autocomplete="name" placeholder="Таны нэр"></label>
        <label class="field" data-f="login"><span data-login-label>Имэйл эсвэл утас</span><input name="login" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="нэр@gmail.com · 8811 2233"></label>
        <div class="field" data-f="code" hidden><input name="pwcode" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" aria-label="Имэйлд ирсэн код"></div>
        <label class="field" data-f="password"><span data-password-label>Нууц үг</span><input name="password" type="password" autocomplete="current-password" placeholder="Дор хаяж 8 тэмдэгт"></label>
        <p class="cap" data-pw-hint hidden></p>
        <p class="ways-say" data-pw-say role="alert" hidden></p>
        <button class="btn" data-size="lg" type="button" data-go>Нэвтрэх</button>
        <div class="again">
          <button class="link" type="button" data-to-a></button>
          <button class="link" type="button" data-to-b></button>
        </div>
      </div>
    </details>`;
  const $ = (selector) => box.querySelector(selector);
  const done = (token) => {
    if (keep) takeSession(token);
    onToken(token);
  };
  /*
   * Trouble is said where it happened: a field that is empty or wrong says so
   * under itself; a refusal that is about nothing typed — a dropped
   * connection, too many tries — over the button that will try again. Never
   * in a toast at the far edge of the screen, and never in the browser's
   * English. Typing again takes the word back.
   */
  const sayer = (line) => (message) => {
    line.textContent = message ?? '';
    line.hidden = !message;
  };
  const mends = (...inputs) => {
    for (const input of inputs) input.addEventListener('input', () => input.getAttribute('aria-invalid') === 'true' && fieldError(input, null));
  };

  /* Google: a plain link, so the browser does the leaving. The press shows at
     once (the trip to Google takes a moment), and a page brought back by the
     browser's back button is not left turning. */
  const google = $('[data-google]');
  google.href = `/v1/auth/google/start?return=${encodeURIComponent(returnTo)}`;
  google.addEventListener('click', (e) => {
    if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) setBusy(google);
  });
  addEventListener('pageshow', () => setBusy(google, false));

  /* a code by email */
  const email = $('[name="email"]');
  const code = $('[name="code"]');
  const emailGo = $('[data-email-go]');
  const hint = $('[data-email-hint]');
  const emailSay = sayer($('[data-email-say]'));
  hint.textContent = emailHint;
  let sentTo = null;
  mends(email, code);

  const askForCode = async () => {
    const address = email.value.trim();
    emailSay(null);
    if (!address) {
      fieldError(email, 'Имэйл хаягаа бичнэ үү.');
      email.focus();
      return;
    }
    if (emailGo.hasAttribute('data-busy')) return;
    setBusy(emailGo);
    try {
      await api('/v1/auth/email/start', { method: 'POST', body: { email: address } });
      sentTo = address;
      fieldError(email, null);
      fieldError(code, null);
      $('[data-code]').hidden = false;
      $('[data-again-row]').hidden = false;
      hint.textContent = `${address} хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Спам хавтсаа шалгаарай.`;
      emailGo.textContent = 'Нэвтрэх';
      code.value = '';
      code.focus();
    } catch (error) {
      // The server's word is about the address; a dropped line is about nothing typed.
      if (error instanceof ApiError) fieldError(email, error.message);
      else emailSay(whatWentWrong(error));
    } finally {
      setBusy(emailGo, false);
    }
  };

  const checkCode = async () => {
    const typed = code.value.replace(/\D/g, '');
    // A new try starts clean: the last try's «Код буруу байна.» is not this one's answer.
    emailSay(null);
    fieldError(code, null);
    if (typed.length !== 6) {
      fieldError(code, 'Имэйлд ирсэн 6 оронтой кодоо бичнэ үү.');
      code.focus();
      return;
    }
    if (emailGo.hasAttribute('data-busy')) return;
    setBusy(emailGo);
    try {
      const { token } = await api('/v1/auth/email/verify', { method: 'POST', body: { email: sentTo, code: typed, device } });
      done(token);
    } catch (error) {
      if (error instanceof ApiError) fieldError(code, error.message);
      else emailSay(whatWentWrong(error));
      code.select();
    } finally {
      setBusy(emailGo, false);
    }
  };

  const startOver = () => {
    sentTo = null;
    $('[data-code]').hidden = true;
    $('[data-again-row]').hidden = true;
    fieldError(code, null);
    emailSay(null);
    hint.textContent = emailHint;
    emailGo.textContent = 'Код авах';
  };

  emailGo.addEventListener('click', () => (sentTo ? checkCode() : askForCode()));
  email.addEventListener('keydown', (e) => e.key === 'Enter' && askForCode());
  // Another address after a code went out is a new start, not a code for the old one.
  email.addEventListener('input', () => sentTo && email.value.trim() !== sentTo && startOver());
  code.addEventListener('keydown', (e) => e.key === 'Enter' && checkCode());
  // Six digits is the whole code: pasted or typed, it goes without another tap.
  code.addEventListener('input', () => code.value.replace(/\D/g, '').length === 6 && checkCode());
  $('[data-resend]').addEventListener('click', askForCode);
  $('[data-change]').addEventListener('click', () => {
    startOver();
    email.select();
  });

  /*
   * A password. Three faces on one fold: signing in by an address or a
   * number; signing up by an address, whose code comes back before the
   * account is made; and a forgotten password, replaced by a code to the
   * address on the account. `step` is where a sign-up or a reset stands:
   * 'ask' until a code has gone, 'code' after.
   */
  const pw = {
    name: $('[name="name"]'),
    login: $('[name="login"]'),
    code: $('[name="pwcode"]'),
    password: $('[name="password"]'),
    hint: $('[data-pw-hint]'),
    go: $('[data-go]'),
    toA: $('[data-to-a]'),
    toB: $('[data-to-b]'),
  };
  let face = 'in';
  let step = 'ask';
  /** Whether sign-up and reset can go by email; without it, sign-up is by phone and there is no reset. */
  let byEmail = true;
  /** The login the code went for: typing another starts over. */
  let codeFor = null;

  const show = (field, on) => {
    $(`[data-f="${field}"]`).hidden = !on;
  };
  const say = (text) => {
    pw.hint.textContent = text ?? '';
    pw.hint.hidden = !text;
  };

  const draw = () => {
    const coded = step === 'code';
    show('name', face === 'up' && !coded);
    show('login', !(face === 'up' && coded));
    show('code', coded);
    // A sign-up's password was chosen before the code went; after it, only the code is asked.
    show('password', face === 'in' || (face === 'up' && !coded) || (face === 'forgot' && coded));
    $('[data-login-label]').textContent =
      face === 'in' || face === 'forgot' ? 'Имэйл эсвэл утас' : byEmail ? 'Имэйл хаяг' : 'Утасны дугаар';
    pw.login.placeholder = face === 'up' ? (byEmail ? 'нэр@gmail.com' : '+976 XXXX XXXX') : 'нэр@gmail.com · 8811 2233';
    pw.login.type = face === 'up' && byEmail ? 'email' : 'text';
    pw.login.inputMode = face === 'up' ? (byEmail ? 'email' : 'tel') : 'email';
    $('[data-password-label]').textContent = face === 'in' ? 'Нууц үг' : face === 'up' ? 'Нууц үг сонгох' : 'Шинэ нууц үг';
    // A password manager offers the saved one to sign in, and a new one otherwise.
    pw.password.autocomplete = face === 'in' ? 'current-password' : 'new-password';
    // Never «Код авах»: that is the email door's button, just above.
    pw.go.textContent =
      face === 'in' ? 'Нэвтрэх' : face === 'up' ? (coded ? 'Баталгаажуулах' : 'Бүртгүүлэх') : coded ? 'Нууц үгээ шинэчлэх' : 'Сэргээх код авах';
    if (face === 'in') {
      pw.toA.textContent = 'Нууц үгээ мартсан?';
      pw.toA.hidden = !byEmail;
      pw.toB.textContent = 'Бүртгүүлэх';
    } else {
      pw.toA.textContent = coded ? 'Код дахин авах' : '';
      pw.toA.hidden = !coded;
      pw.toB.textContent = face === 'up' ? 'Бүртгэлтэй юу? Нэвтрэх' : 'Буцах';
    }
    if (face === 'in') say(null);
    else if (!coded) {
      say(face === 'up'
        ? byEmail
          ? 'Хаяг руу тань 6 оронтой код илгээнэ. Кодоо оруулмагц бүртгэл үүснэ.'
          : 'Утасны дугаар, өөрийн сонгосон нууц үгээр бүртгэл үүснэ.'
        : 'Бүртгэлтэй имэйл эсвэл утасны дугаараа бичнэ үү. Бүртгэлийн имэйл рүү тань код илгээнэ.');
    }
  };

  const pwSay = sayer($('[data-pw-say]'));
  mends(pw.name, pw.login, pw.code, pw.password);
  /** A field that must be filled and is not, said under it; true when it was. */
  const missing = (input, message = 'Бөглөнө үү.') => {
    fieldError(input, message);
    input.focus();
    return true;
  };
  const SHORT = 'Нууц үг дор хаяж 8 тэмдэгт байх ёстой.';

  const turnTo = (next) => {
    face = next;
    step = 'ask';
    codeFor = null;
    pw.code.value = '';
    pw.password.value = '';
    for (const input of [pw.name, pw.login, pw.code, pw.password]) fieldError(input, null);
    pwSay(null);
    draw();
    (face === 'up' ? pw.name : pw.login).focus();
  };

  const busy = async (work) => {
    if (pw.go.hasAttribute('data-busy')) return;
    setBusy(pw.go);
    pwSay(null);
    fieldError(pw.code, null);
    try {
      await work();
    } catch (error) {
      // A wrong or spent code is the code field's; any other refusal is said over the button.
      if (step === 'code' && error.code && /CODE|EXPIRED/.test(error.code)) {
        fieldError(pw.code, error.message);
        pw.code.select();
      } else pwSay(whatWentWrong(error));
    } finally {
      setBusy(pw.go, false);
    }
  };

  /** A code for signing up or resetting, to the inbox behind the login. */
  const askForPasswordCode = () =>
    busy(async () => {
      const login = pw.login.value.trim();
      if (!login) return missing(pw.login);
      if (face === 'up' && pw.password.value.length < 8) return missing(pw.password, SHORT);
      const { to } = await api('/v1/auth/password/code', {
        method: 'POST',
        body: { login, purpose: face === 'up' ? 'sign_up' : 'reset' },
      });
      codeFor = login;
      step = 'code';
      pw.code.value = '';
      draw();
      say(`${to} хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Спам хавтсаа шалгаарай.`);
      pw.code.focus();
    });

  /** The code and the password: an account made, or a password replaced — and a session either way. */
  const setPassword = () =>
    busy(async () => {
      const typed = pw.code.value.replace(/\D/g, '');
      if (typed.length !== 6) return missing(pw.code, 'Имэйлд ирсэн 6 оронтой кодоо бичнэ үү.');
      if (pw.password.value.length < 8) return missing(pw.password, SHORT);
      const { token, created } = await api('/v1/auth/password', {
        method: 'POST',
        body: { login: codeFor, code: typed, password: pw.password.value, name: pw.name.value.trim() || undefined, device },
      });
      if (face === 'forgot') toast('Нууц үг шинэчлэгдлээ. Бусад төхөөрөмжөөс гаргалаа.', 'good');
      else if (!created) toast('Энэ имэйлээр бүртгэл байсан — нууц үгийг нь шинэчилж нэвтэрлээ.', 'good');
      done(token);
    });

  const signIn = () =>
    busy(async () => {
      const login = pw.login.value.trim();
      if (!login) return missing(pw.login);
      if (!pw.password.value) return missing(pw.password);
      const { token } = await api('/v1/auth/login', { method: 'POST', body: { login, password: pw.password.value, device } });
      done(token);
    });

  /** Without email, a sign-up is a number and a password, as it was before there was email. */
  const signUpByPhone = () =>
    busy(async () => {
      const { token } = await api('/v1/auth/register', {
        method: 'POST',
        body: { phone: pw.login.value.replace(/\s+/g, ''), password: pw.password.value, name: pw.name.value.trim() || undefined, device },
      });
      done(token);
    });

  const go = () => {
    if (face === 'in') return signIn();
    if (face === 'up' && !byEmail) return signUpByPhone();
    return step === 'code' ? setPassword() : askForPasswordCode();
  };

  pw.go.addEventListener('click', go);
  for (const input of [pw.name, pw.login, pw.password]) input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  pw.code.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  // Six digits and a password already there: it goes without another tap.
  pw.code.addEventListener('input', () => {
    if (pw.code.value.replace(/\D/g, '').length === 6 && pw.password.value.length >= 8) setPassword();
  });
  // Another login after a code went out is a new start, not a code for the old one.
  pw.login.addEventListener('input', () => {
    if (codeFor && pw.login.value.trim() !== codeFor) {
      step = 'ask';
      codeFor = null;
      draw();
    }
  });
  pw.toA.addEventListener('click', () => (face === 'in' ? turnTo('forgot') : askForPasswordCode()));
  pw.toB.addEventListener('click', () => turnTo(face === 'in' ? 'up' : 'in'));
  draw();

  /* only the doors that are open */
  if (!withPassword) $('[data-password]').remove();
  box.ready = authMethods().then((open) => {
    // Google will not sign anybody in inside an app's web view: Basu's own app
    // has its own sheet, and Facebook's or Instagram's browser gets Google's
    // refusal in English — there the code by email leads, and a line says
    // where Google does work.
    const refused = Boolean(open.google) && !shell.present && inAppBrowser();
    const googleOpen = Boolean(open.google) && !shell.present && !refused;
    google.hidden = !googleOpen;
    $('[data-email]').hidden = !open.email;
    $('[data-or]').hidden = !(googleOpen && open.email);
    const why = $('[data-in-app]');
    why.textContent = refused ? IN_APP_GOOGLE : '';
    why.hidden = !refused;
    const passwordAlone = !googleOpen && !open.email;
    byEmail = Boolean(open.email);
    draw();
    if (withPassword) {
      const fold = $('[data-password]');
      fold.open = passwordAlone;
      fold.toggleAttribute('data-alone', passwordAlone);
    }
    (open.email ? email : passwordAlone && withPassword ? pw.login : google).focus?.();
    return { google: googleOpen, email: Boolean(open.email) };
  });
  return box;
}

/**
 * A person, in a browser, outside the phone app: the ways in, on a sheet.
 * Resolves with a token; rejects if they close it.
 *
 * Inside the app the shell signs people in on its own sheet and this never
 * appears. On a developer's machine /dev/login answers first. On the real
 * server neither is there, and this is the way in.
 */
export function signInSheet(reason = 'Үргэлжлүүлэхийн тулд нэвтэрнэ үү.') {
  return new Promise((resolve, reject) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.setAttribute('data-open', '');
    const sheet = document.createElement('div');
    sheet.className = 'sheet signin-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'signin-title');
    sheet.tabIndex = -1;
    sheet.innerHTML = `
      <header role="none">
        <div><h2 id="signin-title">Нэвтрэх</h2><div class="sub"></div></div>
        <button class="x" type="button" aria-label="Хаах"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </header>
      <div class="body" style="padding:16px 20px 20px"></div>`;
    sheet.querySelector('header .sub').textContent = reason;

    let settled = false;
    let wake = () => {};
    const opener = document.activeElement;
    // Esc closes it, as it closes a popup; the focus goes back to what opened it.
    const onKey = (e) => {
      if (e.key !== 'Escape' || !sheet.hasAttribute('data-open')) return;
      e.preventDefault();
      close(null);
    };
    const close = (token) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      sheet.removeAttribute('data-open');
      scrim.removeAttribute('data-open');
      setTimeout(() => {
        sheet.remove();
        scrim.remove();
      }, 260);
      wake();
      if (!token && opener?.isConnected) opener.focus?.();
      if (token) resolve(token);
      else reject(new ApiError(401, { error: { code: 'SIGN_IN', message_mn: 'Нэвтрээгүй байна.' } }));
    };

    sheet.querySelector('.body').append(signInDoors({ device: 'Вэб', onToken: close }));
    document.body.append(scrim, sheet);
    // As a popup: the page sleeps behind it, and the keyboard starts inside it.
    wake = popupHush(scrim, sheet);
    requestAnimationFrame(() => {
      sheet.setAttribute('data-open', '');
      sheet.focus?.();
    });
    sheet.querySelector('.x').addEventListener('click', () => close(null));
    scrim.addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKey, true);
  });
}

/* ── the ways back into an account ─────────────────────────────────── */

/**
 * On the page where a person sees their own account: its address and its
 * password. The address is the way a forgotten password comes back — there
 * is no SMS — so an account made by phone is asked, plainly, to add one.
 *
 * Neither is given on the session's word, so that a session left open
 * somewhere cannot give itself a way back in. Adding an address sends a code
 * there, and an account with a password types it too. An account with no
 * password yet — made by an address, Google or Apple — sets its first with a
 * code sent to the address on it, so without an address it adds one first.
 *
 * `token` is the session to act as. The block asks `/v1/me` for itself and
 * draws nothing if that fails.
 */
export function accountWays({ token }) {
  const box = document.createElement('section');
  box.className = 'section account-ways';

  const draw = async () => {
    let me;
    try {
      me = await api('/v1/me', { token });
    } catch {
      box.replaceChildren();
      return;
    }
    box.innerHTML = `
      <h2 class="section-label">Нэвтрэх</h2>
      <div data-rows>
        <div class="row" data-row="email">
          <div class="main"><span class="title">Имэйл</span><span class="sub" data-email-sub></span></div>
          <div class="end"><button class="btn" data-size="sm" type="button" data-open="email" hidden>Имэйл холбох</button></div>
        </div>
        <div class="row" data-row="password">
          <div class="main"><span class="title">Нууц үг</span><span class="sub">${
            me.has_password
              ? 'Тохируулсан.'
              : me.email
                ? 'Тохируулаагүй — нууц үггүйгээр ч нэвтэрч болно.'
                : 'Тохируулаагүй. Эхлээд имэйлээ холбоно уу — тохируулах код тэр хаяг руу очно.'
          }</span></div>
          <div class="end"><button class="btn" data-size="sm" type="button" data-open="password">${me.has_password ? 'Солих' : 'Тохируулах'}</button></div>
        </div>
      </div>`;
    const $ = (selector) => box.querySelector(selector);
    $('[data-email-sub]').textContent = me.email ?? 'Холбоогүй. Нууц үгээ мартвал энэ хаягаар сэргээнэ.';
    $('[data-open="email"]').hidden = Boolean(me.email);
    // A first password's code goes to the address, so with none there is nothing to press yet.
    $('[data-open="password"]').hidden = !me.has_password && !me.email;
    // An address: typed, a code sent to it, the code typed back — two steps of one popup.
    $('[data-open="email"]').addEventListener('click', () =>
      void emailPopup({
        token,
        hasPassword: me.has_password,
        then: async () => {
          toast('Имэйл холбогдлоо.', 'good');
          await draw();
        },
      }),
    );

    // A password: changed knowing the old one. The first has no old one to
    // know: a code to the address on the account, then the code and the new
    // password (passwordPopup, below — the refund's and the payout's too).
    $('[data-open="password"]').addEventListener('click', () => {
      if (!me.has_password) {
        void passwordPopup({ token, email: me.email, then: () => draw() });
        return;
      }
      void popup({
        title: 'Нууц үг солих',
        sub: 'Бусад төхөөрөмж дээрх нэвтрэлт хаагдана, энэ хэвээр үлдэнэ.',
        width: 480,
        fields: [{ name: 'current', label: 'Одоогийн нууц үг', type: 'password', autocomplete: 'current-password', required: true, wide: true }, NEW_PASSWORD],
        onSubmit: async (v) => {
          if (v.next.length < 8) throw Object.assign(new Error(PASSWORD_TOO_SHORT), { field: 'next' });
          const { revoked } = await api('/v1/me/password', { method: 'POST', token, body: { current: v.current, next: v.next } });
          toast(passwordSaved(revoked), 'good');
          await draw();
        },
      });
    });
  };

  box.ready = draw();
  return box;
}

/** The field a new password is chosen in, wherever one is. */
const NEW_PASSWORD = { name: 'next', label: 'Шинэ нууц үг', type: 'password', autocomplete: 'new-password', placeholder: 'Дор хаяж 8 тэмдэгт', required: true, wide: true };
const PASSWORD_TOO_SHORT = 'Нууц үг дор хаяж 8 тэмдэгт байх ёстой.';
/** The field a code from a letter is typed in. */
const LETTER_CODE = { name: 'code', label: 'Имэйлд ирсэн код', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '······', required: true, wide: true, attrs: { maxlength: 6 } };
const LETTER_CODE_SHORT = 'Имэйлд ирсэн 6 оронтой кодоо бичнэ үү.';
/** Where a code went, said on the step that asks for it. */
const letterSent = (address) => `<b>${popupEsc(address)}</b> хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Спам хавтсаа шалгаарай.`;
/** A password kept: said, with how many other devices it signed out. */
const passwordSaved = (revoked) => (revoked ? `Нууц үг хадгалагдлаа. Өөр ${revoked} төхөөрөмжөөс гаргалаа.` : 'Нууц үг хадгалагдлаа.');
/** A wrong or spent code is said under the code field, as on the sign-in doors; any other refusal over the fields. */
const atLetterCode = (error) => (error instanceof ApiError && /CODE|EXPIRED/.test(error.code ?? '') ? Object.assign(error, { field: 'code' }) : error);

/**
 * An address for the account: typed — with the password, where there is
 * one, since a session left open is no proof of who may add a way back in —
 * a code sent to it, and the code typed back. Two steps of one popup.
 * `why` is a line over the field when the address is asked for on the way
 * to something else — a password's code, for a bank account — so the person
 * who pressed «Данс нэмэх» knows why «Имэйл холбох» came up.
 * `then(address)` is the next step once it is linked. Resolves with what it
 * returned (or the address), or null when the popup was closed first.
 */
async function emailPopup({ token, hasPassword = false, why = '', then }) {
  let sent = null;
  const linked = await popup({
    title: 'Имэйл холбох',
    sub: 'Нууц үгээ мартвал энэ хаягаар сэргээнэ. Хаяг руу 6 оронтой код илгээнэ.',
    fields: [
      ...(why ? [{ type: 'note', text: why }] : []),
      { name: 'email', label: 'Имэйл хаяг', type: 'email', autocomplete: 'email', placeholder: 'нэр@gmail.com', required: true, wide: true },
      ...(hasPassword ? [{ name: 'current', label: 'Одоогийн нууц үг', type: 'password', autocomplete: 'current-password', required: true, wide: true }] : []),
    ],
    submit: 'Код авах',
    width: 480,
    steps: 2,
    onSubmit: async (v, { step }) => {
      if (!sent) {
        await api('/v1/me/email/code', { method: 'POST', token, body: { email: v.email, password: v.current || undefined } });
        sent = v.email;
        step({ sub: letterSent(sent), fields: [LETTER_CODE], submit: 'Баталгаажуулах' });
        return false;
      }
      const code = v.code.replace(/\D/g, '');
      if (code.length !== 6) throw Object.assign(new Error(LETTER_CODE_SHORT), { field: 'code' });
      await api('/v1/me/email', { method: 'POST', token, body: { email: sent, code } }).catch((error) => Promise.reject(atLetterCode(error)));
      return sent;
    },
  });
  if (!linked) return null;
  return then ? then(linked) : linked;
}

/**
 * A first password, for an account made by an address, Google or Apple, set
 * where it is wanted: on the account's page, and in front of a bank account
 * that money is about to go to, which is confirmed with it — the refund's on
 * /orders and in the app, the payouts' on the supplier's screen. The session
 * looking at the page is no proof of who holds the account; the inbox is.
 * So: two steps of one popup, a code to the address on the account, then the
 * code and the new password. Every other device is signed out; this stays.
 *
 * `email` is the address on the account, said as where the code goes; an
 * account with none adds one first (emailPopup) and goes on from there,
 * saying why: what the password is for (`why`), and that its code comes by
 * email. `why` is the first step's line when the password is for something.
 * `then({ password, revoked })` is the next step, once the popup has closed
 * with the password kept: the bank account's popup, handed the password just
 * chosen so it is not asked for twice, or the page drawn again. An account
 * that turns out to have a password by now (set in another tab) skips
 * straight to it, with `password: null`. Resolves with what `then` returned
 * (or what it would have been handed), or null when the popup was closed
 * first.
 *
 * `quiet` leaves the confirmation to the step after: the bank account's
 * popup says one word at its end for both, rather than two toasts standing
 * over each other. Should that step be left without an answer (`then`
 * resolves to null), the password kept is said after all.
 */
export async function passwordPopup({ token, email = null, why = '', quiet = false, then } = {}) {
  if (!email) {
    return emailPopup({
      token,
      why: `${why ? `${why} ` : ''}Нууц үгийн код имэйлээр ирдэг тул хамгийн түрүүнд имэйлээ холбоно.`,
      then: (address) => passwordPopup({ token, email: address, why, quiet, then }),
    });
  }
  let sent = null;
  const kept = await popup({
    title: 'Нууц үг тохируулах',
    sub: `Таныг мөн гэдгийг батлах 6 оронтой код <b>${popupEsc(email)}</b> хаяг руу илгээнэ. Бусад төхөөрөмж дээрх нэвтрэлт хаагдана, энэ хэвээр үлдэнэ.`,
    fields: [{ type: 'note', text: why || 'Дараагийн алхамд кодоо оруулж, шинэ нууц үгээ сонгоно.' }],
    submit: 'Код авах',
    width: 480,
    steps: 2,
    onSubmit: async (v, { step, el, say }) => {
      if (!sent) {
        const asked = await api('/v1/me/password/code', { method: 'POST', token }).catch((error) => {
          if (error instanceof ApiError && error.code === 'PASSWORD_SET') return null;
          throw error;
        });
        if (!asked) return { password: null, revoked: 0, already: true };
        sent = asked.to;
        step({
          sub: letterSent(sent),
          fields: [LETTER_CODE, NEW_PASSWORD, { type: 'note', html: '<button class="link" type="button" data-resend>Код дахин авах</button>' }],
          submit: 'Тохируулах',
        });
        // A letter that never came, or a code spent on three wrong tries:
        // another one, here, rather than closing the popup to start over.
        const again = el.querySelector('[data-resend]');
        again.addEventListener('click', async () => {
          if (again.hasAttribute('data-busy')) return;
          again.setAttribute('data-busy', '');
          try {
            sent = (await api('/v1/me/password/code', { method: 'POST', token })).to;
            el.querySelector('[name="code"]').value = '';
            step({ sub: letterSent(sent) });
          } catch (error) {
            say(error?.message ?? 'Код илгээж чадсангүй.');
          } finally {
            again.removeAttribute('data-busy');
          }
        });
        return false;
      }
      const code = v.code.replace(/\D/g, '');
      if (code.length !== 6) throw Object.assign(new Error(LETTER_CODE_SHORT), { field: 'code' });
      if (v.next.length < 8) throw Object.assign(new Error(PASSWORD_TOO_SHORT), { field: 'next' });
      const { revoked } = await api('/v1/me/password', { method: 'POST', token, body: { next: v.next, code } }).catch((error) => Promise.reject(atLetterCode(error)));
      return { password: v.next, revoked };
    },
  });
  if (!kept) return null;
  const said = () => {
    if (!kept.already) toast(passwordSaved(kept.revoked), 'good');
  };
  if (!quiet) said();
  const handed = { password: kept.password, revoked: kept.revoked };
  if (!then) return handed;
  const next = await then(handed);
  if (quiet && next == null) said();
  return next;
}

/* ── popups ────────────────────────────────────────────────────────── */

let popupSeq = 0;
const popupEsc = (value) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const POPUP_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

/**
 * While a popup or a sheet that asks for an answer is open, the page behind it
 * sleeps (`inert`): a screen reader reads only the popup, the keyboard cannot
 * wander under the dim, and a tap that misses lands on nothing. The toast
 * stays awake, so what it says is still heard. Returns the way to wake what
 * this call put to sleep — and only that, so a popup over a popup wakes its
 * own page and nothing else.
 */
function popupHush(...awake) {
  const hushed = [];
  for (const node of document.body?.children ?? []) {
    if (awake.includes(node) || node.id === 'toast' || node.classList.contains('toast-old') || node.hasAttribute('inert')) continue;
    node.setAttribute('inert', '');
    hushed.push(node);
  }
  return () => {
    for (const node of hushed) node.removeAttribute('inert');
  };
}

/** Attributes a field asks for beyond the usual — maxlength, min, step, pattern — each escaped. */
const popupAttrs = (attrs = {}) =>
  Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? ` ${popupEsc(k)}` : ` ${popupEsc(k)}="${popupEsc(v)}"`))
    .join('');

/** One field of a popup's form, as the design system draws a field. */
function popupField(f, n) {
  const id = `popup-${n}-${f.name ?? Math.random().toString(36).slice(2)}`;
  const wide = f.wide || ['textarea', 'checks', 'icons', 'static', 'note', 'pick', 'section'].includes(f.type) ? ' data-wide' : '';
  const hint = f.hint ? `<small class="help" id="${id}-hint">${popupEsc(f.hint)}</small>` : '';
  const described = f.hint ? ` aria-describedby="${id}-hint"` : '';
  const req = f.required ? ' required' : '';
  if (f.type === 'note') return `<p class="popup-text"${wide}>${f.html ?? popupEsc(f.text)}</p>`;
  // A heading over the fields after it, in a long form: «Олголт очих данс», a line under it if it needs one.
  if (f.type === 'section') return `<div class="popup-section"${wide}><h3>${popupEsc(f.label)}</h3>${f.text ? `<p>${popupEsc(f.text)}</p>` : ''}</div>`;
  if (f.type === 'static') return `<div class="field popup-static"${wide}><span>${popupEsc(f.label)}</span><div>${f.html ?? popupEsc(f.value)}</div></div>`;
  if (f.type === 'checks') {
    // [name, word, on, { disabled, hint }] — a box that is fixed stays drawn, greyed, and is not sent.
    return `<div class="field"${wide}><span>${popupEsc(f.label)}</span><div class="popup-checks"${f.list ? ' data-list' : ''}>${f.options
      .map(
        ([name, word, on, more = {}]) =>
          `<label class="check"><input type="checkbox" name="${popupEsc(name)}"${on ? ' checked' : ''}${more.disabled ? ' disabled' : ''}> <span>${popupEsc(word)}${
            more.hint ? `<small>${popupEsc(more.hint)}</small>` : ''
          }</span></label>`,
      )
      .join('')}</div>${hint}</div>`;
  }
  if (f.type === 'icons') {
    // A choice of pictures: [key, svg, word], one of them chosen.
    return `<div class="field"${wide} role="radiogroup" aria-label="${popupEsc(f.label)}"><span>${popupEsc(f.label)}</span><div class="popup-icons">${f.options
      .map(
        ([key, svg, word]) =>
          `<label title="${popupEsc(word)}"><input type="radio" name="${popupEsc(f.name)}" value="${popupEsc(key)}"${key === f.value ? ' checked' : ''} aria-label="${popupEsc(word)}">${svg}</label>`,
      )
      .join('')}</div>${hint}</div>`;
  }
  if (f.type === 'pick') {
    // One row chosen from a list that answers a search — a person among Basu's users. `mountPick` wires it.
    return `<div class="field popup-pick"${wide} data-pick="${popupEsc(f.name)}"${f.required ? ' data-required' : ''}><span>${popupEsc(f.label)}</span><input type="search" class="input search" id="${id}" placeholder="${popupEsc(
      f.placeholder ?? 'Хайх…',
    )}" autocomplete="off" spellcheck="false" aria-label="${popupEsc(f.label)}"><div class="popup-pick-list" role="radiogroup" aria-label="${popupEsc(f.label)}" aria-busy="true"></div>${hint}</div>`;
  }
  if (f.type === 'select') {
    return `<label class="field"${wide} for="${id}"><span>${popupEsc(f.label)}</span><select id="${id}" name="${popupEsc(f.name)}"${req}${described}>${f.options
      .map(([v, w]) => `<option value="${popupEsc(v)}"${String(v) === String(f.value ?? '') ? ' selected' : ''}>${popupEsc(w)}</option>`)
      .join('')}</select>${hint}</label>`;
  }
  if (f.type === 'textarea') {
    return `<label class="field"${wide} for="${id}"><span>${popupEsc(f.label)}</span><textarea id="${id}" name="${popupEsc(f.name)}" placeholder="${popupEsc(f.placeholder ?? '')}"${req}${described}${popupAttrs(f.attrs)}>${popupEsc(f.value ?? '')}</textarea>${hint}</label>`;
  }
  const type = f.type ?? 'text';
  const isMoney = f.format === 'money';
  // A phone types digits on a phone's own keypad unless the page said otherwise; money is digits too.
  const inputmode = f.inputmode ?? (type === 'tel' ? 'tel' : isMoney ? 'numeric' : '');
  const attrs = [
    `type="${popupEsc(type)}"`,
    inputmode ? `inputmode="${popupEsc(inputmode)}"` : '',
    f.autocomplete ? `autocomplete="${popupEsc(f.autocomplete)}"` : isMoney ? 'autocomplete="off"' : '',
    type === 'email' || inputmode === 'email' ? 'autocapitalize="none" spellcheck="false"' : '',
    isMoney ? 'data-format="money"' : '',
  ].filter(Boolean).join(' ');
  const input = `<input id="${id}" name="${popupEsc(f.name)}" ${attrs} value="${popupEsc(f.value ?? '')}" placeholder="${popupEsc(f.placeholder ?? '')}"${req}${described}${popupAttrs(f.attrs)}>`;
  // A unit after the digits (₮, кг) or a start before them (+976): one value, read as one. Money says ₮ unless told otherwise.
  const unit = f.unit ?? (isMoney ? '₮' : '');
  const control = unit
    ? `<span class="affix">${input}<i aria-hidden="true">${popupEsc(unit)}</i></span>`
    : f.prefix
      ? `<span class="affix"><i data-start aria-hidden="true">${popupEsc(f.prefix)}</i>${input}</span>`
      : input;
  return `<label class="field"${wide} for="${id}"><span>${popupEsc(f.label)}</span>${control}${hint}</label>`;
}

let fieldErrorSeq = 0;

/**
 * Say what is wrong with one field, under it — or, with no message, take the
 * word back. The control turns stop-red (`aria-invalid`), the line under it
 * is tied to it for a screen reader (`aria-describedby`), and a hint under
 * the field steps aside while the error stands. Works in any `.field`: a
 * popup's, a door's, a page's own form.
 *
 *   fieldError(input, 'Утасны дугаар 8 оронтой.');
 *   fieldError(input, null);
 */
export function fieldError(input, message) {
  if (!input) return;
  const field = input.closest('.field') ?? input.parentElement;
  if (!field) return;
  let line = field.querySelector(':scope > .help[data-error]');
  const hint = field.querySelector(':scope > .help:not([data-error]), :scope > small:not(.help)');
  if (!message) {
    input.removeAttribute('aria-invalid');
    for (const bad of field.querySelectorAll('[aria-invalid]')) bad.removeAttribute('aria-invalid');
    line?.remove();
    if (hint) hint.hidden = false;
    if (hint?.id) input.setAttribute('aria-describedby', hint.id);
    else input.removeAttribute('aria-describedby');
    return;
  }
  if (!line) {
    line = document.createElement('small');
    line.className = 'help';
    line.setAttribute('data-error', '');
    line.id = `field-error-${++fieldErrorSeq}`;
    field.append(line);
  }
  line.textContent = message;
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', line.id);
  if (hint) hint.hidden = true;
}

/**
 * A pick field at work: it asks `search(q)` for rows ({ value, title, sub,
 * flag, note, disabled }) when it opens and again as the person types, and
 * draws them as a list with one to choose. Every word of a row is text; a
 * `flag` is one word after the line under the title, in the tone that asks
 * for a second look — «баталгаагүй» beside a number nobody proved. The one
 * chosen stays in the list whatever is typed next, so the form still carries
 * it. Enter searches at once; it does not answer the popup. Until the first
 * answer the list holds three rows of its shape.
 */
function mountPick(box, f) {
  if (!box) return;
  const input = box.querySelector('input[type="search"]');
  const list = box.querySelector('.popup-pick-list');
  const known = new Map();
  let chosen = null;
  let seq = 0;
  let timer = null;
  const row = (r) =>
    `<label class="popup-pick-row"${r.disabled ? ' data-off' : ''}><input type="radio" name="${popupEsc(f.name)}" value="${popupEsc(r.value)}"${
      chosen && String(chosen.value) === String(r.value) ? ' checked' : ''
    }${r.disabled ? ' disabled' : ''}><span class="who"><b>${popupEsc(r.title)}</b>${
      r.sub || r.flag ? `<small>${popupEsc(r.sub ?? '')}${r.flag ? `${r.sub ? ' ' : ''}<em class="flag">${popupEsc(r.flag)}</em>` : ''}</small>` : ''
    }</span>${r.note ? `<span class="note">${popupEsc(r.note)}</span>` : ''}</label>`;
  const draw = (rows) => {
    for (const r of rows) known.set(String(r.value), r);
    const shown = chosen && !rows.some((r) => String(r.value) === String(chosen.value)) ? [chosen, ...rows] : rows;
    list.innerHTML = shown.length ? shown.map(row).join('') : `<p class="popup-pick-empty">${popupEsc(f.empty ?? 'Олдсонгүй.')}</p>`;
  };
  list.innerHTML = '<div class="popup-pick-skel"><span class="skel"></span><span class="skel-lines"><span class="skel"></span><span class="skel"></span></span></div>'.repeat(3);
  const load = async () => {
    const mine = ++seq;
    list.setAttribute('aria-busy', 'true');
    try {
      const rows = await f.search(input.value.trim());
      if (mine === seq) draw(rows);
    } catch (error) {
      if (mine === seq) list.innerHTML = `<p class="popup-pick-empty">${popupEsc(error?.message ?? 'Алдаа гарлаа.')}</p>`;
    } finally {
      if (mine === seq) list.removeAttribute('aria-busy');
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(timer);
    void load();
  });
  list.addEventListener('change', (e) => {
    if (e.target.name === f.name) chosen = known.get(e.target.value) ?? null;
  });
  void load();
}

/** What a field that must be filled says when it is not, by the kind of control it is. */
function popupMissing(control) {
  if (control.type === 'checkbox') return 'Тэмдэглэнэ үү.';
  if (control.tagName === 'SELECT' || control.type === 'radio') return 'Сонгоно уу.';
  return 'Бөглөнө үү.';
}

/**
 * A popup over the page: the one place a thing is added, changed, or said no
 * to. On top its title and what it is about; in the middle the fields; at the
 * foot «Болих» and the one button that does it. It closes on its cross, on
 * Esc and on the dim around it, keeps the keyboard inside while it is open,
 * and gives the focus back to whatever opened it. On a phone it is a sheet
 * from the bottom, its foot pinned within the thumb's reach.
 *
 * `fields` draw the form — { name, label, type: text | email | tel | number |
 * date | textarea | select | checks | icons | pick | static | note | section,
 * value, placeholder, options, required, hint, wide, inputmode, autocomplete,
 * unit (₮, кг after the value), prefix (+976 before it), format ('phone': the
 * digits grouped «9911 2233» as they are typed — phoneInput; 'money': the
 * tögrög grouped «1,250,000» as they are typed, ₮ after them — moneyInput),
 * attrs ({ maxlength, min, step, pattern }), onChange }; a pick also takes
 * `search(q)` and `empty` (see `mountPick`). A section is a heading over the
 * fields after it in a long form — { type: 'section', label, text } — and
 * sends nothing. All of it is text, escaped here, except three things that are
 * markup because they carry a name in bold or a code in mono: `sub`, and a
 * note's or a static's `html`. Whoever fills those escapes what a person
 * wrote.
 *
 * A money field hands `onSubmit` its bare digits («1250000»), so a page that
 * reads the value as a number reads it as before; whoever reads the input
 * itself reads it with `moneyValue(input.value)`.
 *
 * `onChange(value, form)` on a field is called once when the field is drawn
 * and again whenever it changes — as it is typed, or as a select, a box or a
 * choice moves. `value` is what the field holds now (a checks field: {
 * name: ticked }); `form` is { values, el, show(name, on), hint(name, text),
 * label(name, words) }: everything the form holds now, the popup, and three
 * ways to make the form follow the answer — a field shown only when it
 * applies (hidden, it is not sent either), the hint under a field, a field's
 * label. «Бусад банк» chosen shows the field for the bank's name; a role
 * chosen says under the select what it may do.
 *
 * `onSubmit(values, popup)` does the work: what it returns closes the popup
 * and is what the promise resolves to; `false` keeps it open (a first step
 * done, the second drawn with `popup.step(...)`). A field that must be filled
 * and is not says so under itself before anything is sent. A thrown error is
 * said inside the popup, over the fields — or under one field, when the error
 * names it (`error.field = 'phone'`, or `popup.fieldError('phone', '…')`) —
 * and the popup stays for another try. A button a step draws for itself —
 * «Код дахин авах» — says its own trouble in the same place, with
 * `popup.say(...)`. While the answer is on the way the button turns and the
 * form holds still. `steps: 2` puts «Алхам 1/2» over the title, and each
 * `step()` that draws new fields moves it on. `danger` makes the button the
 * filled red of a step that cannot be undone. `focus` is where the keyboard
 * goes when a step is drawn: 'auto' (the default: the first field where there
 * is a mouse, the popup itself on a touch screen — the phone's keyboard stays
 * down until a field is tapped), 'field' (the first field everywhere) or
 * 'sheet' (the popup itself everywhere). Closed without an answer, the
 * promise resolves to null.
 */
export function popup({ title, sub = '', fields = [], submit = 'Хадгалах', cancel = 'Болих', danger = false, width = 560, steps = 0, focus = 'auto', onSubmit = async () => true, id = null }) {
  return new Promise((resolve) => {
    // Where the keyboard goes when a step is drawn: its first field, or — on a touch screen with
    // focus 'auto', or anywhere with 'sheet' — the popup itself, so a phone's keyboard does not
    // rise over the popup before the person has read it.
    const toField = () => focus === 'field' || (focus === 'auto' && !(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches));
    const n = ++popupSeq;
    const opener = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const sheet = document.createElement('div');
    sheet.className = 'sheet popup';
    sheet.setAttribute('data-center', '');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', `popup-title-${n}`);
    sheet.tabIndex = -1;
    sheet.style.setProperty('--sheet-w', `${width}px`);
    if (id) sheet.id = id;
    // The header and the foot are the popup's own parts, not the page's banner and footer landmarks (role none).
    sheet.innerHTML = `
      <header role="none"><div><div class="popup-steps"></div><h2 id="popup-title-${n}"></h2><div class="sub" id="popup-sub-${n}"></div></div><button class="x" type="button" aria-label="Хаах">${POPUP_X}</button></header>
      <form class="body" novalidate>
        <div class="callout popup-error" data-k="stop" role="alert" hidden><span></span></div>
        <div class="fields"></div>
      </form>
      <footer role="none"><button class="btn" data-v="quiet" type="button" data-cancel></button><button class="btn" type="button" data-submit></button></footer>`;
    const $ = (selector) => sheet.querySelector(selector);
    const form = $('form');
    const errorBox = $('.popup-error');
    const go = $('[data-submit]');
    const say = (message) => {
      errorBox.hidden = !message;
      errorBox.querySelector('span').textContent = message ?? '';
      // Said over the fields, which a long form has scrolled away from the
      // button that was pressed: brought into view, or it is said to nobody.
      if (!message || typeof errorBox.scrollIntoView !== 'function') return;
      const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      errorBox.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
    };
    /** The control a field's error belongs to: the named input, or the first of a group. */
    const control = (name) => [...sheet.querySelectorAll('.fields [name]')].find((node) => node.name === name) ?? null;
    const sayAt = (name, message) => {
      const node = control(name);
      if (!node) return say(message);
      fieldError(node, message);
      node.focus?.();
    };

    /** What the form holds now: a popup's answer, and what a field's onChange is given. */
    function values() {
      const out = {};
      for (const input of sheet.querySelectorAll('.fields [name]:not(:disabled)')) {
        if (input.type === 'radio') {
          if (input.checked) out[input.name] = input.value;
          continue;
        }
        // A password is what was typed, spaces and all; money is its digits, «1,250,000» sent as «1250000».
        out[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'password' ? input.value : input.dataset.format === 'money' ? moneyDigits(input.value) : input.value.trim();
      }
      return out;
    }

    /** The fields drawn now that asked to hear about a change, by the names of their controls. */
    let watched = new Map();
    /** A field's own value: a checks field's boxes as { name: ticked }, anything else as the answer sends it. */
    const valueOf = (f) => {
      const now = values();
      if (f.type === 'checks') return Object.fromEntries(f.options.map(([name]) => [name, Boolean(now[name])]));
      return now[f.name] ?? (f.type === 'icons' ? null : '');
    };
    /** Show a field or put it away; put away, it is not sent and not required. */
    const show = (name, on) => {
      const node = control(name);
      if (!node) return;
      const field = node.closest('.field');
      for (const each of field ? field.querySelectorAll('[name]') : [node]) each.disabled = !on;
      if (field) field.hidden = !on;
      if (!on) fieldError(node, null);
    };
    /** The hint under a field, said anew — or taken away with no words. An error standing there stays in front of it. */
    const hintAt = (name, text) => {
      const node = control(name);
      const field = node?.closest('.field');
      if (!field) return;
      let line = field.querySelector(':scope > .help:not([data-error])');
      if (!text) {
        line?.remove();
        if (!field.querySelector(':scope > .help[data-error]')) node.removeAttribute('aria-describedby');
        return;
      }
      if (!line) {
        line = document.createElement('small');
        line.className = 'help';
        line.id = `${node.id || `popup-${n}-${name}`}-hint`;
        const error = field.querySelector(':scope > .help[data-error]');
        if (error) line.hidden = true;
        field.insertBefore(line, error);
        if (!error) node.setAttribute('aria-describedby', line.id);
      }
      line.textContent = text;
    };
    /** A field's label, said anew: «Нэг толгойн үнэ» becomes «1 кг-ийн үнэ» when the unit does. */
    const labelAt = (name, words) => {
      const label = control(name)?.closest('.field')?.querySelector(':scope > span');
      if (label) label.textContent = words;
    };
    const tell = (f) => {
      try {
        f.onChange(valueOf(f), { values: values(), el: sheet, show, hint: hintAt, label: labelAt });
      } catch (error) {
        console.error(error);
      }
    };

    let at = 1;
    const drawSteps = () => {
      const box = $('.popup-steps');
      if (!(steps > 1)) {
        box.replaceChildren();
        return;
      }
      box.innerHTML = `<span>Алхам ${at}/${steps}</span><i aria-hidden="true">${Array.from({ length: steps }, (_, i) => `<b${i < at ? ' data-on' : ''}></b>`).join('')}</i>`;
    };

    /** Draw a step: the words on top, the fields, the buttons. */
    const step = (next) => {
      if (next.at !== undefined) at = next.at;
      else if (next.fields && drawn) at = Math.min(at + 1, Math.max(steps, 1));
      drawSteps();
      if (next.title !== undefined) $('header h2').textContent = next.title;
      if (next.sub !== undefined) {
        $('header .sub').innerHTML = next.sub;
        $('header .sub').hidden = !next.sub;
        if (next.sub) sheet.setAttribute('aria-describedby', `popup-sub-${n}`);
        else sheet.removeAttribute('aria-describedby');
      }
      if (next.fields) {
        $('.fields').innerHTML = next.fields.map((f) => popupField(f, n)).join('');
        watched = new Map();
        for (const f of next.fields) {
          if (f.type === 'pick') mountPick([...sheet.querySelectorAll('[data-pick]')].find((box) => box.dataset.pick === f.name), f);
          if (f.format === 'phone') phoneInput(control(f.name));
          if (f.format === 'money') moneyInput(control(f.name));
          if (typeof f.onChange !== 'function') continue;
          for (const name of f.type === 'checks' ? f.options.map(([box]) => box) : [f.name]) watched.set(name, f);
        }
        // Drawn: each field that follows an answer hears it once, so the form starts as it would after a change.
        for (const f of new Set(watched.values())) tell(f);
      }
      if (next.submit !== undefined) go.textContent = next.submit;
      if (next.danger !== undefined) {
        go.setAttribute('data-v', next.danger ? 'danger' : 'primary');
        // The button of a step that cannot be undone is the filled red; a popup's button is always that step.
        go.toggleAttribute('data-fill', Boolean(next.danger));
      }
      say(null);
      const first = sheet.querySelector('.fields input:not([type="checkbox"]):not([type="radio"]), .fields select, .fields textarea');
      if (toField()) (first ?? go).focus?.();
      else if (drawn) sheet.focus?.();
    };
    let drawn = false;
    step({ title, sub, fields, submit, danger });
    drawn = true;
    $('[data-cancel]').textContent = cancel;

    // A field that was wrong is right again as soon as it is touched.
    const mend = (e) => {
      const field = e.target.closest?.('.field');
      const bad = field?.querySelector('[aria-invalid="true"]');
      if (bad) fieldError(bad, null);
    };
    form.addEventListener('input', mend);
    form.addEventListener('change', mend);
    // A field with an onChange hears its own changes: what is typed as it is typed; a select, a box or a choice once it moves.
    const heard = (e) => {
      const f = watched.get(e.target?.name);
      if (!f) return;
      const moves = e.target.tagName === 'SELECT' || e.target.type === 'checkbox' || e.target.type === 'radio';
      if ((e.type === 'change') === moves) tell(f);
    };
    form.addEventListener('input', heard);
    form.addEventListener('change', heard);

    let closed = false;
    let wake = () => {};
    const close = (answer) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      sheet.removeAttribute('id');
      sheet.removeAttribute('data-open');
      scrim.removeAttribute('data-open');
      if (!document.querySelector('.sheet[data-open]')) document.documentElement.removeAttribute('data-modal-open');
      setTimeout(() => {
        sheet.remove();
        scrim.remove();
      }, 260);
      // The page wakes before the keyboard goes back to what opened the popup: a sleeping button takes no focus.
      wake();
      if (opener?.isConnected) opener.focus?.();
      resolve(answer);
    };

    const busy = (on) => {
      go.toggleAttribute('data-busy', on);
      if (on) go.setAttribute('aria-busy', 'true');
      else go.removeAttribute('aria-busy');
      sheet.toggleAttribute('data-busy', on);
      form.setAttribute('aria-busy', String(on));
    };

    const run = async () => {
      if (go.hasAttribute('data-busy')) return;
      // What must be there, is — said under each field that is not, before anything is sent.
      const missing = [];
      for (const input of sheet.querySelectorAll('.fields [required]:not(:disabled)')) {
        const empty = input.type === 'checkbox' ? !input.checked : !input.value.trim();
        if (empty) {
          missing.push(input);
          fieldError(input, popupMissing(input));
        } else if (input.getAttribute('aria-invalid') === 'true') fieldError(input, null);
      }
      for (const box of sheet.querySelectorAll('.fields [data-pick][data-required]')) {
        const radios = [...box.querySelectorAll('input[type="radio"]')];
        if (radios.some((r) => r.checked)) continue;
        const target = box.querySelector('input[type="search"]');
        missing.push(target);
        fieldError(target, 'Нэгийг сонгоно уу.');
      }
      if (missing.length) {
        say(null);
        missing[0].focus();
        return;
      }
      busy(true);
      say(null);
      try {
        const answer = await onSubmit(values(), { step, el: sheet, say, fieldError: sayAt });
        if (answer === false) return;
        close(answer ?? true);
      } catch (error) {
        if (error?.field && control(error.field)) sayAt(error.field, error.message);
        else say(error?.message ?? 'Алдаа гарлаа.');
      } finally {
        busy(false);
      }
    };

    const onKey = (e) => {
      if (!sheet.hasAttribute('data-open')) return;
      // Only the popup on top answers.
      const popups = [...document.querySelectorAll('.sheet.popup[data-open]')];
      if (popups[popups.length - 1] !== sheet) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
        return;
      }
      if (e.key !== 'Tab') return;
      const stops = [
        ...sheet.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      ].filter((node) => node.getClientRects().length > 0);
      if (!stops.length) return;
      const [first, last] = [stops[0], stops[stops.length - 1]];
      const inside = sheet.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };

    go.addEventListener('click', run);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void run();
    });
    // Enter in a one-line field answers, as a form does; in a textarea it is a new line.
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio') {
        e.preventDefault();
        void run();
      }
    });
    $('[data-cancel]').addEventListener('click', () => close(null));
    $('header .x').addEventListener('click', () => close(null));
    scrim.addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim, sheet);
    wake = popupHush(scrim, sheet);
    document.documentElement.setAttribute('data-modal-open', '');
    void sheet.offsetWidth; // drawn closed once, so opening is a movement rather than a jump
    scrim.setAttribute('data-open', '');
    sheet.setAttribute('data-open', '');
    const first = sheet.querySelector('.fields input:not([type="checkbox"]):not([type="radio"]), .fields select, .fields textarea');
    (toField() && first ? first : sheet).focus();
  });
}

/**
 * «Are you sure?» as a popup: what is about to happen, a reason to keep when
 * the record wants one, and the button that does it — the filled red of a
 * step that cannot be undone when `danger`. Resolves to what
 * `onConfirm(reason)` returned, or null when the person said no.
 */
export function confirmPopup({ title, text = '', ok = 'Тийм', cancel = 'Болих', danger = false, reason = null, focus = 'auto', onConfirm = async () => true }) {
  const fields = [];
  if (text) fields.push({ type: 'note', html: text });
  if (reason) {
    fields.push({
      name: 'reason',
      type: reason.type ?? 'textarea',
      label: reason.label,
      placeholder: reason.placeholder ?? '',
      required: Boolean(reason.required),
      value: reason.value ?? '',
      options: reason.options,
      hint: reason.hint,
      wide: true,
    });
  }
  return popup({ title, fields, submit: ok, cancel, danger, focus, width: 480, onSubmit: (values) => onConfirm(values.reason ?? '', values) });
}

/* ── toast ─────────────────────────────────────────────────────────── */

let toastTimer;
/** The toasts still showing behind the newest, newest first: copies, aria-hidden. */
let toastOld = [];
/** Long enough to read: an error stays longer than good news. */
const TOAST_MS = { bad: 5200 };

/**
 * How far up from the bottom edge a toast stands: above whatever is pinned
 * along that edge — a tab bar, a pay bar, an order bar — so its buttons stay
 * in reach and in sight. A bar is the first thing under the bottom centre
 * that sits on the edge, spans at least half the width, is less than 40% of
 * the screen tall and is pinned (fixed or sticky, itself or inside something
 * that is). A popup's dim and a full-screen panel are not bars; a phone's
 * bottom sheet sends the toast to the top instead (app.css).
 */
function toastOver() {
  if (typeof document.elementsFromPoint !== 'function') return 0;
  const height = innerHeight;
  const hit = document.elementsFromPoint(innerWidth / 2, height - 2).find((node) => !node.closest('#toast, .toast-old'));
  for (let node = hit; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const box = node.getBoundingClientRect();
    if (box.bottom < height - 2 || box.height >= height * 0.4 || box.width < innerWidth * 0.5) continue;
    for (let up = node; up && up !== document.documentElement; up = up.parentElement) {
      const { position } = getComputedStyle(up);
      if (position === 'fixed' || position === 'sticky') return Math.max(0, Math.round(height - box.top));
    }
    return 0;
  }
  return 0;
}

/** Each toast showing steps up above the ones newer than it. */
function toastRestack() {
  const newest = document.getElementById('toast');
  let y = newest?.dataset.show ? newest.offsetHeight + 8 : 0;
  for (const old of toastOld) {
    old.style.setProperty('--toast-y', `${-y}px`);
    y += old.offsetHeight + 8;
  }
}

function toastDrop(old) {
  clearTimeout(old.toastTimer);
  toastOld = toastOld.filter((x) => x !== old);
  delete old.dataset.show;
  setTimeout(() => old.remove(), 260);
  toastRestack();
}

/**
 * One line at the bottom of the screen, gone after 3.2s (an error after
 * 5.2s). `kind` is 'good' (a check), 'bad' (an alert) or 'info' (an «i»); it
 * lands on `#toast` as `data-kind` and is cleared again when the next toast
 * has none. A toast that comes while another is showing puts the other one
 * up a step instead of wiping it, so two quick words are both read; three at
 * most. A tap puts one away. The element is created on first use with
 * `role=status`, it always holds the newest words, and `data-show` is what
 * the tests read on a timeout — all as they were.
 */
export function toast(message, kind) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.addEventListener('click', () => {
      clearTimeout(toastTimer);
      delete el.dataset.show;
      toastRestack();
    });
    document.body.appendChild(el);
  }
  if (el.dataset.show && el.textContent && el.textContent !== message) {
    const old = el.cloneNode(true);
    old.removeAttribute('id');
    old.removeAttribute('role');
    old.className = 'toast-old';
    old.setAttribute('aria-hidden', 'true');
    old.addEventListener('click', () => toastDrop(old));
    document.body.append(old);
    toastOld.unshift(old);
    // Three at most: the oldest goes first, unless it is trouble and a calmer word is there to go instead.
    while (toastOld.length > 2) toastDrop([...toastOld].reverse().find((x) => x.dataset.kind !== 'bad') ?? toastOld[toastOld.length - 1]);
    old.toastTimer = setTimeout(() => toastDrop(old), 2600);
  }
  el.textContent = message;
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
  const over = toastOver();
  if (over) el.style.setProperty('--toast-over', `${over}px`);
  else el.style.removeProperty('--toast-over');
  el.dataset.show = '1';
  toastRestack();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    delete el.dataset.show;
    toastRestack();
  }, TOAST_MS[kind] ?? 3200);
}

/* ── empty states, skeletons, busy buttons ─────────────────────────── */

/**
 * The marks an empty state wears: line icons on the 24 grid, stroked like
 * the menu's. A page may pass its own svg instead — sidenav's NAV_ICON.orders.
 */
const EMPTY_ICON = {
  inbox: '<svg viewBox="0 0 24 24"><path d="M3.5 13h4.5l1.5 2.5h5l1.5-2.5h4.5"/><path d="M6 5h12l2.5 8v5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-5z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  orders: '<svg viewBox="0 0 24 24"><path d="M6 4h12v16l-3-2-3 2-3-2-3 2z"/><path d="M9 9h6M9 13h4"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.2"/><path d="M3 20c.8-3.2 3-4.8 6-4.8s5.2 1.6 6 4.8"/><circle cx="17" cy="9.5" r="2.4"/><path d="M15.5 15.2c2.6.2 4.4 1.6 5 4.8"/></svg>',
  store: '<svg viewBox="0 0 24 24"><path d="M4 9l1.5-4h13L20 9"/><path d="M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3"/><path d="M6 12v8h12v-8M10 20v-5h4v5"/></svg>',
  bowl: '<svg viewBox="0 0 24 24"><path d="M3 11h18a9 9 0 0 1-18 0z"/><path d="M8 7c0-1.5 1-2 1-3.5M12 7c0-1.5 1-2 1-3.5M16 7c0-1.5 1-2 1-3.5"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18M15.5 15h2"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8 3v4M16 3v4M8 14h3"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  org: '<svg viewBox="0 0 24 24"><path d="M4 20V6l8-3 8 3v14"/><path d="M9 20v-4h6v4M8 9h.01M12 9h.01M16 9h.01M8 13h.01M12 13h.01M16 13h.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="8.5"/></svg>',
  truck: '<svg viewBox="0 0 24 24"><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>',
  offline: '<svg viewBox="0 0 24 24"><path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0"/><path d="M12 19h.01M3 3l18 18"/></svg>',
};

/**
 * What a place is for while it holds nothing yet: a mark, a title, one line,
 * and the one next step. Returns the element (`.empty-state`) to put where
 * the list or the page would be.
 *
 *   emptyState({ icon: 'orders', title: 'Захиалга алга', text: 'Зочин захиалга өгмөгц энд гарна.',
 *                action: { label: 'Зар нэмэх', onClick: () => …, primary: true } })
 *
 * `icon` is a name from EMPTY_ICON (inbox, search, orders, people, store,
 * bowl, wallet, bell, calendar, star, org, clock, truck, alert, offline) or
 * an svg string. `action` is { label, onClick | href, primary, quiet, icon
 * (svg), attrs ({ 'data-retry': '' }) } or a node of the page's own;
 * `actions` is a list of them, drawn in order (a page-level block stacks them
 * full width: «Дахин оролдох» primary over «Нүүр рүү буцах» quiet). `html`
 * stands in for `text` when the line needs a name in bold — the caller
 * escapes what a person wrote. `size: 'sm'` for a panel or a short list,
 * `'lg'` for a whole screen that has nothing (the app's «nothing on sale» or
 * «cannot reach Basu»), `frame: true` for a card of its own where it stands
 * alone on a page, `tone: 'accent' | 'stop'` to tint the mark (a first step /
 * could not load; offline stays neutral), `align: 'start'` to sit at the left.
 */
export function emptyState({ icon = 'inbox', title, text = '', html = '', action = null, actions = [], size, tone, frame = false, align } = {}) {
  const box = document.createElement('div');
  box.className = 'empty-state';
  if (size) box.dataset.size = size;
  if (tone) box.dataset.tone = tone;
  if (align) box.dataset.align = align;
  if (frame) box.setAttribute('data-frame', '');
  const svg = typeof icon === 'string' && icon.trim().startsWith('<svg') ? icon : EMPTY_ICON[icon] ?? EMPTY_ICON.inbox;
  box.innerHTML = `<span class="es-mark" aria-hidden="true">${svg}</span><h3 class="es-title"></h3><p class="es-text"></p>`;
  box.querySelector('.es-title').textContent = title ?? '';
  if (html) box.querySelector('.es-text').innerHTML = html;
  else box.querySelector('.es-text').textContent = text ?? '';
  const steps = [...(action ? [action] : []), ...(actions ?? [])].filter(Boolean);
  if (steps.length) {
    const act = document.createElement('div');
    act.className = 'es-act';
    for (const a of steps) {
      if (a instanceof Node) {
        act.append(a);
        continue;
      }
      const b = document.createElement(a.href ? 'a' : 'button');
      b.className = 'btn';
      if (a.href) b.href = a.href;
      else b.type = 'button';
      if (a.primary) b.dataset.v = 'primary';
      else if (a.quiet) b.dataset.v = 'quiet';
      if (size === 'sm' || size === 'lg') b.dataset.size = size;
      for (const [name, value] of Object.entries(a.attrs ?? {})) b.setAttribute(name, value === true ? '' : String(value));
      b.innerHTML = a.icon ?? '';
      b.append(document.createTextNode(a.label ?? ''));
      if (a.onClick) b.addEventListener('click', a.onClick);
      act.append(b);
    }
    box.append(act);
  }
  return box;
}

/**
 * The shape of what is coming, at its size, while it loads — so nothing
 * jumps when it lands. `kind`: 'rows' (a card of list rows), 'cards' (a grid
 * of cards with a picture), 'kpis' (a KPI band), 'lines' (a paragraph). The
 * container says it is busy to a screen reader; put the real thing in its
 * place when it arrives.
 */
export function skeleton(kind = 'rows', n = 3) {
  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.setAttribute('aria-busy', 'true');
  box.setAttribute('aria-label', 'Ачаалж байна');
  const bar = '<span class="skel"></span>';
  if (kind === 'cards') {
    box.className = 'skel-cards';
    box.innerHTML = `<div class="skel-card">${bar.repeat(3)}</div>`.repeat(n);
  } else if (kind === 'kpis') {
    box.className = 'kpi-band skel-kpis';
    box.innerHTML = `<div class="skel-kpi-cell"><span class="skel" data-w="60"></span><span class="skel skel-kpi"></span><span class="skel" data-w="40"></span></div>`.repeat(n);
  } else if (kind === 'lines') {
    box.className = 'skel-lines-block';
    box.innerHTML = bar.repeat(n);
  } else {
    box.className = 'card skel-rows';
    box.innerHTML = `<div class="skel-row">${bar}<span class="skel-lines">${bar}${bar}</span>${bar}</div>`.repeat(n);
  }
  return box;
}

/**
 * A button at work: the words go transparent (they stay for a reader and for
 * `textContent`), a spinner turns in the button's own ink, and it takes no
 * second press. `setBusy(button, false)` gives it back.
 */
export function setBusy(button, on = true) {
  if (!button) return button;
  button.toggleAttribute('data-busy', on);
  if (on) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
  return button;
}

/**
 * A phone field that groups the digits the way people read them — «9911
 * 2233» — while they are typed or pasted, the caret kept where it was. Put it
 * after a `+976` start mark (`.affix > i[data-start]`). What the field holds
 * is still what is sent: Basu's sign-in reads «9911 2233» as +97699112233
 * (phoneE164); a page whose endpoint wants bare digits strips the space.
 */
export function phoneInput(input) {
  if (!input) return input;
  const group = () => {
    const was = input.value;
    const caret = input.selectionStart ?? was.length;
    const digitsBefore = was.slice(0, caret).replace(/\D/g, '').length;
    let digits = was.replace(/\D/g, '');
    if (digits.length > 8 && digits.startsWith('976')) digits = digits.slice(3);
    digits = digits.slice(0, 8);
    const next = digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
    if (next === was) return;
    input.value = next;
    let at = 0;
    for (let seen = 0; at < next.length && seen < digitsBefore; at++) if (/\d/.test(next[at])) seen++;
    if (document.activeElement === input) input.setSelectionRange(at, at);
  };
  input.addEventListener('input', group);
  group();
  return input;
}

/** A Mongolian number as people read it: `+97699112233` → `+976 9911 2233`. Anything else comes back as it was. */
export function phoneText(value) {
  const raw = String(value ?? '');
  const m = /^(?:\+?976)?(\d{4})(\d{4})$/.exec(raw.replace(/[\s-]/g, ''));
  return m ? `+976 ${m[1]} ${m[2]}` : raw;
}

/**
 * A money field that groups the tögrög in thousands — «1,250,000» — while
 * they are typed or pasted, the caret kept where it was: the amount reads as
 * `mnt()` writes it, and a zero too many shows before it is sent. Whole
 * tögrög: anything but digits falls away. What the field holds is then text,
 * not a number — read it with `moneyValue(input.value)`. A popup's money
 * field (`format: 'money'`) does this itself and hands `onSubmit` the digits.
 */
export function moneyInput(input) {
  if (!input) return input;
  const group = () => {
    const was = input.value;
    const caret = input.selectionStart ?? was.length;
    const digitsBefore = was.slice(0, caret).replace(/\D/g, '').length;
    const digits = was.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const next = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (next === was) return;
    input.value = next;
    let at = 0;
    for (let seen = 0; at < next.length && seen < digitsBefore; at++) if (/\d/.test(next[at])) seen++;
    if (document.activeElement === input) input.setSelectionRange(at, at);
  };
  input.addEventListener('input', group);
  group();
  return input;
}

/**
 * An amount as it was typed, as a number: «1,250,000», «1 250 000₮» and
 * «1250000» are all 1250000. Anything that is not whole tögrög — empty,
 * «38.5», words — is NaN, so the check reading it says so in words rather
 * than sending a guess.
 */
export function moneyValue(text) {
  const bare = String(text ?? '').replace(/[\s,'’₮]/g, '');
  return /^\d+$/.test(bare) ? Number(bare) : NaN;
}

/** What a popup sends for a money field: its digits, ungrouped — or, when it is not whole tögrög, the words as typed for the page's own check to refuse. */
function moneyDigits(text) {
  const bare = String(text ?? '').replace(/[\s,'’₮]/g, '');
  return /^\d+$/.test(bare) ? bare.replace(/^0+(?=\d)/, '') : String(text ?? '').trim();
}

/* ── avatar ────────────────────────────────────────────────────────── */

/**
 * A mark for a person or a place: a 4×4 grid mirrored down the middle, drawn
 * from the seed alone, so the same phone number gets the same mark on every
 * page and every device and nobody gets a colour of their own. The seed is
 * hashed to eight nibbles, one per cell of the left half. Each nibble says
 * whether its cell is empty (a multiple of three), a circle (odd) or a square
 * (even); 8 and up is drawn in ink rather than grey; the first at 13 or above
 * is the one accent. `size` is 'sm' (30) or 'lg' (54); anything else is 40.
 */
export function avatar(seed, size) {
  // FNV-1a over the code points, then murmur3's finaliser so seeds a digit
  // apart — two phone numbers — do not draw near-identical marks.
  let h = 0x811c9dc5;
  for (const ch of String(seed ?? '')) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;

  const nibbles = Array.from({ length: 8 }, (_, i) => (h >>> (i * 4)) & 15);
  const filled = (v) => v % 3 !== 0;
  if (!nibbles.some(filled)) nibbles[0] = 2; // never a blank plate
  const accent = nibbles.findIndex((v) => v >= 13 && filled(v));

  const cell = (i) => {
    const v = nibbles[i];
    if (!filled(v)) return '<i data-k="x"></i>';
    const mark = i === accent ? ' data-a' : v >= 8 ? ' data-hi' : '';
    return `<i data-k="${v % 2 ? 'o' : ''}"${mark}></i>`;
  };
  let cells = '';
  for (let r = 0; r < 4; r++) {
    const outer = cell(r * 2);
    const inner = cell(r * 2 + 1);
    cells += outer + inner + inner + outer;
  }
  const sized = size === 'sm' || size === 'lg' ? ` data-size="${size}"` : '';
  return `<span class="avatar" data-mark${sized} aria-hidden="true">${cells}</span>`;
}

/* ── the demo clock ────────────────────────────────────────────────── */

/**
 * Service runs 11:30–14:00 and the interesting gap is fifteen minutes long,
 * so the clock is a control rather than a fact. Every jump also runs a
 * scheduler pass, because otherwise time moves and nothing acts on it.
 */
export function mountClock(onChange) {
  // The strip is the developer's: a phone inside the shell is not a
  // developer's browser, and a production server has no /dev/clock to move.
  // Neither gets the strip; the page's data loads on its own either way.
  if (shell.present) {
    onChange?.();
    return async () => {};
  }
  const bar = document.createElement('div');
  bar.className = 'clockbar';
  bar.innerHTML = `
    <span class="lab">Демо цаг</span>
    <span class="now mn" id="clock-now">—</span>
    <button type="button" data-to="11:40">11:40 захиалга</button>
    <button type="button" data-to="12:14">12:14 arm</button>
    <button type="button" data-to="12:21">12:21 гал</button>
    <button type="button" data-advance="1">+1 мин</button>
    <button type="button" data-advance="5">+5 мин</button>
    <button type="button" data-tick data-hot>Scheduler</button>
  `;
  document.body.prepend(bar);

  const label = bar.querySelector('#clock-now');
  const refresh = async () => {
    const { label: text } = await api('/dev/clock');
    label.textContent = text;
    onChange?.();
  };

  bar.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    try {
      if (button.dataset.to) {
        await api('/dev/clock', { method: 'POST', body: { to: button.dataset.to } });
        await api('/dev/tick', { method: 'POST' });
      } else if (button.dataset.advance) {
        await api('/dev/clock', {
          method: 'POST',
          body: { advance: Number(button.dataset.advance) },
        });
        await api('/dev/tick', { method: 'POST' });
      } else if ('tick' in button.dataset) {
        const report = await api('/dev/tick', { method: 'POST' });
        const said = Object.entries(report)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k} ${v}`)
          .join(' · ');
        toast(said || 'Хийх зүйл алга');
      }
      await refresh();
    } catch (error) {
      toast(error.message, 'bad');
    }
  });

  refresh().catch(() => {
    // No /dev/clock: production. The strip has nothing to control.
    bar.remove();
    onChange?.();
  });
  return refresh;
}

/* ── how an order reads ────────────────────────────────────────────── */

/**
 * What each state is called, and the line under it.
 *
 * Shared rather than owned by the dine-in page: the home screen puts the same
 * order in front of the same person, and two pages disagreeing about what
 * ARMED means would read as two different products.
 */
export const HEADLINE = {
  PLACED: ['Хүлээгдэж байна', 'Ресторан хараахан хараагүй'],
  ACCEPTED: ['Баталгаажлаа', 'Гал тавих цаг тооцоологдож байна'],
  HELD: ['Хүлээж байна', 'Гал тогоо ачаалалтай байна'],
  FIRED: ['Гал дээр', 'Хоол хийгдэж эхэллээ'],
  READY: ['Бэлэн', 'Ширээндээ хүрч ирлээ'],
  SERVED: ['Сайхан хооллоорой', ''],
  CLOSED: ['Дууслаа', 'Баярлалаа'],
  CANCELLED: ['Цуцлагдлаа', 'Мөнгө буцаагдана'],
  REFUNDED: ['Буцаагдлаа', 'Мөнгө таны данс руу очлоо'],
  NO_SHOW: ['Ирээгүй', 'Хоол хадгалагдаагүй'],
  REJECTED: ['Татгалзсан', 'Мөнгө бүтэн буцаагдана'],
};

/**
 * A lunch state's one word where there is room for a word and no more — a
 * chip, a launcher row, a list. Two kinds of state need one here. Those
 * HEADLINE leaves out on purpose: dine's status reads a missing entry as «say
 * the time» (12:21, with «Энэ цагт гал дээр гарна» under it), so they stay
 * apart from HEADLINE. And those whose HEADLINE is a sentence, said once on
 * the status screen — «Цуцлагдлаа», «Сайхан хооллоорой» — where a chip names
 * the state: «Цуцлагдсан», «Үйлчилсэн». Never the state's name in English.
 * `headlineWord(state)` is the one to call.
 */
export const LUNCH_WORD = {
  ACCEPTED: 'Баталгаажсан',
  SCHEDULED: 'Хүлээн авсан',
  ARMED: 'Хөдлөх цаг',
  COOKING: 'Гал дээр',
  RESLOTTED: 'Цаг шилжсэн',
  SERVED: 'Үйлчилсэн',
  CLOSED: 'Дууссан',
  CANCELLED: 'Цуцлагдсан',
  REFUNDED: 'Буцаасан',
};

/** A lunch state's chip word: LUNCH_WORD's, else HEADLINE's own word; never the raw name. */
export function headlineWord(state) {
  return LUNCH_WORD[state] ?? HEADLINE[state]?.[0] ?? '';
}

/**
 * The same, for an идэш. Shared for the same reason: the launcher and the
 * page put the same order in front of the same person.
 */
export const IDESH_HEADLINE = {
  DRAFT: ['Төлөгдөөгүй', 'Төлбөр хүлээгдэж байна'],
  PAID: ['Төлсөн', 'Нийлүүлэгч бэлтгэж эхлэхийг хүлээж байна'],
  PREPARING: ['Бэлтгэж байна', 'Мал нядлагдаж байна'],
  READY: ['Бэлэн', 'Мах бэлэн боллоо'],
  DISPATCHED: ['Замд', 'Хүргэлтэнд гарлаа'],
  HANDED: ['Хүлээлгэн өгсөн', 'Сайхан өвөлжөөрэй'],
  CLOSED: ['Дууслаа', 'Баярлалаа'],
  CANCELLED: ['Цуцлагдлаа', 'Мөнгө буцаагдана'],
  REFUNDED: ['Буцаагдлаа', 'Мөнгө таны данс руу орлоо'],
};

/**
 * An идэш's state in one word — the chip, the pill, the list row, the state
 * band on a supplier's card — the same word on the website, the launcher, the
 * supplier's screen and the desk, so one order never reads as two. The
 * sentence a status page leads with is IDESH_HEADLINE's («Цуцлагдлаа», and
 * what happens next under it); the state's name is this: «Цуцлагдсан».
 */
export const IDESH_STATE = {
  DRAFT: 'Төлөгдөөгүй',
  PAID: 'Төлсөн',
  PREPARING: 'Бэлтгэж байна',
  READY: 'Бэлэн',
  DISPATCHED: 'Замд',
  HANDED: 'Хүлээлгэн өгсөн',
  CLOSED: 'Дууссан',
  CANCELLED: 'Цуцлагдсан',
  REFUNDED: 'Буцаасан',
};

/**
 * The states an идэш is still going on in: paid for and not yet in the
 * guest's hands — the order's page looks again now and then, and shows the
 * handover code. Handed over, cancelled and refunded are over. A guest's
 * «Идэвхтэй» on /home and /orders also keeps a cancelled order whose money
 * is still on its way back, as the server's own live list does (site.js
 * stillGoing).
 */
export const IDESH_LIVE = ['PAID', 'PREPARING', 'READY', 'DISPATCHED'];

/** What each kind of animal is called, and the word for one of it. */
export const KIND = {
  sheep: 'Хонь',
  goat: 'Ямаа',
  beef: 'Үхэр',
  horse: 'Адуу',
};

/**
 * Mongolia's banks, the biggest first: what a guest picks the refund's bank
 * from on /orders, and what the supplier's payout account offers as they
 * type. One list, so a bank is not on one page and missing from the next; a
 * bank that is not here is typed in («Бусад банк»).
 */
export const BANK_NAMES = [
  'Хаан банк',
  'Голомт банк',
  'Худалдаа хөгжлийн банк',
  'Хас банк',
  'Төрийн банк',
  'Капитрон банк',
  'Ариг банк',
  'Богд банк',
  'М банк',
  'Тээвэр хөгжлийн банк',
  'Үндэсний хөрөнгө оруулалтын банк',
  'Чингис хаан банк',
];

export const mnt = (value) => `${Number(value).toLocaleString('mn-MN')}₮`;

/**
 * The same amount, for innerHTML: the digits in the mono, the ₮ set in the
 * sans beside them (the mono has no tugrik). textContent still reads
 * `28,000₮`, so anything that reads the amount as text sees what mnt() said.
 *
 * `tone` names the movement, not a colour: 'credit' is +digits in ready,
 * 'debit' is −digits (a real minus, not a hyphen) in stop. Either sign goes in
 * front of the absolute value — the caller says which way the money went and
 * the number does not get to disagree. Without a tone a negative amount still
 * gets a real minus in ink.
 */
export function money(value, tone) {
  const n = Number(value);
  const digits = Math.abs(n).toLocaleString('mn-MN');
  const sign = tone === 'credit' ? '+' : tone === 'debit' || n < 0 ? '−' : '';
  const attr = tone === 'credit' || tone === 'debit' ? ` data-tone="${tone}"` : '';
  return `<span class="money"${attr}>${sign}${digits}<span class="cur">₮</span></span>`;
}

/**
 * A moment as Ulaanbaatar reads it — its day («2026-10-02») and its clock
 * («06:30») — whatever zone the computer is set to; now, when no moment is
 * given. A stamp's first ten characters are UTC's day, and before 08:00 here
 * that is yesterday: every day and time a page says is read here, the day
 * from the same moment as the time beside it.
 */
const UB_PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function ubParts(at = Date.now()) {
  const p = Object.fromEntries(UB_PARTS.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, clock: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

/** `2026-11-03` → `11-р сарын 3`. The day, said the way a message says it. */
export function dayLabel(day) {
  if (!day) return '—';
  const [, month, date] = day.split('-');
  return `${Number(month)}-р сарын ${Number(date)}`;
}

/** `2026-11-03` → `11/3`. The day, at the size a card corner allows. */
export function dayShort(day) {
  if (!day) return '—';
  const [, month, date] = day.split('-');
  return `${Number(month)}/${Number(date)}`;
}

export function hhmm(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Ulaanbaatar',
  }).format(new Date(iso));
}
