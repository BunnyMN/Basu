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
}

/* ── signing in on the web ─────────────────────────────────────────── */

/** Which doors this server has open. Asked once; a failed ask leaves the phone door alone. */
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
    store.guestToken = token;
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
 * time a code sent to it comes back. The phone and a password stay for the
 * accounts made that way, one fold down. Only the doors this server has open
 * are drawn; with neither Google nor email set up, the phone door is the
 * whole block, open.
 *
 * `onToken(token)` is called once there is a session. Google does not call
 * it: the page is left for Google's and comes back to `returnTo`, signed in,
 * by way of `authReturn` above.
 */
export function signInDoors({ device = 'Вэб', returnTo = location.pathname, onToken }) {
  const box = document.createElement('div');
  box.className = 'ways';
  box.innerHTML = `
    <a class="btn" data-size="lg" data-google hidden>${GOOGLE_MARK}<span>Google-ээр нэвтрэх</span></a>
    <div class="or" data-or hidden>эсвэл</div>
    <div data-email hidden>
      <label class="field"><span>Имэйл хаяг</span><input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="нэр@gmail.com"></label>
      <p class="cap" data-email-hint>Хаяг руу тань 6 оронтой код илгээнэ. Анх удаа бол бүртгэл шууд үүснэ.</p>
      <div data-code hidden><input name="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" aria-label="Имэйлд ирсэн код"></div>
      <button class="btn" data-v="primary" data-size="lg" type="button" data-email-go>Код авах</button>
      <div class="again" data-again-row hidden>
        <button class="link" type="button" data-resend>Код дахин авах</button>
        <button class="link" type="button" data-change>Хаяг солих</button>
      </div>
    </div>
    <details class="fold" data-phone>
      <summary>Утас, нууц үгээр нэвтрэх</summary>
      <div class="body">
        <label class="field"><span>Утасны дугаар</span><input name="phone" type="tel" inputmode="tel" placeholder="+976 XXXX XXXX" autocomplete="tel"></label>
        <label class="field"><span>Нууц үг</span><input name="password" type="password" placeholder="Дор хаяж 8 тэмдэгт" autocomplete="current-password"></label>
        <label class="field" data-again hidden><span>Нууц үгээ давтах</span><input name="again" type="password" autocomplete="new-password"></label>
        <p class="cap" data-hint>Анх удаа бол дугаар, нууц үгээ бичихэд бүртгэл үүснэ.</p>
        <button class="btn" data-size="lg" type="button" data-go>Нэвтрэх</button>
      </div>
    </details>`;
  const $ = (selector) => box.querySelector(selector);
  const done = (token) => {
    store.guestToken = token;
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
    hint.textContent = 'Хаяг руу тань 6 оронтой код илгээнэ. Анх удаа бол бүртгэл шууд үүснэ.';
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

  /* the phone and a password */
  const phone = $('[name="phone"]');
  const password = $('[name="password"]');
  const again = $('[name="again"]');
  const go = $('[data-go]');
  let registering = false;

  const passwordDoor = async () => {
    const number = phone.value.replace(/\s+/g, '');
    go.setAttribute('data-busy', '');
    try {
      if (registering) {
        if (again.value !== password.value) {
          toast('Хоёр нууц үг таарахгүй байна.', 'bad');
          return;
        }
        const { token } = await api('/v1/auth/register', { method: 'POST', body: { phone: number, password: password.value, device } });
        return done(token);
      }
      const { token } = await api('/v1/auth/login', { method: 'POST', body: { phone: number, password: password.value, device } });
      done(token);
    } catch (error) {
      // A number nobody has claimed: the same fold becomes the sign-up.
      if (error.code === 'BAD_CREDENTIALS' && !registering && password.value.length >= 8) {
        registering = true;
        $('[data-again]').hidden = false;
        $('[data-hint]').textContent = 'Энэ дугаар шинэ байна. Нууц үгээ давтаад бүртгүүлнэ үү. Бүртгэлтэй бол нууц үгээ шалгана уу.';
        go.textContent = 'Бүртгүүлэх';
        again.focus();
        return;
      }
      toast(error.message, 'bad');
    } finally {
      go.removeAttribute('data-busy');
    }
  };
  go.addEventListener('click', passwordDoor);
  for (const input of [phone, password, again]) input.addEventListener('keydown', (e) => e.key === 'Enter' && passwordDoor());

  /* only the doors that are open */
  box.ready = authMethods().then((open) => {
    // Google will not sign anybody in inside an app's web view; the app has its own sheet.
    const googleOpen = Boolean(open.google) && !shell.present;
    google.hidden = !googleOpen;
    $('[data-email]').hidden = !open.email;
    $('[data-or]').hidden = !(googleOpen && open.email);
    const phoneAlone = !googleOpen && !open.email;
    const fold = $('[data-phone]');
    fold.open = phoneAlone;
    fold.toggleAttribute('data-alone', phoneAlone);
    (open.email ? email : phoneAlone ? phone : google).focus?.();
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
