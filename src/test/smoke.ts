import '../env.js';

/**
 * The whole product, over HTTP, against a running server.
 *
 * The unit tests prove the arithmetic, the simulator proves it survives a rush,
 * and the lifecycle test proves the pieces are wired together. This one proves
 * the thing you can actually open in a browser works — same routes, same
 * tokens, same order of operations a phone and a tablet perform.
 *
 *   npm run api        # in one terminal
 *   npm run smoke      # in another
 */

const BASE = process.env['SMOKE_BASE'] ?? 'http://localhost:3000';

/**
 * A key of this run's own. Reusing one across runs would test that yesterday's
 * answer is still cached, which is not the property anybody wants — a retry is
 * a retry of *this* attempt.
 */
const RUN = `smoke-${Date.now().toString(36)}`;

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  checks++;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
  }
}

async function call<T = any>(
  path: string,
  init: { method?: string; body?: unknown; token?: string; key?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (init.body) headers['content-type'] = 'application/json';
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;
  if (init.key) headers['idempotency-key'] = init.key;

  const response = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    // Spread rather than `body: undefined` — exactOptionalPropertyTypes draws
    // a distinction between an absent property and one holding undefined.
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  // Not everything here is JSON — the dish drawings are SVG.
  const json = response.headers.get('content-type')?.includes('json') ?? false;
  return {
    status: response.status,
    body: (json && text ? JSON.parse(text) : text) as T,
  };
}

const clockTo = (label: string) => call('/dev/clock', { method: 'POST', body: { to: label } });
const tick = () => call('/dev/tick', { method: 'POST' });

async function main(): Promise<void> {
  console.log(`\nBasu smoke — ${BASE}\n`);

  const health = await call('/health');
  if (health.status !== 200) {
    console.error(`Сервер хариулахгүй байна. "npm run api" ажиллуулсан уу?\n`);
    process.exit(1);
  }

  /* ── setup ─────────────────────────────────────────────────────── */
  console.log('Бэлтгэл');
  await clockTo('11:40');

  const login = await call<{ token: string }>('/dev/login', { method: 'POST', body: {} });
  check('зочин нэвтэрлээ', login.status === 200 && Boolean(login.body.token));
  const guest = login.body.token;

  const codes = await call<{ devices: Array<{ code: string; name: string; restaurant_id: string }> }>(
    '/dev/pairing-codes',
  );
  const device0 = codes.body.devices[0];
  check('холбох код бэлэн', Boolean(device0), codes.body);
  if (!device0) return;

  const paired = await call<{ token: string }>('/v1/kds/pair', {
    method: 'POST',
    body: { pairing_code: device0.code },
  });
  check('таблет холбогдлоо', paired.status === 200, paired.body);
  const tablet = paired.body.token;

  // The seed already opens one venue for service. Take a tablet for it too, so
  // the isolation checks at the end have a second kitchen to be excluded from —
  // and so they do not depend on a pairing code surviving the clock jumps below.
  const venues = await call<{ venues: Array<{ id: string; name: string; watched: boolean }> }>(
    '/dev/venues',
  );
  const seeded = venues.body.venues.find((v) => v.watched && v.id !== device0.restaurant_id);
  const rivalPaired = seeded
    ? await call<{ token: string }>('/dev/kds-token', {
        method: 'POST',
        body: { restaurant_id: seeded.id },
      })
    : null;
  check('хоёр дахь таблет холбогдлоо', rivalPaired?.status === 200, rivalPaired?.body);

  /* ── browsing ──────────────────────────────────────────────────── */
  console.log('\nЗочин цэс үзэв');
  const listed = await call<{ restaurants: Array<{ id: string; name: string; accepting_orders: boolean }> }>(
    '/v1/restaurants',
  );
  const open = listed.body.restaurants.filter((r) => r.accepting_orders);
  check(
    `${listed.body.restaurants.length} ресторан, ${open.length} нь захиалга авна`,
    listed.body.restaurants.length >= 3 && open.length > 0,
  );
  // Prefer the venue whose tablet we hold, so the kitchen checks below have a
  // board to look at; anything open will do if that one is not taking orders.
  const venue = open.find((r) => r.id === device0.restaurant_id) ?? open[0]!;

  const menu = await call<{
    items: Array<{
      id: string;
      name: string;
      price_mnt: number;
      image_url: string | null;
      prep_minutes: number;
    }>;
  }>(`/v1/restaurants/${venue.id}/menu`);
  // Whatever this kitchen actually cooks — naming a dish here would only test
  // that the seed still spells it the same way.
  const dish = menu.body.items[0];
  check(`${venue.name}: ${menu.body.items.length} хоолтой цэс`, Boolean(dish), menu.body);
  if (!dish) return;

  check(
    'хоол бүр зурагтай',
    menu.body.items.every((i) => Boolean(i.image_url)),
    menu.body.items.filter((i) => !i.image_url).map((i) => i.name),
  );
  const picture = await call<string>(String(dish.image_url));
  check(
    `зураг ирлээ (${dish.image_url})`,
    picture.status === 200 && picture.body.startsWith('<svg'),
  );

  const slots = await call<{ slots: Array<{ label: string; starts_at: string; available: boolean }> }>(
    `/v1/restaurants/${venue.id}/slots`,
  );
  const slot = slots.body.slots.find((s) => s.label === '12:30');
  check('12:30 цаг сул байна', Boolean(slot?.available), slots.body);
  if (!slot) return;

  /* ── ordering ──────────────────────────────────────────────────── */
  console.log('\nЗахиалга');
  const created = await call<{ id: string; code: string; total_mnt: number }>('/v1/orders', {
    method: 'POST',
    token: guest,
    key: RUN,
    body: {
      restaurant_id: venue.id,
      slot_starts_at: slot.starts_at,
      party_size: 2,
      items: [{ menu_item_id: dish.id, qty: 2 }],
    },
  });
  check(`№${created.body.code} үүслээ (${dish.name} ×2)`, created.status === 201, created.body);
  const orderId = created.body.id;

  const retry = await call<{ id: string }>('/v1/orders', {
    method: 'POST',
    token: guest,
    key: RUN,
    body: {
      restaurant_id: venue.id,
      slot_starts_at: slot.starts_at,
      party_size: 2,
      items: [{ menu_item_id: dish.id, qty: 2 }],
    },
  });
  check(
    'давхар дарахад нэг л захиалга',
    Boolean(orderId) && retry.body.id === orderId,
    { first: orderId, retry: retry.body.id },
  );

  const paid = await call<{ state: string }>(`/v1/orders/${orderId}/pay`, {
    method: 'POST',
    token: guest,
  });
  check('төлбөр хийгдлээ', paid.body.state === 'PLACED', paid.body);

  /* ── the kitchen sees it ───────────────────────────────────────── */
  console.log('\nГал тогоо');
  const board1 = await call<{ lanes: { incoming: Array<{ code: string; state: string }> } }>(
    '/v1/kds/tickets',
    { token: tablet },
  );
  check('тасалбар дэлгэц дээр гарлаа', board1.body.lanes.incoming.length === 1, board1.body);

  const accepted = await call(`/v1/kds/tickets/${orderId}/accept`, {
    method: 'POST',
    token: tablet,
    body: {},
  });
  check('ресторан хүлээн авлаа', accepted.status === 200, accepted.body);

  const planned = await call<{ state: string; fire_at: string; ready_at: string }>(
    `/v1/orders/${orderId}`,
    { token: guest },
  );
  check('гал тавих цаг тооцоологдлоо', Boolean(planned.body.fire_at), planned.body);
  console.log(
    `      fire ${hhmm(planned.body.fire_at)} → ready ${hhmm(planned.body.ready_at)} (суух 12:30)`,
  );

  /* ── arming ────────────────────────────────────────────────────── */
  console.log('\n12:15 — arm');
  await clockTo('12:15');
  const armReport = await tick();
  check('arm явлаа', armReport.body.armed === 1, armReport.body);

  const armed = await call<{ state: string }>(`/v1/orders/${orderId}`, { token: guest });
  check('төлөв ARMED', armed.body.state === 'ARMED', armed.body);

  const signalled = await call(`/v1/orders/${orderId}/signal`, {
    method: 'POST',
    token: guest,
    body: { type: 'on_my_way' },
  });
  check('«Хөдөллөө» бүртгэгдлээ', signalled.status === 202);
  await tick();

  const replanned = await call<{ fire_at: string }>(`/v1/orders/${orderId}`, { token: guest });
  console.log(`      дахин тооцоолов: fire ${hhmm(replanned.body.fire_at)}`);

  /* ── firing ────────────────────────────────────────────────────── */
  console.log('\nГаллалт');
  let fired = false;
  for (const label of ['12:16', '12:18', '12:19', '12:20', '12:21', '12:22']) {
    await clockTo(label);
    const report = await tick();
    if (report.body.fired > 0) {
      check(`${label}-д галлалаа`, true);
      fired = true;
      break;
    }
  }
  check('галласан', fired);

  const cooking = await call<{ state: string }>(`/v1/orders/${orderId}`, { token: guest });
  check('төлөв COOKING', cooking.body.state === 'COOKING', cooking.body);

  const tooLate = await call(`/v1/orders/${orderId}/cancel`, { method: 'POST', token: guest });
  check(
    'галласны дараа цуцлах боломжгүй',
    tooLate.status === 409 && tooLate.body.error?.code === 'TOO_LATE_TO_CANCEL',
    tooLate.body,
  );

  const board2 = await call<{ lanes: { cooking: unknown[] } }>('/v1/kds/tickets', { token: tablet });
  check('тасалбар «гал дээр» баганад', board2.body.lanes.cooking.length === 1);

  /* ── serving ───────────────────────────────────────────────────── */
  console.log('\nҮйлчилгээ');
  await clockTo('12:29');
  const checkedIn = await call<{ seated: boolean }>(`/v1/checkin/${created.body.code}`, {
    method: 'POST',
    token: tablet,
    body: {},
  });
  check('зочин суулаа', checkedIn.body.seated === true, checkedIn.body);

  await clockTo('12:31');
  const ready = await call(`/v1/kds/tickets/${orderId}/ready`, {
    method: 'POST',
    token: tablet,
    body: {},
  });
  check('хоол бэлэн', ready.status === 200, ready.body);

  const served = await call(`/v1/kds/tickets/${orderId}/served`, {
    method: 'POST',
    token: tablet,
    body: {},
  });
  check('гардуулсан', served.status === 200, served.body);

  const final = await call<{ state: string; can_cancel: boolean }>(`/v1/orders/${orderId}`, {
    token: guest,
  });
  check('төлөв SERVED', final.body.state === 'SERVED', final.body);

  /* ── isolation ─────────────────────────────────────────────────── */
  console.log('\nЭрхийн тусгаарлалт');
  if (rivalPaired?.body.token) {
    const rivalBoard = await call<{ lanes?: { incoming: unknown[]; cooking: unknown[]; ready: unknown[] } }>(
      '/v1/kds/tickets',
      { token: rivalPaired.body.token },
    );
    const lanes = rivalBoard.body.lanes;
    const seen = lanes
      ? lanes.incoming.length + lanes.cooking.length + lanes.ready.length
      : -1;
    check('өөр ресторан энэ тасалбарыг харахгүй', seen === 0, rivalBoard.body);

    const meddle = await call(`/v1/kds/tickets/${orderId}/ready`, {
      method: 'POST',
      token: rivalPaired.body.token,
      body: {},
    });
    check('өөр ресторан үйлдэл хийж чадахгүй', meddle.status === 403, meddle.body);
  }

  const noToken = await call(`/v1/orders/${orderId}`);
  check('токенгүй бол 401', noToken.status === 401);

  /* ── ops ───────────────────────────────────────────────────────── */
  console.log('\nОps');
  const opsHealth = await call<{ held: number; late: number; offline: number; cooking: number }>(
    '/v1/ops/health',
  );
  check('эрүүл мэндийн дэлгэц', opsHealth.status === 200, opsHealth.body);
  console.log(
    `      HELD ${opsHealth.body.held} · хоцорсон ${opsHealth.body.late} · офлайн ${opsHealth.body.offline}`,
  );

  /* ── the second vertical ───────────────────────────────────────── */
  await idesh(guest);

  console.log(
    `\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} шалгалт өнгөрлөө\n`,
  );
  if (failures > 0) process.exit(1);
}

/**
 * Өвлийн идэш, over the same wire: a stall is listed, the guest pays for a
 * sheep, the supplier walks it to the handover, and nobody else can touch it.
 *
 * The demo guest holds 50 000₮ and a sheep costs more, so this is also the
 * «дутвал зөрүүг нь татна» path exercised for real.
 */
async function idesh(guest: string): Promise<void> {
  console.log('\nӨвлийн идэш');

  const listed = await call<{
    today: string;
    listings: Array<{
      id: string;
      title: string;
      unit: string;
      remaining: number;
      ready_from: string;
      price_mnt: number;
      supplier: { id: string; name: string; contracted: boolean };
    }>;
  }>('/v1/idesh/listings');
  check(`${listed.body.listings.length} зар, бүгд гэрээт нийлүүлэгчээс`,
    listed.body.listings.length >= 10 && listed.body.listings.every((l) => l.supplier.contracted));
  const stall = listed.body.listings.find((l) => l.unit === 'whole' && l.remaining > 0);
  check('бүтэн малын зар байна', Boolean(stall), listed.body);
  if (!stall) return;

  const created = await call<{ id: string; code: string; total_mnt: number }>('/v1/idesh', {
    method: 'POST',
    token: guest,
    key: `${RUN}-idesh`,
    body: { listing_id: stall.id, qty: 1, receive: 'pickup', receive_on: stall.ready_from },
  });
  check(`№${created.body.code} үүслээ (${stall.title})`, created.status === 201, created.body);
  const id = created.body.id;

  const paid = await call<{ state: string }>(`/v1/idesh/${id}/pay`, { method: 'POST', token: guest });
  check(`бүтэн үнэ ${created.body.total_mnt.toLocaleString('mn-MN')}₮ нэг удаа төлөгдлөө`,
    paid.body.state === 'PAID', paid.body);

  const detail = await call<{ state: string; supplier_phone: string | null; can_cancel: boolean }>(
    `/v1/idesh/${id}`, { token: guest });
  check('төлсний дараа нийлүүлэгчийн утас харагдана', Boolean(detail.body.supplier_phone), detail.body);

  const live = await call<{ orders: Array<{ id: string }> }>('/v1/idesh', { token: guest });
  check('нүүрний жагсаалтад орлоо', live.body.orders.some((o) => o.id === id));

  /* the supplier */
  const screen = await call<{ token: string }>('/dev/supplier-token', {
    method: 'POST', body: { supplier_id: stall.supplier.id },
  });
  check('нийлүүлэгчийн дэлгэц холбогдлоо', screen.status === 200, screen.body);
  const supplier = screen.body.token;

  const board = await call<{ lanes: { paid: Array<{ id: string }> } }>('/v1/supplier/board', { token: supplier });
  check('идэш нийлүүлэгчийн дэлгэц дээр гарлаа', board.body.lanes.paid.some((t) => t.id === id), board.body);

  const prepared = await call(`/v1/supplier/orders/${id}/prepare`, { method: 'POST', token: supplier, body: {} });
  check('нийлүүлэгч бэлтгэж эхэллээ', prepared.status === 200, prepared.body);

  const tooLate = await call(`/v1/idesh/${id}/cancel`, { method: 'POST', token: guest });
  check('бэлтгэж эхэлсний дараа цуцлах боломжгүй',
    tooLate.status === 409 && tooLate.body.error?.code === 'TOO_LATE_TO_CANCEL', tooLate.body);

  const ready = await call(`/v1/supplier/orders/${id}/ready`, { method: 'POST', token: supplier, body: {} });
  check('мах бэлэн', ready.status === 200, ready.body);
  const handed = await call(`/v1/supplier/orders/${id}/hand`, { method: 'POST', token: supplier, body: {} });
  check('хүлээлгэн өгсөн', handed.status === 200, handed.body);

  const final = await call<{ state: string }>(`/v1/idesh/${id}`, { token: guest });
  check('төлөв HANDED', final.body.state === 'HANDED', final.body);

  /* isolation */
  const suppliers = await call<{ suppliers: Array<{ id: string }> }>('/dev/suppliers');
  const rival = suppliers.body.suppliers.find((s) => s.id !== stall.supplier.id);
  if (rival) {
    const rivalScreen = await call<{ token: string }>('/dev/supplier-token', {
      method: 'POST', body: { supplier_id: rival.id },
    });
    const meddle = await call(`/v1/supplier/orders/${id}/hand`, {
      method: 'POST', token: rivalScreen.body.token, body: {},
    });
    check('өөр нийлүүлэгч энэ идэшинд хүрч чадахгүй', meddle.status === 403, meddle.body);
  }
  const noToken = await call(`/v1/idesh/${id}`);
  check('токенгүй бол 401', noToken.status === 401);
}

function hhmm(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Ulaanbaatar',
  }).format(new Date(iso));
}

await main();
