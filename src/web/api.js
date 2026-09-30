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
      <div data-code hidden><input name="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" aria-label="Имэйлд ирсэн код"></div>
      <button class="btn" data-v="primary" data-size="lg" type="button" data-email-go>Код авах</button>
      <div class="again" data-again-row hidden>
        <button class="link" type="button" data-resend>Код дахин авах</button>
        <button class="link" type="button" data-change>Хаяг солих</button>
      </div>
    </div>
    <details class="fold" data-password>
      <summary>Нууц үгээр нэвтрэх, бүртгүүлэх</summary>
      <div class="body">
        <label class="field" data-f="name" hidden><span>Нэр</span><input name="name" autocomplete="name" placeholder="Таны нэр"></label>
        <label class="field" data-f="login"><span data-login-label>Имэйл эсвэл утас</span><input name="login" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="нэр@gmail.com · 8811 2233"></label>
        <div data-f="code" hidden><input name="pwcode" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" aria-label="Имэйлд ирсэн код"></div>
        <label class="field" data-f="password"><span data-password-label>Нууц үг</span><input name="password" type="password" autocomplete="current-password" placeholder="Дор хаяж 8 тэмдэгт"></label>
        <p class="cap" data-pw-hint hidden></p>
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

  /* Google: a plain link, so the browser does the leaving. */
  const google = $('[data-google]');
  google.href = `/v1/auth/google/start?return=${encodeURIComponent(returnTo)}`;

  /* a code by email */
  const email = $('[name="email"]');
  const code = $('[name="code"]');
  const emailGo = $('[data-email-go]');
  const hint = $('[data-email-hint]');
  hint.textContent = emailHint;
  let sentTo = null;

  const askForCode = async () => {
    const address = email.value.trim();
    if (!address) {
      email.focus();
      return;
    }
    emailGo.setAttribute('data-busy', '');
    try {
      await api('/v1/auth/email/start', { method: 'POST', body: { email: address } });
      sentTo = address;
      $('[data-code]').hidden = false;
      $('[data-again-row]').hidden = false;
      hint.textContent = `${address} хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай.`;
      emailGo.textContent = 'Нэвтрэх';
      code.value = '';
      code.focus();
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      emailGo.removeAttribute('data-busy');
    }
  };

  const checkCode = async () => {
    const typed = code.value.replace(/\D/g, '');
    if (typed.length !== 6) {
      code.focus();
      return;
    }
    emailGo.setAttribute('data-busy', '');
    try {
      const { token } = await api('/v1/auth/email/verify', { method: 'POST', body: { email: sentTo, code: typed, device } });
      done(token);
    } catch (error) {
      toast(error.message, 'bad');
      code.select();
    } finally {
      emailGo.removeAttribute('data-busy');
    }
  };

  const startOver = () => {
    sentTo = null;
    $('[data-code]').hidden = true;
    $('[data-again-row]').hidden = true;
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

  const turnTo = (next) => {
    face = next;
    step = 'ask';
    codeFor = null;
    pw.code.value = '';
    pw.password.value = '';
    draw();
    (face === 'up' ? pw.name : pw.login).focus();
  };

  const busy = async (work) => {
    if (pw.go.hasAttribute('data-busy')) return;
    pw.go.setAttribute('data-busy', '');
    try {
      await work();
    } catch (error) {
      toast(error.message, 'bad');
      if (step === 'code' && error.code && /CODE|EXPIRED/.test(error.code)) pw.code.select();
    } finally {
      pw.go.removeAttribute('data-busy');
    }
  };

  /** A code for signing up or resetting, to the inbox behind the login. */
  const askForPasswordCode = () =>
    busy(async () => {
      const login = pw.login.value.trim();
      if (!login) return pw.login.focus();
      if (face === 'up' && pw.password.value.length < 8) {
        toast('Нууц үг дор хаяж 8 тэмдэгт байх ёстой.', 'bad');
        return pw.password.focus();
      }
      const { to } = await api('/v1/auth/password/code', {
        method: 'POST',
        body: { login, purpose: face === 'up' ? 'sign_up' : 'reset' },
      });
      codeFor = login;
      step = 'code';
      pw.code.value = '';
      draw();
      say(`${to} хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай.`);
      pw.code.focus();
    });

  /** The code and the password: an account made, or a password replaced — and a session either way. */
  const setPassword = () =>
    busy(async () => {
      const typed = pw.code.value.replace(/\D/g, '');
      if (typed.length !== 6) return pw.code.focus();
      if (pw.password.value.length < 8) {
        toast('Нууц үг дор хаяж 8 тэмдэгт байх ёстой.', 'bad');
        return pw.password.focus();
      }
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
      if (!login) return pw.login.focus();
      if (!pw.password.value) return pw.password.focus();
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
    // Google will not sign anybody in inside an app's web view; the app has its own sheet.
    const googleOpen = Boolean(open.google) && !shell.present;
    google.hidden = !googleOpen;
    $('[data-email]').hidden = !open.email;
    $('[data-or]').hidden = !(googleOpen && open.email);
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
    sheet.innerHTML = `
      <header>
        <div><h2 id="signin-title">Нэвтрэх</h2><div class="sub"></div></div>
        <button class="x" type="button" aria-label="Хаах"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </header>
      <div class="body" style="padding:16px 20px 20px"></div>`;
    sheet.querySelector('header .sub').textContent = reason;

    let settled = false;
    const close = (token) => {
      if (settled) return;
      settled = true;
      sheet.removeAttribute('data-open');
      scrim.removeAttribute('data-open');
      setTimeout(() => {
        sheet.remove();
        scrim.remove();
      }, 260);
      if (token) resolve(token);
      else reject(new ApiError(401, { error: { code: 'SIGN_IN', message_mn: 'Нэвтрээгүй байна.' } }));
    };

    sheet.querySelector('.body').append(signInDoors({ device: 'Вэб', onToken: close }));
    document.body.append(scrim, sheet);
    requestAnimationFrame(() => sheet.setAttribute('data-open', ''));
    sheet.querySelector('.x').addEventListener('click', () => close(null));
    scrim.addEventListener('click', () => close(null));
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
    $('[data-open="email"]').addEventListener('click', () => {
      let sentTo = null;
      const first = [
        { name: 'email', label: 'Имэйл хаяг', type: 'email', autocomplete: 'email', placeholder: 'нэр@gmail.com', required: true, wide: true },
        ...(me.has_password ? [{ name: 'current', label: 'Одоогийн нууц үг', type: 'password', autocomplete: 'current-password', required: true, wide: true }] : []),
      ];
      void popup({
        title: 'Имэйл холбох',
        sub: 'Нууц үгээ мартвал энэ хаягаар сэргээнэ. Хаяг руу 6 оронтой код илгээнэ.',
        fields: first,
        submit: 'Код авах',
        width: 480,
        onSubmit: async (v, { step }) => {
          if (!sentTo) {
            await api('/v1/me/email/code', { method: 'POST', token, body: { email: v.email, password: v.current || undefined } });
            sentTo = v.email;
            step({
              sub: `<b>${popupEsc(sentTo)}</b> хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай.`,
              fields: [{ name: 'code', label: 'Имэйлд ирсэн код', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '······', required: true, wide: true }],
              submit: 'Баталгаажуулах',
            });
            return false;
          }
          const code = v.code.replace(/\D/g, '');
          if (code.length !== 6) throw new Error('Код 6 оронтой.');
          await api('/v1/me/email', { method: 'POST', token, body: { email: sentTo, code } });
          toast('Имэйл холбогдлоо.', 'good');
          await draw();
        },
      });
    });

    // A password: changed knowing the old one. The first has no old one to
    // know, so it is two steps of one popup, like the address above: a code
    // to the address on the account, then the code and the new password.
    $('[data-open="password"]').addEventListener('click', () => {
      const nextField = { name: 'next', label: 'Шинэ нууц үг', type: 'password', autocomplete: 'new-password', placeholder: 'Дор хаяж 8 тэмдэгт', required: true, wide: true };
      const saved = async (revoked) => {
        toast(revoked ? `Нууц үг хадгалагдлаа. Өөр ${revoked} төхөөрөмжөөс гаргалаа.` : 'Нууц үг хадгалагдлаа.', 'good');
        await draw();
      };
      if (me.has_password) {
        void popup({
          title: 'Нууц үг солих',
          sub: 'Бусад төхөөрөмж дээрх нэвтрэлт хаагдана, энэ хэвээр үлдэнэ.',
          width: 480,
          fields: [{ name: 'current', label: 'Одоогийн нууц үг', type: 'password', autocomplete: 'current-password', required: true, wide: true }, nextField],
          onSubmit: async (v) => {
            if (v.next.length < 8) throw new Error('Нууц үг дор хаяж 8 тэмдэгт байх ёстой.');
            const { revoked } = await api('/v1/me/password', { method: 'POST', token, body: { current: v.current, next: v.next } });
            await saved(revoked);
          },
        });
        return;
      }
      let sentTo = null;
      const sentSub = () => `<b>${popupEsc(sentTo)}</b> хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай.`;
      void popup({
        title: 'Нууц үг тохируулах',
        sub: `Таныг мөн гэдгийг батлах 6 оронтой код <b>${popupEsc(me.email)}</b> хаяг руу илгээнэ. Бусад төхөөрөмж дээрх нэвтрэлт хаагдана, энэ хэвээр үлдэнэ.`,
        submit: 'Код авах',
        width: 480,
        onSubmit: async (v, { step, el, say }) => {
          if (!sentTo) {
            const sent = await api('/v1/me/password/code', { method: 'POST', token });
            sentTo = sent.to;
            step({
              sub: sentSub(),
              fields: [
                { name: 'code', label: 'Имэйлд ирсэн код', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '······', required: true, wide: true },
                nextField,
                { type: 'note', html: '<button class="btn" data-v="link" type="button" data-resend>Код дахин авах</button>' },
              ],
              submit: 'Тохируулах',
            });
            // A letter that never came, or a code spent on three wrong tries:
            // another one, here, rather than closing the popup to start over.
            const again = el.querySelector('[data-resend]');
            again.addEventListener('click', async () => {
              if (again.hasAttribute('data-busy')) return;
              again.setAttribute('data-busy', '');
              try {
                sentTo = (await api('/v1/me/password/code', { method: 'POST', token })).to;
                el.querySelector('[name="code"]').value = '';
                step({ sub: sentSub() });
              } catch (error) {
                say(error?.message ?? 'Код илгээж чадсангүй.');
              } finally {
                again.removeAttribute('data-busy');
              }
            });
            return false;
          }
          const code = v.code.replace(/\D/g, '');
          if (code.length !== 6) throw new Error('Код 6 оронтой.');
          if (v.next.length < 8) throw new Error('Нууц үг дор хаяж 8 тэмдэгт байх ёстой.');
          const { revoked } = await api('/v1/me/password', { method: 'POST', token, body: { next: v.next, code } });
          await saved(revoked);
        },
      });
    });
  };

  box.ready = draw();
  return box;
}

/* ── popups ────────────────────────────────────────────────────────── */

let popupSeq = 0;
const popupEsc = (value) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const POPUP_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

/** One field of a popup's form, as the design system draws a field. */
function popupField(f, n) {
  const id = `popup-${n}-${f.name ?? Math.random().toString(36).slice(2)}`;
  const wide = f.wide || ['textarea', 'checks', 'icons', 'static', 'note', 'pick'].includes(f.type) ? ' data-wide' : '';
  const hint = f.hint ? `<small>${popupEsc(f.hint)}</small>` : '';
  const req = f.required ? ' required' : '';
  if (f.type === 'note') return `<p class="popup-text"${wide}>${f.html ?? popupEsc(f.text)}</p>`;
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
    return `<div class="field popup-pick"${wide} data-pick="${popupEsc(f.name)}"><span>${popupEsc(f.label)}</span><input type="search" class="input search" id="${id}" placeholder="${popupEsc(
      f.placeholder ?? 'Хайх…',
    )}" autocomplete="off" spellcheck="false" aria-label="${popupEsc(f.label)}"><div class="popup-pick-list" role="radiogroup" aria-label="${popupEsc(f.label)}" aria-busy="true"></div>${hint}</div>`;
  }
  if (f.type === 'select') {
    return `<label class="field"${wide} for="${id}"><span>${popupEsc(f.label)}</span><select id="${id}" name="${popupEsc(f.name)}"${req}>${f.options
      .map(([v, w]) => `<option value="${popupEsc(v)}"${String(v) === String(f.value ?? '') ? ' selected' : ''}>${popupEsc(w)}</option>`)
      .join('')}</select>${hint}</label>`;
  }
  if (f.type === 'textarea') {
    return `<label class="field"${wide} for="${id}"><span>${popupEsc(f.label)}</span><textarea id="${id}" name="${popupEsc(f.name)}" placeholder="${popupEsc(f.placeholder ?? '')}"${req}>${popupEsc(f.value ?? '')}</textarea>${hint}</label>`;
  }
  const attrs = [
    `type="${f.type ?? 'text'}"`,
    f.inputmode ? `inputmode="${f.inputmode}"` : '',
    f.autocomplete ? `autocomplete="${f.autocomplete}"` : '',
    f.type === 'email' || f.inputmode === 'email' ? 'autocapitalize="none" spellcheck="false"' : '',
  ].filter(Boolean).join(' ');
  return `<label class="field"${wide} for="${id}"><span>${popupEsc(f.label)}</span><input id="${id}" name="${popupEsc(f.name)}" ${attrs} value="${popupEsc(f.value ?? '')}" placeholder="${popupEsc(f.placeholder ?? '')}"${req}>${hint}</label>`;
}

/**
 * A pick field at work: it asks `search(q)` for rows ({ value, title, sub,
 * flag, note, disabled }) when it opens and again as the person types, and
 * draws them as a list with one to choose. Every word of a row is text; a
 * `flag` is one word after the line under the title, in the tone that asks
 * for a second look — «баталгаагүй» beside a number nobody proved. The one
 * chosen stays in the list whatever is typed next, so the form still carries
 * it. Enter searches at once; it does not answer the popup.
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

/**
 * A popup over the page: the one place a thing is added, changed, or said no
 * to. On top its title and what it is about; in the middle the fields; at the
 * foot «Болих» and the one button that does it. It closes on its cross, on
 * Esc and on the dim around it, keeps the keyboard inside while it is open,
 * and gives the focus back to whatever opened it. On a phone it is a sheet
 * from the bottom.
 *
 * `fields` draw the form — { name, label, type: text | email | tel | number |
 * date | textarea | select | checks | icons | pick | static | note, value,
 * placeholder, options, required, hint, wide, inputmode, autocomplete }; a
 * pick also takes `search(q)` and `empty` (see `mountPick`). All of it is
 * text, escaped here, except three things that are markup because they carry
 * a name in bold or a code in mono: `sub`, and a note's or a static's
 * `html`. Whoever fills those escapes what a person wrote. `onSubmit(values,
 * popup)` does the work: what it returns closes the popup and is what the
 * promise resolves to; `false` keeps it open (a first step done, the second
 * drawn with `popup.step(...)`); a thrown error is said inside the popup, over
 * the fields, and the popup stays for another try. A button a step draws for
 * itself — «Код дахин авах» — says its own trouble in the same place, with
 * `popup.say(...)`. Closed without an answer, the promise resolves to null.
 */
export function popup({ title, sub = '', fields = [], submit = 'Хадгалах', cancel = 'Болих', danger = false, width = 560, onSubmit = async () => true, id = null }) {
  return new Promise((resolve) => {
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
    sheet.innerHTML = `
      <header><div><h2 id="popup-title-${n}"></h2><div class="sub"></div></div><button class="x" type="button" aria-label="Хаах">${POPUP_X}</button></header>
      <form class="body" novalidate>
        <div class="callout popup-error" data-k="warn" role="alert" hidden><span></span></div>
        <div class="fields"></div>
      </form>
      <footer><button class="btn" data-v="quiet" type="button" data-cancel></button><button class="btn" type="button" data-submit></button></footer>`;
    const $ = (selector) => sheet.querySelector(selector);
    const errorBox = $('.popup-error');
    const go = $('[data-submit]');
    const say = (message) => {
      errorBox.hidden = !message;
      errorBox.querySelector('span').textContent = message ?? '';
    };

    /** Draw a step: the words on top, the fields, the buttons. */
    const step = (next) => {
      if (next.title !== undefined) $('header h2').textContent = next.title;
      if (next.sub !== undefined) {
        $('header .sub').innerHTML = next.sub;
        $('header .sub').hidden = !next.sub;
      }
      if (next.fields) {
        $('.fields').innerHTML = next.fields.map((f) => popupField(f, n)).join('');
        for (const f of next.fields) if (f.type === 'pick') mountPick([...sheet.querySelectorAll('[data-pick]')].find((box) => box.dataset.pick === f.name), f);
      }
      if (next.submit !== undefined) go.textContent = next.submit;
      if (next.danger !== undefined) go.setAttribute('data-v', next.danger ? 'danger' : 'primary');
      say(null);
      const first = sheet.querySelector('.fields input:not([type="checkbox"]):not([type="radio"]), .fields select, .fields textarea');
      (first ?? go).focus?.();
    };
    step({ title, sub, fields, submit, danger });
    $('[data-cancel]').textContent = cancel;

    const values = () => {
      const out = {};
      for (const input of sheet.querySelectorAll('.fields [name]:not(:disabled)')) {
        if (input.type === 'radio') {
          if (input.checked) out[input.name] = input.value;
          continue;
        }
        // A password is what was typed, spaces and all.
        out[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'password' ? input.value : input.value.trim();
      }
      return out;
    };

    let closed = false;
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
      if (opener?.isConnected) opener.focus?.();
      resolve(answer);
    };

    const run = async () => {
      if (go.hasAttribute('data-busy')) return;
      // What must be there, is — said here, before anything is sent.
      for (const input of sheet.querySelectorAll('.fields [required]')) {
        const empty = input.type === 'checkbox' ? !input.checked : !input.value.trim();
        input.toggleAttribute('aria-invalid', empty);
        if (empty) {
          const label = input.closest('.field')?.querySelector('span')?.textContent ?? '';
          say(`${label} хоосон байна.`);
          input.focus();
          return;
        }
      }
      go.setAttribute('data-busy', '');
      say(null);
      try {
        const answer = await onSubmit(values(), { step, el: sheet, say });
        if (answer === false) return;
        close(answer ?? true);
      } catch (error) {
        say(error?.message ?? 'Алдаа гарлаа.');
      } finally {
        go.removeAttribute('data-busy');
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
      const stops = [...sheet.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')].filter(
        (node) => node.getClientRects().length > 0,
      );
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
    $('form').addEventListener('submit', (e) => {
      e.preventDefault();
      void run();
    });
    // Enter in a one-line field answers, as a form does; in a textarea it is a new line.
    $('form').addEventListener('keydown', (e) => {
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
    document.documentElement.setAttribute('data-modal-open', '');
    void sheet.offsetWidth; // drawn closed once, so opening is a movement rather than a jump
    scrim.setAttribute('data-open', '');
    sheet.setAttribute('data-open', '');
    const first = sheet.querySelector('.fields input:not([type="checkbox"]):not([type="radio"]), .fields select, .fields textarea');
    (first ?? sheet).focus();
  });
}

/**
 * «Are you sure?» as a popup: what is about to happen, a reason to keep when
 * the record wants one, and the button that does it — in the stop colour
 * when it cannot be undone. Resolves to what `onConfirm(reason)` returned,
 * or null when the person said no.
 */
export function confirmPopup({ title, text = '', ok = 'Тийм', cancel = 'Болих', danger = false, reason = null, onConfirm = async () => true }) {
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
      wide: true,
    });
  }
  return popup({ title, fields, submit: ok, cancel, danger, width: 480, onSubmit: (values) => onConfirm(values.reason ?? '', values) });
}

/* ── toast ─────────────────────────────────────────────────────────── */

let toastTimer;
/**
 * One line at the bottom of the screen, gone after 3.2s. `kind` is 'good'
 * (a ready dot before the text) or 'bad' (stop on its own text); it lands on
 * `#toast` as `data-kind` and is cleared again when the next toast has
 * none. The element is created on first use with `role=status`, and
 * `data-show` is what the tests read on a timeout — both stay as they are.
 */
export function toast(message, kind) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
  el.dataset.show = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => delete el.dataset.show, 3200);
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
  REFUNDED: ['Буцаагдлаа', 'Мөнгө таны түрийвчинд орлоо'],
};

/** What each kind of animal is called, and the word for one of it. */
export const KIND = {
  sheep: 'Хонь',
  goat: 'Ямаа',
  beef: 'Үхэр',
  horse: 'Адуу',
};

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
