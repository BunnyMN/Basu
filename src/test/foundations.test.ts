import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The shared building blocks, on their own: a popup says what is missing
 * under the field it is about and holds still while it works, a toast that
 * comes while another shows puts the other one up a step, an empty list says
 * what the place is for, and the desk frame says whose session it is. What a
 * page test would only find out by accident is held here.
 */

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

type Win = JSDOM['window'] & Record<string, any>;
let window: Win;
let document: Document;

beforeEach(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  window = dom.window as Win;
  document = window.document;
  window.eval(await readFile(join(WEB, 'vendor', 'table-core.js'), 'utf8'));
  const strip = (source: string) => source.replace(/\bexport\s+/g, '');
  const api = strip(await readFile(join(WEB, 'api.js'), 'utf8'));
  const nav = strip(await readFile(join(WEB, 'sidenav.js'), 'utf8'));
  const tables = strip(await readFile(join(WEB, 'datatable.js'), 'utf8'));
  window.eval(
    `${api}\n${nav}\n${tables}\nObject.assign(window, { popup, confirmPopup, toast, emptyState, skeleton, fieldError, setBusy, phoneText, phoneInput, moneyInput, moneyValue, deskFrame, dataTable, dtCell, ubParts, HEADLINE, headlineWord, IDESH_HEADLINE, IDESH_STATE, IDESH_LIVE });`,
  );
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const open = () => document.querySelector('.sheet.popup[data-open]') as HTMLElement;
const field = (name: string) => open().querySelector(`[name="${name}"]`) as HTMLInputElement;
const errorUnder = (name: string) => field(name).closest('.field')?.querySelector('.help[data-error]')?.textContent ?? null;

describe('a popup', () => {
  it('says what is missing under each field that must be filled, before anything is sent, and takes it back as the field is typed in', async () => {
    let sent = 0;
    void window.popup({
      title: 'Нийлүүлэгч бүртгэх',
      fields: [
        { name: 'name', label: 'Нэр', required: true, hint: 'Гэрээн дээрх нэр' },
        { name: 'bank', label: 'Банк', type: 'select', required: true, options: [['', '—'], ['khan', 'Хаан банк']] },
        { name: 'note', label: 'Тэмдэглэл' },
      ],
      onSubmit: () => {
        sent += 1;
        return true;
      },
    });
    (open().querySelector('[data-submit]') as HTMLElement).click();
    await tick();
    expect(sent).toBe(0);
    expect(errorUnder('name')).toBe('Бөглөнө үү.');
    expect(errorUnder('bank')).toBe('Сонгоно уу.');
    expect(errorUnder('note')).toBeNull();
    expect(field('name').getAttribute('aria-invalid')).toBe('true');
    // the hint steps aside while the error stands, and the field names the error for a reader
    const hint = field('name').closest('.field')!.querySelector('.help:not([data-error])') as HTMLElement;
    expect(hint.hidden).toBe(true);
    expect(field('name').getAttribute('aria-describedby')).toBe(field('name').closest('.field')!.querySelector('.help[data-error]')!.id);
    expect(document.activeElement).toBe(field('name'));
    expect((open().querySelector('.popup-error') as HTMLElement).hidden).toBe(true);

    field('name').value = 'Баянговь';
    field('name').dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(errorUnder('name')).toBeNull();
    expect(field('name').hasAttribute('aria-invalid')).toBe(false);
    expect(hint.hidden).toBe(false);
  });

  it('holds still while its answer is on the way, and says the server’s word over the fields — or under the field it names', async () => {
    let finish: (value?: unknown) => void = () => {};
    let round = 0;
    void window.popup({
      title: 'Утас солих',
      fields: [{ name: 'phone', label: 'Утас', type: 'tel', prefix: '+976' }],
      onSubmit: () => {
        round += 1;
        if (round === 1) return new Promise((resolve) => (finish = resolve)).then(() => Promise.reject(new Error('Сервер хариулсангүй.')));
        throw Object.assign(new Error('Энэ дугаар өөр бүртгэлд байна.'), { field: 'phone' });
      },
    });
    // a phone field types on the phone's keypad and wears its +976 in front
    expect(field('phone').getAttribute('inputmode')).toBe('tel');
    expect(field('phone').closest('.affix')?.querySelector('i[data-start]')?.textContent).toBe('+976');

    const go = open().querySelector('[data-submit]') as HTMLElement;
    go.click();
    await tick();
    expect(go.hasAttribute('data-busy')).toBe(true);
    expect(go.getAttribute('aria-busy')).toBe('true');
    expect(open().hasAttribute('data-busy')).toBe(true);
    finish();
    await tick(5);
    expect(go.hasAttribute('data-busy')).toBe(false);
    expect(open().hasAttribute('data-busy')).toBe(false);
    const said = open().querySelector('.popup-error') as HTMLElement;
    expect(said.hidden).toBe(false);
    expect(said.textContent).toBe('Сервер хариулсангүй.');
    expect(said.getAttribute('data-k')).toBe('stop');

    go.click();
    await tick(5);
    expect(errorUnder('phone')).toBe('Энэ дугаар өөр бүртгэлд байна.');
    expect(said.hidden).toBe(true);
  });

  it('counts its steps over the title, and fills its button red when the step cannot be undone', async () => {
    void window.popup({
      title: 'Гишүүн нэмэх',
      steps: 2,
      fields: [{ name: 'contact', label: 'Утас эсвэл имэйл' }],
      submit: 'Хайх',
      onSubmit: (_v: unknown, p: { step: (next: Record<string, unknown>) => void }) => {
        p.step({ fields: [{ name: 'role', label: 'Үүрэг', type: 'select', options: [['ops', 'Ops']] }], submit: 'Нэмэх' });
        return false;
      },
    });
    expect(open().querySelector('.popup-steps')?.textContent).toBe('Алхам 1/2');
    expect(open().querySelector('header h2')?.textContent).toBe('Гишүүн нэмэх');
    (open().querySelector('[data-submit]') as HTMLElement).click();
    await tick(5);
    expect(open().querySelector('.popup-steps')?.textContent).toBe('Алхам 2/2');
    expect(open().querySelectorAll('.popup-steps b[data-on]')).toHaveLength(2);
    (open().querySelector('[data-cancel]') as HTMLElement).click();
    await tick(300);

    void window.confirmPopup({ title: 'Захиалгыг цуцлах', text: 'Буцаах боломжгүй.', ok: 'Цуцлах', danger: true });
    const go = open().querySelector('[data-submit]') as HTMLElement;
    expect(go.getAttribute('data-v')).toBe('danger');
    expect(go.hasAttribute('data-fill')).toBe(true);
  });
});

describe('a toast', () => {
  it('keeps the newest words in #toast, puts the one before it up a step, and keeps three at most — trouble the longest', () => {
    window.toast('Холболт тасарлаа.', 'bad');
    const newest = document.getElementById('toast')!;
    expect(newest.textContent).toBe('Холболт тасарлаа.');
    expect(newest.getAttribute('role')).toBe('status');
    expect(newest.dataset.kind).toBe('bad');
    window.toast('Хадгалагдлаа.', 'good');
    window.toast('Шинэ захиалга ирлээ.', 'info');
    window.toast('Дахиад нэг.');
    expect(document.getElementById('toast')!.textContent).toBe('Дахиад нэг.');
    expect(document.getElementById('toast')!.dataset.kind).toBeUndefined();
    // three at most: the oldest calm word went, not the older trouble; the copies stay in the order they came
    const older = [...document.querySelectorAll('.toast-old[data-show]')];
    expect(older.map((t) => t.textContent)).toEqual(['Холболт тасарлаа.', 'Шинэ захиалга ирлээ.']);
    expect(older.every((t) => t.getAttribute('aria-hidden') === 'true' && !t.id && !t.getAttribute('role'))).toBe(true);
  });
});

describe('an empty place', () => {
  it('says what it is for, in text, with one next step', () => {
    let pressed = 0;
    const box = window.emptyState({
      icon: 'orders',
      title: '<b>Захиалга</b> алга',
      text: 'Зочин захиалга өгмөгц энд гарна.',
      action: { label: 'Зар нэмэх', primary: true, onClick: () => (pressed += 1) },
      size: 'sm',
      frame: true,
    }) as HTMLElement;
    expect(box.className).toBe('empty-state');
    expect(box.querySelector('.es-mark svg')).not.toBeNull();
    expect(box.querySelector('.es-title')?.textContent).toBe('<b>Захиалга</b> алга');
    expect(box.querySelector('.es-title b')).toBeNull();
    expect(box.hasAttribute('data-frame')).toBe(true);
    const button = box.querySelector('.es-act .btn') as HTMLElement;
    expect(button.dataset.v).toBe('primary');
    expect(button.dataset.size).toBe('sm');
    button.click();
    expect(pressed).toBe(1);
  });

  it('fills a whole screen with its next steps stacked, keeping the page’s own hooks on them', () => {
    const box = window.emptyState({
      icon: 'offline',
      size: 'lg',
      title: 'Basu-д холбогдож чадсангүй',
      actions: [
        { label: 'Дахин оролдох', primary: true, attrs: { 'data-retry': '' } },
        { label: 'Нүүр рүү буцах', quiet: true, attrs: { 'data-home': '' } },
      ],
    }) as HTMLElement;
    expect(box.dataset.size).toBe('lg');
    const [retry, home] = [...box.querySelectorAll('.es-act .btn')] as HTMLElement[];
    expect(retry?.hasAttribute('data-retry')).toBe(true);
    expect(retry?.dataset.v).toBe('primary');
    expect(home?.hasAttribute('data-home')).toBe(true);
    expect(home?.dataset.v).toBe('quiet');
    expect(home?.dataset.size).toBe('lg');
  });

  it('has the shape of what is coming while it loads', () => {
    const rows = window.skeleton('rows', 3) as HTMLElement;
    expect(rows.getAttribute('aria-busy')).toBe('true');
    expect(rows.querySelectorAll('.skel-row')).toHaveLength(3);
    // a KPI skeleton is never counted as a KPI
    expect((window.skeleton('kpis', 6) as HTMLElement).querySelectorAll('.kpi')).toHaveLength(0);
  });
});

describe('a field and a number', () => {
  it('says what is wrong under the field and takes it back', () => {
    document.body.innerHTML = '<label class="field"><span>Имэйл</span><input name="email" aria-describedby="h"><small class="help" id="h">Код энэ хаяг руу очно</small></label>';
    const input = document.querySelector('input') as HTMLInputElement;
    window.fieldError(input, 'Имэйл хаягаа шалгана уу.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('.help[data-error]')?.textContent).toBe('Имэйл хаягаа шалгана уу.');
    expect((document.getElementById('h') as HTMLElement).hidden).toBe(true);
    window.fieldError(input, null);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(document.querySelector('.help[data-error]')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe('h');
    expect((document.getElementById('h') as HTMLElement).hidden).toBe(false);
  });

  it('reads a Mongolian number the way people read it, and groups one as it is typed', () => {
    expect(window.phoneText('+97699112233')).toBe('+976 9911 2233');
    expect(window.phoneText('99112233')).toBe('+976 9911 2233');
    expect(window.phoneText('nobody@example.mn')).toBe('nobody@example.mn');

    document.body.innerHTML = '<input type="tel">';
    const input = window.phoneInput(document.querySelector('input')) as HTMLInputElement;
    const cases: Array<[string, string]> = [
      ['99112', '9911 2'],
      ['99112233', '9911 2233'],
      ['+976 9911-2233', '9911 2233'],
      ['991122334455', '9911 2233'],
    ];
    for (const [typed, shown] of cases) {
      input.value = typed;
      input.dispatchEvent(new window.Event('input'));
      expect(input.value).toBe(shown);
    }
  });

  it('leaves the keyboard down on open when asked to (focus: sheet), and gives the first field the focus by default', async () => {
    void window.popup({ title: 'Нэр засах', focus: 'sheet', fields: [{ name: 'name', label: 'Нэр' }] });
    expect(document.activeElement).toBe(open());
    (open().querySelector('[data-cancel]') as HTMLElement).click();
    await tick(300);
    void window.popup({ title: 'Нэр засах', fields: [{ name: 'name', label: 'Нэр' }] });
    expect(document.activeElement).toBe(field('name'));
    (open().querySelector('[data-cancel]') as HTMLElement).click();
    await tick(300);
    // on a touch screen the default is the popup itself: the phone's keyboard waits for a tap on a field
    window.matchMedia = ((query: string) => ({ matches: query.includes('coarse'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    void window.popup({ title: 'Нэр засах', fields: [{ name: 'name', label: 'Нэр' }] });
    expect(document.activeElement).toBe(open());
  });

  it('groups a popup’s phone field the same way', () => {
    void window.popup({ title: 'Утас', fields: [{ name: 'phone', label: 'Утас', type: 'tel', prefix: '+976', format: 'phone' }] });
    field('phone').value = '88010011';
    field('phone').dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(field('phone').value).toBe('8801 0011');
  });

  it('groups money in thousands as it is typed, and reads it back as a number', () => {
    expect(window.moneyValue('1,250,000')).toBe(1250000);
    expect(window.moneyValue('1 250 000₮')).toBe(1250000);
    expect(window.moneyValue('0')).toBe(0);
    expect(window.moneyValue('')).toBeNaN();
    expect(window.moneyValue('38.5')).toBeNaN();

    document.body.innerHTML = '<input inputmode="numeric">';
    const input = window.moneyInput(document.querySelector('input')) as HTMLInputElement;
    const cases: Array<[string, string]> = [
      ['4600', '4,600'],
      ['460000', '460,000'],
      ['1250000', '1,250,000'],
      ['460 000₮', '460,000'],
      ['007', '7'],
      ['0', '0'],
      ['', ''],
    ];
    for (const [typed, shown] of cases) {
      input.value = typed;
      input.dispatchEvent(new window.Event('input'));
      expect(input.value).toBe(shown);
    }
  });

  it('hands its answer a money field’s digits, ₮ beside it, so a page reading a number reads one', async () => {
    let got: Record<string, unknown> | null = null;
    void window.popup({
      title: 'Үнэ',
      fields: [{ name: 'price_mnt', label: 'Үнэ', format: 'money', value: '460000', required: true }],
      onSubmit: (values: Record<string, unknown>) => {
        got = values;
        return true;
      },
    });
    expect(field('price_mnt').value).toBe('460,000');
    expect(field('price_mnt').getAttribute('inputmode')).toBe('numeric');
    expect(field('price_mnt').closest('.affix')?.querySelector('i')?.textContent).toBe('₮');
    field('price_mnt').value = '1250000';
    field('price_mnt').dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(field('price_mnt').value).toBe('1,250,000');
    (open().querySelector('[data-submit]') as HTMLElement).click();
    await tick();
    expect(got).toEqual({ price_mnt: '1250000' });
  });

  it('heads a group of fields with a section that sends nothing', async () => {
    let got: Record<string, unknown> | null = null;
    void window.popup({
      title: 'Нийлүүлэгч бүртгэх',
      fields: [
        { name: 'name', label: 'Нэр' },
        { type: 'section', label: 'Олголт очих данс', text: 'Хүлээлгэн өгсөн захиалга бүрийн мөнгө энд очно.' },
        { name: 'bank_account', label: 'Дансны дугаар' },
      ],
      onSubmit: (values: Record<string, unknown>) => {
        got = values;
        return true;
      },
    });
    const section = open().querySelector('.fields > .popup-section') as HTMLElement;
    expect(section.hasAttribute('data-wide')).toBe(true);
    expect(section.querySelector('h3')?.textContent).toBe('Олголт очих данс');
    expect(section.querySelector('p')?.textContent).toBe('Хүлээлгэн өгсөн захиалга бүрийн мөнгө энд очно.');
    (open().querySelector('[data-submit]') as HTMLElement).click();
    await tick();
    expect(got).toEqual({ name: '', bank_account: '' });
  });

  it('lets a field follow another: onChange on drawing and on every change, a field shown only when it applies, a hint that follows', async () => {
    const heard: unknown[] = [];
    let got: Record<string, unknown> | null = null;
    void window.popup({
      title: 'Буцаалт авах данс',
      fields: [
        {
          name: 'bank',
          label: 'Банк',
          type: 'select',
          options: [['', '—'], ['khan', 'Хаан банк'], ['other', 'Бусад банк']],
          onChange: (bank: string, form: { show: (name: string, on: boolean) => void; hint: (name: string, text: string) => void }) => {
            heard.push(bank);
            form.show('other', bank === 'other');
            form.hint('bank', bank ? '' : 'Мөнгө орох банкаа сонгоно уу.');
          },
        },
        { name: 'other', label: 'Банкны нэр', required: true },
      ],
      onSubmit: (values: Record<string, unknown>) => {
        got = values;
        return true;
      },
    });
    // Drawn: heard once, the bank's name put away, the hint said.
    expect(heard).toEqual(['']);
    expect((field('other').closest('.field') as HTMLElement).hidden).toBe(true);
    expect(field('other').disabled).toBe(true);
    expect(field('bank').closest('.field')?.querySelector('.help')?.textContent).toBe('Мөнгө орох банкаа сонгоно уу.');

    const bank = field('bank') as unknown as HTMLSelectElement;
    bank.value = 'other';
    bank.dispatchEvent(new window.Event('input', { bubbles: true }));
    bank.dispatchEvent(new window.Event('change', { bubbles: true }));
    // A select is heard once per move, not once per event.
    expect(heard).toEqual(['', 'other']);
    expect((field('other').closest('.field') as HTMLElement).hidden).toBe(false);
    expect(field('bank').closest('.field')?.querySelector('.help')).toBeNull();

    // Shown, it is required again; put away, it is neither required nor sent.
    (open().querySelector('[data-submit]') as HTMLElement).click();
    await tick();
    expect(errorUnder('other')).toBe('Бөглөнө үү.');
    bank.value = 'khan';
    bank.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(errorUnder('other')).toBeNull();
    (open().querySelector('[data-submit]') as HTMLElement).click();
    await tick();
    expect(got).toEqual({ bank: 'khan' });
  });
});

describe('a lunch state’s word', () => {
  it('is said for the states the headline names by a time, which dine keeps showing as a time', () => {
    expect(window.headlineWord('SCHEDULED')).toBe('Хүлээн авсан');
    expect(window.headlineWord('ARMED')).toBe('Хөдлөх цаг');
    expect(window.headlineWord('COOKING')).toBe('Гал дээр');
    expect(window.headlineWord('RESLOTTED')).toBe('Цаг шилжсэн');
    expect(window.headlineWord('READY')).toBe(window.HEADLINE.READY[0]);
    expect(window.headlineWord('NOT_A_STATE')).toBe('');
    // dine reads a missing headline as «say the time»: these stay out of HEADLINE
    expect(window.HEADLINE.SCHEDULED).toBeUndefined();
  });

  it('names a state on a chip where the headline is a sentence', () => {
    expect(window.headlineWord('CANCELLED')).toBe('Цуцлагдсан');
    expect(window.HEADLINE.CANCELLED[0]).toBe('Цуцлагдлаа');
    expect(window.headlineWord('SERVED')).toBe('Үйлчилсэн');
  });
});

describe('an идэш’s state', () => {
  it('has one word on every page — the chip’s — beside the status page’s sentence', () => {
    expect(window.IDESH_STATE.HANDED).toBe('Хүлээлгэн өгсөн');
    expect(window.IDESH_STATE.CANCELLED).toBe('Цуцлагдсан');
    expect(window.IDESH_HEADLINE.CANCELLED[0]).toBe('Цуцлагдлаа');
    // Every state the headline knows has a word of its own.
    for (const state of Object.keys(window.IDESH_HEADLINE)) expect(window.IDESH_STATE[state]).toBeTruthy();
    // «Идэвхтэй» is paid and not yet handed over, everywhere.
    expect(window.IDESH_LIVE).toEqual(['PAID', 'PREPARING', 'READY', 'DISPATCHED']);
  });
});

describe('Ulaanbaatar’s day and clock', () => {
  it('reads a moment as Ulaanbaatar does, whatever zone the computer is set to — in a sentence and in a table’s cell', () => {
    const was = process.env['TZ'];
    // A computer set to UTC, where 22:30 on 1 October is 06:30 on the 2nd here.
    process.env['TZ'] = 'UTC';
    try {
      expect({ ...window.ubParts('2026-10-01T22:30:00Z') }).toEqual({ day: '2026-10-02', clock: '06:30' });
      // Midnight here is 00:00, never «24:00».
      expect({ ...window.ubParts('2026-10-01T16:00:00Z') }).toEqual({ day: '2026-10-02', clock: '00:00' });
      expect(window.dtCell.when('2026-10-01T22:30:00Z')).toBe('<span class="dt-when">10-р сарын 2<small>06:30</small></span>');
      expect(window.dtCell.when(null)).toBe('<span class="dt-none">—</span>');
    } finally {
      if (was === undefined) delete process.env['TZ'];
      else process.env['TZ'] = was;
    }
  });
});

describe('the desk', () => {
  const access = {
    workspaces: [{ id: 'desk', kind: 'desk', name: 'Basu', sub: 'Ширээ · Админ' }],
    current: { id: 'desk', kind: 'desk', name: 'Basu', sub: 'Ширээ · Админ', menu: [{ key: 'top', label: '', items: [{ key: 'overview', label: 'Самбар', icon: 'overview' }] }] },
  };
  const frame = (account: unknown) =>
    window.deskFrame({ ...access, account, onPage: () => {}, onWorkspace: () => {}, onSignOut: () => {} }) as { root: HTMLElement };

  it('says whose session it is at the foot and at the end of the phone’s bar', () => {
    const named = frame({ name: 'Ганхүлэг', email: 'basuappmn@gmail.com' }).root;
    expect(named.querySelector('.acct .who b')?.textContent).toBe('Ганхүлэг');
    expect(named.querySelector('.acct .who small')?.textContent).toBe('basuappmn@gmail.com');
    expect(named.querySelector('.deskbar-me')?.getAttribute('aria-label')).toBe('Нэвтэрсэн: Ганхүлэг · basuappmn@gmail.com');

    expect(named.querySelector('.acct .av')?.textContent).toBe('Г');
    // the business's desk, by its own word under the wordmark
    expect(named.querySelector('.brand-home span')?.textContent).toBe('Бизнес');

    // with no name, the number or the address is who it is: the whole second line, never cut short,
    // under a quiet «Нэвтэрсэн», and a person for the mark — not two letters of an address
    const byPhone = frame({ phone: '+97688010001' }).root;
    expect(byPhone.querySelector('.acct .who b')?.textContent).toBe('Нэвтэрсэн');
    expect(byPhone.querySelector('.acct .who b')?.hasAttribute('data-quiet')).toBe(true);
    const number = byPhone.querySelector('.acct .who small');
    expect(number?.textContent).toBe('+976 8801 0001');
    expect(number?.hasAttribute('data-mono')).toBe(true);
    expect(number?.hasAttribute('data-whole')).toBe(true);
    const byMail = frame({ email: 'basuappmn@gmail.com' }).root;
    expect(byMail.querySelector('.acct .who small')?.textContent).toBe('basuappmn@gmail.com');
    expect(byMail.querySelector('.acct .who small')?.hasAttribute('data-whole')).toBe(true);
    // wrapped, the address goes to its next line before its «@», as the desk's tables break one — never mid-word
    expect(byMail.querySelector('.acct .who small')?.innerHTML).toBe('basuappmn<wbr>@gmail.com');
    expect(number?.innerHTML).toBe('+976 8801 0001');
    expect(byMail.querySelector('.acct .av svg')).not.toBeNull();
    expect(byMail.querySelector('.deskbar-me svg')).not.toBeNull();
    expect(byMail.querySelector('.deskbar-me')?.getAttribute('aria-label')).toBe('Нэвтэрсэн: basuappmn@gmail.com');
  });

  it('marks the person’s own corner with a person while it is called by their number or address — never «+9»', () => {
    const corner = (name: string) => ({ id: 'me', kind: 'me', name, sub: 'Миний бүртгэл', menu: access.current.menu });
    const own = (name: string, account: unknown) =>
      (window.deskFrame({ workspaces: [corner(name), access.workspaces[0]], current: corner(name), account, onPage: () => {}, onWorkspace: () => {}, onSignOut: () => {} }) as { root: HTMLElement })
        .root;
    for (const [name, account] of [
      ['+976 8801 0001', { phone: '+97688010001' }],
      ['basuappmn@gmail.com', { email: 'basuappmn@gmail.com' }],
    ] as const) {
      const root = own(name, account);
      // the switcher's button and its line in the menu alike
      const marks = root.querySelectorAll('.ws-btn .ws-mark, .ws-opt[data-ws="me"] .ws-mark');
      expect(marks, name).toHaveLength(2);
      for (const mark of marks) {
        expect(mark.querySelector('svg'), name).not.toBeNull();
        expect(mark.textContent, name).toBe('');
      }
    }
    // A name of their own: its first letter, as at the foot. The desk keeps its «B».
    const named = own('Ганхүлэг', { name: 'Ганхүлэг', phone: '+97688010001' });
    expect(named.querySelector('.ws-btn .ws-mark')?.textContent).toBe('Г');
    expect(named.querySelector('.ws-opt[data-ws="desk"] .ws-mark')?.textContent).toBe('B');
  });

  it('keeps a server-side filter on an empty list — another choice may hold rows', () => {
    const t = window.dataTable({
      columns: [{ key: 'name', label: 'Нэр' }],
      filters: [{ key: 'scope', label: 'Хүрээ', options: [['live', 'Идэвхтэй'], ['all', 'Бүгд']] }],
      onFilter: () => {},
    });
    t.setRows([]);
    expect(t.el.hasAttribute('data-empty')).toBe(true);
    expect(t.el.hasAttribute('data-bare')).toBe(false);
  });

  it('shows an empty list as the empty block without a header row, and offers to clear a search that found nothing', () => {
    const t = window.dataTable({ columns: [{ key: 'name', label: 'Нэр' }], empty: { title: 'Хүн алга', text: 'Хүн нэмэхэд энд гарна.' } });
    document.body.append(t.el);
    t.setRows([]);
    expect(t.el.hasAttribute('data-empty')).toBe(true);
    expect(t.el.querySelector('.dt-empty .es-title')?.textContent).toBe('Хүн алга');

    // nothing the server holds could be filtered in: no search box over nothing
    expect(t.el.hasAttribute('data-bare')).toBe(true);
    t.setRows([{ name: 'Бат' }, { name: 'Сараа' }]);
    expect(t.el.hasAttribute('data-empty')).toBe(false);
    expect(t.el.hasAttribute('data-bare')).toBe(false);
    const search = t.el.querySelector('.dt-search input') as HTMLInputElement;
    search.value = 'байхгүй';
    search.dispatchEvent(new window.Event('input'));
    expect(t.el.hasAttribute('data-empty')).toBe(false);
    (t.el.querySelector('.dt-empty .es-act .btn') as HTMLElement).click();
    expect(search.value).toBe('');
    expect(t.el.querySelectorAll('tbody tr.dt-row')).toHaveLength(2);
  });

  it('offers to take back a search the server answered with nothing, and filters that left nothing', async () => {
    const asked: string[] = [];
    const t = window.dataTable({ columns: [{ key: 'name', label: 'Нэр' }], onSearch: (q: string) => asked.push(q), empty: { title: 'Хүн алга', text: '' } });
    document.body.append(t.el);
    t.setRows([{ name: 'Бат' }]);
    const search = t.el.querySelector('.dt-search input') as HTMLInputElement;
    search.value = 'байхгүй';
    search.dispatchEvent(new window.Event('input'));
    t.setRows([]); // the server's answer
    expect(t.el.hasAttribute('data-empty')).toBe(false);
    expect(t.el.querySelector('.dt-empty .es-title')?.textContent).toBe('Олдсонгүй');
    (t.el.querySelector('.dt-empty [data-clear="search"]') as HTMLElement).click();
    expect(search.value).toBe('');
    await tick(300);
    expect(asked).toEqual(['']);

    const fetched: Array<Record<string, string>> = [];
    const f = window.dataTable({
      columns: [{ key: 'name', label: 'Нэр' }],
      filters: [
        { key: 'open', label: 'Төлөв', options: [['all', 'Бүгд'], ['open', 'Нээлттэй']], test: (r: { open?: boolean }, v: string) => v === 'all' || Boolean(r.open) },
        { key: 'scope', label: 'Хүрээ', kind: 'select', options: [['live', 'Идэвхтэй'], ['all', 'Бүгд']] },
      ],
      onFilter: (v: Record<string, string>) => fetched.push(v),
    });
    document.body.append(f.el);
    f.setRows([{ name: 'Бат' }]);
    ([...f.el.querySelectorAll('.dt-seg button')].find((b) => b.textContent === 'Нээлттэй') as HTMLElement).click();
    const scope = f.el.querySelector('.dt-select') as HTMLSelectElement;
    scope.value = 'all';
    scope.dispatchEvent(new window.Event('change'));
    expect(f.el.querySelector('.dt-empty .es-title')?.textContent).toBe('Олдсонгүй');
    expect(f.el.querySelector('.dt-empty [data-clear="search"]')).toBeNull();
    (f.el.querySelector('.dt-empty [data-clear="filters"]') as HTMLElement).click();
    // every filter back to its first choice, the server asked once for its own
    expect(fetched).toEqual([{ open: 'open', scope: 'all' }, { open: 'all', scope: 'live' }]);
    expect(f.el.querySelector('.dt-seg button[data-on]')?.textContent).toBe('Бүгд');
    expect(scope.value).toBe('live');
    expect(f.el.querySelectorAll('tbody tr.dt-row')).toHaveLength(1);
  });
});
