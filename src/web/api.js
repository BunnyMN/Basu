/* Shared plumbing for the demo pages: fetch with the right token, the
   clock strip, and a toast. Kept dependency-free — a PWA that has to compile
   before it can be looked at is a PWA nobody looks at. */

export const store = {
  get guestToken() {
    return localStorage.getItem('basu.guest');
  },
  set guestToken(v) {
    v ? localStorage.setItem('basu.guest', v) : localStorage.removeItem('basu.guest');
  },
  get deviceToken() {
    return localStorage.getItem('basu.device');
  },
  set deviceToken(v) {
    v ? localStorage.setItem('basu.device', v) : localStorage.removeItem('basu.device');
  },
  get supplierToken() {
    return localStorage.getItem('basu.supplier');
  },
  set supplierToken(v) {
    v ? localStorage.setItem('basu.supplier', v) : localStorage.removeItem('basu.supplier');
  },
  get opsToken() {
    return localStorage.getItem('basu.ops');
  },
  set opsToken(v) {
    v ? localStorage.setItem('basu.ops', v) : localStorage.removeItem('basu.ops');
  },
};

export class ApiError extends Error {
  constructor(status, body) {
    // The server already wrote this in Mongolian; showing anything else would
    // be inventing a second, worse explanation of the same thing.
    super(body?.error?.message_mn ?? 'Алдаа гарлаа.');
    this.status = status;
    this.code = body?.error?.code ?? 'UNKNOWN';
  }
}

export async function api(path, { method = 'GET', body, token, idempotencyKey, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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
 * Back from Google. The server sends the person to the page they started on
 * with the session in the address's fragment — `/idesh#auth=…` — which never
 * reaches a server or a log. It is taken here, before the page's own script
 * runs, and wiped from the address bar and the history entry, so a copied
 * link or a screenshot of the address carries nothing.
 */
export const authReturn = (() => {
  if (typeof location === 'undefined' || !location.hash.includes('auth')) return null;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('auth');
  const refused = fragment.get('auth_error');
  if (!token && !refused) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (token) {
    // A page that keeps a session of its own — the desk, `data-session="desk"`
    // on its root — decides where this one goes; everywhere else it is the
    // guest's.
    if (document.documentElement.dataset.session !== 'desk') store.guestToken = token;
    return { token };
  }
  setTimeout(() => toast(GOOGLE_REFUSALS[refused] ?? GOOGLE_REFUSALS.SOCIAL_REFUSED, 'bad'), 0);
  return { refused };
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
 * it: the page is left for Google's and comes back to `returnTo`, signed in,
 * by way of `authReturn` above. `keep: false` leaves the token for `onToken`
 * to put where it belongs (the desk keeps its own); `password: false` leaves
 * the fold out. `box.ready` resolves with which doors were drawn.
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
      <p class="cap" data-email-hint>${emailHint}</p>
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
    if (keep) store.guestToken = token;
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
        <div><h2 id="signin-title">Нэвтрэх</h2><div class="sub">${reason}</div></div>
        <button class="x" type="button" aria-label="Хаах"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </header>
      <div class="body" style="padding:16px 20px 20px"></div>`;

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
 * Adding it sends a code there; an account with a password types it too, so
 * that a session left open somewhere cannot give itself a way back in.
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
            me.has_password ? 'Тохируулсан.' : 'Тохируулаагүй — нууц үггүйгээр ч нэвтэрч болно.'
          }</span></div>
          <div class="end"><button class="btn" data-size="sm" type="button" data-open="password">${me.has_password ? 'Солих' : 'Тохируулах'}</button></div>
        </div>
      </div>`;
    const $ = (selector) => box.querySelector(selector);
    $('[data-email-sub]').textContent = me.email ?? 'Холбоогүй. Нууц үгээ мартвал энэ хаягаар сэргээнэ.';
    $('[data-open="email"]').hidden = Boolean(me.email);

    /** One small form under a row, in place of its button. */
    const openForm = (row, html) => {
      box.querySelector('.account-form')?.remove();
      for (const b of box.querySelectorAll('[data-open]')) b.disabled = false;
      const form = document.createElement('div');
      form.className = 'card-body account-form';
      form.innerHTML = html;
      row.after(form);
      row.querySelector('[data-open]').disabled = true;
      form.querySelector('input')?.focus();
      return form;
    };

    $('[data-open="email"]').addEventListener('click', () => {
      const form = openForm(
        $('[data-row="email"]'),
        `<label class="field"><span>Имэйл хаяг</span><input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="нэр@gmail.com"></label>
        ${me.has_password ? '<label class="field"><span>Одоогийн нууц үг</span><input name="current" type="password" autocomplete="current-password"></label>' : ''}
        <div data-code hidden><input name="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" aria-label="Имэйлд ирсэн код"></div>
        <p class="cap" data-say>Хаяг руу 6 оронтой код илгээнэ.</p>
        <button class="btn" data-v="primary" type="button" data-go>Код авах</button>`,
      );
      const field = (name) => form.querySelector(`[name="${name}"]`);
      const go = form.querySelector('[data-go]');
      let sentTo = null;
      const run = async () => {
        if (go.hasAttribute('data-busy')) return;
        go.setAttribute('data-busy', '');
        try {
          if (!sentTo) {
            const email = field('email').value.trim();
            if (!email) return field('email').focus();
            await api('/v1/me/email/code', { method: 'POST', token, body: { email, password: field('current')?.value || undefined } });
            sentTo = email;
            form.querySelector('[data-code]').hidden = false;
            form.querySelector('[data-say]').textContent = `${email} хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай.`;
            go.textContent = 'Баталгаажуулах';
            field('code').focus();
            return;
          }
          const code = field('code').value.replace(/\D/g, '');
          if (code.length !== 6) return field('code').focus();
          await api('/v1/me/email', { method: 'POST', token, body: { email: sentTo, code } });
          toast('Имэйл холбогдлоо.', 'good');
          await draw();
        } catch (error) {
          toast(error.message, 'bad');
        } finally {
          go.removeAttribute('data-busy');
        }
      };
      go.addEventListener('click', run);
      for (const input of form.querySelectorAll('input')) input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
      field('code').addEventListener('input', () => field('code').value.replace(/\D/g, '').length === 6 && run());
      // Another address after the code went is a new start.
      field('email').addEventListener('input', () => {
        if (sentTo && field('email').value.trim() !== sentTo) {
          sentTo = null;
          form.querySelector('[data-code]').hidden = true;
          go.textContent = 'Код авах';
        }
      });
    });

    $('[data-open="password"]').addEventListener('click', () => {
      const form = openForm(
        $('[data-row="password"]'),
        `${me.has_password ? '<label class="field"><span>Одоогийн нууц үг</span><input name="current" type="password" autocomplete="current-password"></label>' : ''}
        <label class="field"><span>Шинэ нууц үг</span><input name="next" type="password" autocomplete="new-password" placeholder="Дор хаяж 8 тэмдэгт"></label>
        <p class="cap">Бусад төхөөрөмж дээрх нэвтрэлт хаагдана, энэ хэвээр үлдэнэ.</p>
        <button class="btn" data-v="primary" type="button" data-go>Хадгалах</button>`,
      );
      const go = form.querySelector('[data-go]');
      const run = async () => {
        if (go.hasAttribute('data-busy')) return;
        const next = form.querySelector('[name="next"]').value;
        if (next.length < 8) {
          toast('Нууц үг дор хаяж 8 тэмдэгт байх ёстой.', 'bad');
          return form.querySelector('[name="next"]').focus();
        }
        go.setAttribute('data-busy', '');
        try {
          const { revoked } = await api('/v1/me/password', {
            method: 'POST',
            token,
            body: { current: form.querySelector('[name="current"]')?.value ?? '', next },
          });
          toast(revoked ? `Нууц үг хадгалагдлаа. Өөр ${revoked} төхөөрөмжөөс гаргалаа.` : 'Нууц үг хадгалагдлаа.', 'good');
          await draw();
        } catch (error) {
          toast(error.message, 'bad');
        } finally {
          go.removeAttribute('data-busy');
        }
      };
      go.addEventListener('click', run);
      for (const input of form.querySelectorAll('input')) input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
    });
  };

  box.ready = draw();
  return box;
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
