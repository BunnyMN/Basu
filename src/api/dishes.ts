import type { FastifyInstance } from 'fastify';

/**
 * A picture for every dish, drawn rather than photographed.
 *
 * Menus are chosen with the eyes, so the app needs images from the first day —
 * long before a restaurant has sent any. Stock photography would mean licensing
 * somebody else's lunch and pretending it is theirs; these are honest
 * illustrations, they weigh about a kilobyte, they never 404, and they cannot
 * show food a kitchen does not serve.
 *
 * When a real photograph arrives it goes in `menu_item.image_url` and this
 * stops being used for that dish. Nothing else changes.
 *
 * The drawing is deliberately flat and top-down: a bowl read from above is
 * recognisable at the 56 pixels a menu row gives it, where a three-quarter
 * view of the same bowl is a brown smudge.
 */

interface Dish {
  /** Which of the drawings below to use. */
  form: 'soup' | 'dumpling' | 'fried' | 'noodle' | 'grill' | 'salad' | 'drink' | 'rice' | 'skewer';
  /** The food itself. */
  fill: string;
  /** Garnish, grill marks, filling — whatever the form uses for detail. */
  detail: string;
  /** The cloth the plate sits on. */
  ground: string;
}

const DISHES: Record<string, Dish> = {
  // ── soups ────────────────────────────────────────────────────────
  guriltai_shol: { form: 'soup', fill: '#C98A3E', detail: '#F1E4CB', ground: '#EFE7DA' },
  banshtai_shol: { form: 'soup', fill: '#C07C3A', detail: '#F6EFE0', ground: '#EFE7DA' },
  bantan: { form: 'soup', fill: '#D9BE86', detail: '#FBF4E6', ground: '#F0EADF' },
  huurga_shol: { form: 'soup', fill: '#A65A2E', detail: '#E8D9BC', ground: '#EDE4D6' },

  // ── steamed & fried parcels ──────────────────────────────────────
  buuz: { form: 'dumpling', fill: '#F2E3C8', detail: '#D9C39C', ground: '#E9E2D6' },
  bansh: { form: 'dumpling', fill: '#F6EDDA', detail: '#E0CFAE', ground: '#ECE5DA' },
  khuushuur: { form: 'fried', fill: '#D9A03F', detail: '#B87A28', ground: '#EDE3D2' },
  gambir: { form: 'fried', fill: '#E0B458', detail: '#C08C33', ground: '#EFE6D6' },

  // ── the wok ──────────────────────────────────────────────────────
  tsuivan: { form: 'noodle', fill: '#C98F4B', detail: '#7E9B4E', ground: '#EBE3D5' },
  goimon: { form: 'noodle', fill: '#DCB367', detail: '#8AA55A', ground: '#EDE6D8' },
  tsagaan_budaa: { form: 'rice', fill: '#F3EDDF', detail: '#B4562F', ground: '#E9E3D6' },
  nogootoi_huurga: { form: 'noodle', fill: '#B87840', detail: '#6E9247', ground: '#EBE4D6' },

  // ── the grill ────────────────────────────────────────────────────
  steak: { form: 'grill', fill: '#8C4A2C', detail: '#5A2E1B', ground: '#E8E1D4' },
  shorlog: { form: 'skewer', fill: '#9E5230', detail: '#63321D', ground: '#EAE2D5' },
  takhia: { form: 'grill', fill: '#C68B45', detail: '#8A5A25', ground: '#ECE5D7' },
  fries: { form: 'fried', fill: '#E8BC5C', detail: '#C79338', ground: '#EFE7D7' },

  // ── cold ─────────────────────────────────────────────────────────
  salad: { form: 'salad', fill: '#6E9B45', detail: '#C0442F', ground: '#EAE6DA' },
  nogoon_salad: { form: 'salad', fill: '#7BA84E', detail: '#E0B23F', ground: '#EBE7DB' },

  // ── drinks ───────────────────────────────────────────────────────
  suutei_tsai: { form: 'drink', fill: '#E3D7BE', detail: '#C6B394', ground: '#EDE8DC' },
  kompot: { form: 'drink', fill: '#C4553C', detail: '#9C3B27', ground: '#EEE6DA' },
};

/** The one every unknown slug falls back to, so a menu never shows a hole. */
const FALLBACK: Dish = { form: 'soup', fill: '#B98A52', detail: '#EFE3CC', ground: '#EBE5D9' };

const SIZE = 160;

export function dishSvg(slug: string): string {
  const dish = DISHES[slug] ?? FALLBACK;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" role="img">
  <rect width="${SIZE}" height="${SIZE}" fill="${dish.ground}"/>
  ${draw(dish)}
</svg>`;
}

function draw(dish: Dish): string {
  switch (dish.form) {
    case 'soup':
      return soup(dish);
    case 'dumpling':
      return dumplings(dish);
    case 'fried':
      return fried(dish);
    case 'noodle':
      return noodles(dish);
    case 'grill':
      return grill(dish);
    case 'salad':
      return salad(dish);
    case 'rice':
      return rice(dish);
    case 'skewer':
      return skewer(dish);
    case 'drink':
      return drink(dish);
  }
}

/**
 * Steam, drawn on the cloth above the plate rather than on the plate itself.
 * The first version was white-on-white and simply did not exist.
 */
function steam(x: number, y: number): string {
  return `<path d="M${x} ${y + 16}q6-6 0-11t0-9" fill="none" stroke="rgba(20,24,27,.22)" stroke-width="2.4" stroke-linecap="round"/>`;
}

/** The white ring every plated form sits in. */
function plate(radius = 58): string {
  return `<circle cx="80" cy="80" r="${radius}" fill="#ffffff"/>
  <circle cx="80" cy="80" r="${radius}" fill="none" stroke="rgba(0,0,0,.07)" stroke-width="1.5"/>`;
}

function soup(d: Dish): string {
  return `${plate()}
  <circle cx="80" cy="80" r="45" fill="${d.fill}"/>
  <circle cx="80" cy="80" r="45" fill="none" stroke="rgba(0,0,0,.06)" stroke-width="1"/>
  <g fill="${d.detail}" opacity=".92">
    <ellipse cx="66" cy="70" rx="13" ry="7" transform="rotate(-18 66 70)"/>
    <ellipse cx="92" cy="78" rx="12" ry="6.5" transform="rotate(14 92 78)"/>
    <ellipse cx="74" cy="94" rx="12" ry="6" transform="rotate(-6 74 94)"/>
  </g>
  ${steam(72, 34)}
  ${steam(90, 30)}`;
}

function dumplings(d: Dish): string {
  // Five parcels, pleats facing the light. Placed by hand rather than in a
  // ring: an even ring reads as a diagram, a slight scatter reads as a plate.
  const at = [
    [62, 62],
    [98, 66],
    [58, 98],
    [96, 102],
    [80, 82],
  ];
  return `${plate()}
  ${at
    .map(
      ([x, y]) => `<g>
    <ellipse cx="${x}" cy="${y}" rx="19" ry="15" fill="${d.fill}"/>
    <ellipse cx="${x}" cy="${(y as number) - 2}" rx="19" ry="15" fill="none" stroke="${d.detail}" stroke-width="1.4"/>
    <path d="M${(x as number) - 11} ${(y as number) - 4}q5.5-7 11-7t11 7" fill="none" stroke="${d.detail}" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="${x}" cy="${(y as number) - 9}" r="2.6" fill="${d.detail}"/>
  </g>`,
    )
    .join('\n  ')}`;
}

function fried(d: Dish): string {
  // Folded half-moons, overlapping the way they come off a pan.
  const at = [
    [64, 70, -14],
    [96, 74, 12],
    [78, 100, -4],
  ];
  return `${plate()}
  ${at
    .map(
      ([x, y, angle]) => `<g transform="rotate(${angle} ${x} ${y})">
    <rect x="${(x as number) - 26}" y="${(y as number) - 15}" width="52" height="30" rx="14" fill="${d.fill}"/>
    <rect x="${(x as number) - 26}" y="${(y as number) - 15}" width="52" height="30" rx="14" fill="none" stroke="${d.detail}" stroke-width="1.6"/>
    <path d="M${(x as number) - 18} ${(y as number) - 4}h36" stroke="${d.detail}" stroke-width="1.6" stroke-linecap="round" opacity=".7"/>
    <path d="M${(x as number) - 16} ${(y as number) + 4}h32" stroke="${d.detail}" stroke-width="1.4" stroke-linecap="round" opacity=".5"/>
  </g>`,
    )
    .join('\n  ')}`;
}

function noodles(d: Dish): string {
  // Strands drawn as arcs across the plate, then the vegetables on top.
  const strands = Array.from({ length: 7 }, (_, i) => {
    const y = 58 + i * 7;
    const sweep = i % 2 === 0 ? 1 : 0;
    return `<path d="M42 ${y}q38 ${sweep ? 14 : -14} 76 0" fill="none" stroke="${d.fill}" stroke-width="5" stroke-linecap="round" opacity=".95"/>`;
  }).join('\n  ');
  return `${plate()}
  ${strands}
  <g fill="${d.detail}">
    <rect x="60" y="66" width="18" height="6" rx="3" transform="rotate(-24 60 66)"/>
    <rect x="88" y="86" width="20" height="6" rx="3" transform="rotate(16 88 86)"/>
    <rect x="66" y="100" width="16" height="6" rx="3" transform="rotate(-8 66 100)"/>
  </g>`;
}

function grill(d: Dish): string {
  return `${plate()}
  <rect x="44" y="54" width="72" height="52" rx="16" fill="${d.fill}"/>
  <rect x="44" y="54" width="72" height="52" rx="16" fill="none" stroke="rgba(0,0,0,.08)" stroke-width="1.4"/>
  <g stroke="${d.detail}" stroke-width="4.5" stroke-linecap="round" opacity=".85">
    <path d="M56 68l48 8"/>
    <path d="M54 84l48 8"/>
  </g>
  <g fill="#7E9B4E" opacity=".9">
    <ellipse cx="60" cy="112" rx="11" ry="5" transform="rotate(-12 60 112)"/>
    <ellipse cx="78" cy="115" rx="9" ry="4.5"/>
  </g>`;
}

function skewer(d: Dish): string {
  // Two sticks, meat alternating with onion — the thing that makes a шорлог
  // read as a шорлог at 56 pixels rather than as another piece of grilled meat.
  const stick = (y: number, tilt: number) => `<g transform="rotate(${tilt} 80 ${y})">
    <rect x="36" y="${y - 2}" width="88" height="4" rx="2" fill="#B9A98C"/>
    ${[52, 72, 92, 112]
      .map(
        (x, i) =>
          i % 2 === 1
            ? `<circle cx="${x}" cy="${y}" r="7.5" fill="#EFE3CF" stroke="rgba(0,0,0,.08)"/>`
            : `<rect x="${x - 10}" y="${y - 11}" width="20" height="22" rx="6" fill="${d.fill}"/>
               <path d="M${x - 6} ${y - 4}h12" stroke="${d.detail}" stroke-width="2.6" stroke-linecap="round"/>`,
      )
      .join('\n    ')}
  </g>`;
  return `${plate()}
  ${stick(66, -7)}
  ${stick(98, 6)}`;
}

function salad(d: Dish): string {
  const leaves = [
    [64, 68, -20],
    [96, 70, 24],
    [58, 96, 12],
    [98, 98, -16],
    [80, 84, 0],
  ];
  return `${plate()}
  ${leaves
    .map(
      ([x, y, a]) =>
        `<ellipse cx="${x}" cy="${y}" rx="20" ry="12" fill="${d.fill}" opacity=".9" transform="rotate(${a} ${x} ${y})"/>`,
    )
    .join('\n  ')}
  <g fill="${d.detail}">
    <circle cx="68" cy="78" r="7"/>
    <circle cx="95" cy="90" r="6"/>
    <circle cx="80" cy="105" r="5"/>
  </g>`;
}

function rice(d: Dish): string {
  // A mound of rice with the stir-fry spooned over one side, which is how it
  // arrives. Grains are suggested by texture rather than counted out.
  const grains = Array.from({ length: 22 }, (_, i) => {
    const angle = (i * 2.39996) % (Math.PI * 2);
    const radius = 8 + (i % 5) * 6.5;
    const x = 80 + Math.cos(angle) * radius;
    const y = 84 + Math.sin(angle) * radius * 0.8;
    return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="4.4" ry="2.2" transform="rotate(${((angle * 180) / Math.PI).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }).join('\n    ');

  return `${plate()}
  <ellipse cx="80" cy="84" rx="43" ry="38" fill="${d.fill}"/>
  <g fill="rgba(20,24,27,.07)">
    ${grains}
  </g>
  <g fill="${d.detail}">
    <ellipse cx="92" cy="70" rx="14" ry="9" transform="rotate(-16 92 70)"/>
    <ellipse cx="74" cy="62" rx="11" ry="7" transform="rotate(12 74 62)"/>
  </g>
  <g fill="#7E9B4E" opacity=".85">
    <ellipse cx="62" cy="76" rx="9" ry="4.5" transform="rotate(-20 62 76)"/>
    <ellipse cx="96" cy="94" rx="8" ry="4" transform="rotate(14 96 94)"/>
  </g>`;
}

function drink(d: Dish): string {
  return `<circle cx="80" cy="82" r="52" fill="#ffffff"/>
  <circle cx="80" cy="82" r="52" fill="none" stroke="rgba(0,0,0,.07)" stroke-width="1.5"/>
  <circle cx="80" cy="82" r="38" fill="${d.fill}"/>
  <circle cx="80" cy="82" r="38" fill="none" stroke="rgba(0,0,0,.07)" stroke-width="1.2"/>
  <ellipse cx="80" cy="82" rx="27" ry="27" fill="none" stroke="${d.detail}" stroke-width="2" opacity=".55"/>
  ${steam(70, 30)}
  ${steam(92, 26)}`;
}

const SLUG = /^[a-z0-9_]{1,40}$/;

export async function registerDishRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The same drawings, as the numbers they are drawn from.
   *
   * The iOS app cannot read an SVG, and shipping a second copy of this table
   * inside it would mean a dish whose colour changes here quietly keeps the
   * old one there. So the table is served and each client draws the nine
   * forms in its own language — one source for what a dish looks like, two
   * renderers, which is the least duplication the platforms allow.
   */
  app.get('/v1/dishes', async (_request, reply) =>
    reply
      .header('cache-control', 'public, max-age=604800, immutable')
      .send({ fallback: FALLBACK, dishes: DISHES }),
  );

  app.get<{ Params: { slug: string } }>('/dishes/:slug', async (request, reply) => {
    const slug = request.params.slug.replace(/\.svg$/, '');
    if (!SLUG.test(slug)) return reply.status(400).send();
    return reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      // Drawn from a constant table, so it is the same picture forever.
      .header('cache-control', 'public, max-age=604800, immutable')
      .send(dishSvg(slug));
  });
}

/** Every slug that has a drawing of its own. The seed checks against this. */
export const DRAWN_DISHES = Object.keys(DISHES);
