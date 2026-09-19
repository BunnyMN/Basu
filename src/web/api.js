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
