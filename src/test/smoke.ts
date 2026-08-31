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
  return { status: response.status, body: text ? JSON.parse(text) : (null as T) };
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

  // Pair the second restaurant now too, while its code is still fresh — the
  // isolation checks at the end run on a clock that has moved past lunch, and
  // in a real venue every tablet is paired before service anyway.
  const rivalDevice = codes.body.devices[1];
  const rivalPaired = rivalDevice
    ? await call<{ token: string }>('/v1/kds/pair', {
        method: 'POST',
        body: { pairing_code: rivalDevice.code },
      })
    : null;
  check('хоёр дахь таблет холбогдлоо', rivalPaired?.status === 200, rivalPaired?.body);

  /* ── browsing ──────────────────────────────────────────────────── */
  console.log('\nЗочин цэс үзэв');
  const venues = await call<{ restaurants: Array<{ id: string; name: string; accepting_orders: boolean }> }>(
    '/v1/restaurants',
  );
  const open = venues.body.restaurants.filter((r) => r.accepting_orders);
  // Two tablets are watching; the third restaurant has none and cannot be
  // ordered from — which is the point of the check, not an accident of setup.
  check(`${venues.body.restaurants.length} ресторан, ${open.length} нь нээлттэй`, open.length === 2);
  const venue = open.find((r) => r.id === device0.restaurant_id) ?? open[0]!;

  const menu = await call<{ items: Array<{ id: string; name: string; price_mnt: number }> }>(
    `/v1/restaurants/${venue.id}/menu`,
  );
  const tsuivan = menu.body.items.find((i) => i.name === 'Цуйван');
  check('цэс ирлээ', Boolean(tsuivan), menu.body);
  if (!tsuivan) return;

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
    key: 'smoke-order-1',
    body: {
      restaurant_id: venue.id,
      slot_starts_at: slot.starts_at,
      party_size: 2,
      items: [{ menu_item_id: tsuivan.id, qty: 2 }],
    },
  });
  check(`№${created.body.code} үүслээ`, created.status === 201, created.body);
  const orderId = created.body.id;

  const retry = await call<{ id: string }>('/v1/orders', {
    method: 'POST',
    token: guest,
    key: 'smoke-order-1',
    body: {
      restaurant_id: venue.id,
      slot_starts_at: slot.starts_at,
      party_size: 2,
      items: [{ menu_item_id: tsuivan.id, qty: 2 }],
    },
  });
  check('давхар дарахад нэг л захиалга', retry.body.id === orderId);

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

  console.log(
    `\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} шалгалт өнгөрлөө\n`,
  );
  if (failures > 0) process.exit(1);
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
