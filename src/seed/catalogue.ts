/**
 * The pilot's restaurants and what they cook.
 *
 * Ten venues inside a ten-minute walk of the Shangri-La towers, because the
 * density is the product: a guest opening the app should see eight choices, not
 * an empty map (§01 of the ops playbook).
 *
 * The two numbers on every dish are the ones the fire engine runs on:
 *
 *   prep     — order in, plate out, measured at peak rather than quoted
 *   hold     — minutes it can stand plated before the guest can tell
 *
 * These are estimates until the онбординг stopwatch session replaces them, and
 * the shape matters more than the digits: бууз steam slowly and hold well,
 * хуушуур are quick and hold for almost nothing. That difference is the whole
 * reason the planner cooks the fragile thing last.
 */

export interface Dish {
  /** Also the drawing served at /dishes/<slug>.svg. */
  slug: string;
  name: string;
  price: number;
  prep: number;
  hold: number;
  station: 'grill' | 'wok' | 'soup' | 'cold' | 'steam';
  note?: string;
}

export const DISHES: Record<string, Dish> = {
  /* ── soup ─────────────────────────────────────────────────────── */
  guriltai_shol: {
    slug: 'guriltai_shol',
    name: 'Гурилтай шөл',
    price: 9_000,
    prep: 4,
    hold: 15,
    station: 'soup',
    note: 'Гар гурил, хонины мах',
  },
  banshtai_shol: {
    slug: 'banshtai_shol',
    name: 'Банштай шөл',
    price: 11_000,
    prep: 6,
    hold: 15,
    station: 'soup',
    note: 'Жижиг банш, шөлөндөө',
  },
  bantan: {
    slug: 'bantan',
    name: 'Бантан',
    price: 7_500,
    prep: 5,
    hold: 12,
    station: 'soup',
    note: 'Өтгөн, гурилтай',
  },
  huurga_shol: {
    slug: 'huurga_shol',
    name: 'Хуургатай шөл',
    price: 12_000,
    prep: 7,
    hold: 12,
    station: 'soup',
  },

  /* ── steam ────────────────────────────────────────────────────── */
  buuz: {
    slug: 'buuz',
    name: 'Бууз',
    price: 12_000,
    prep: 14,
    hold: 9,
    station: 'steam',
    note: '5 ширхэг · уурын шүүгээнээс',
  },
  bansh: {
    slug: 'bansh',
    name: 'Банш',
    price: 10_000,
    prep: 9,
    hold: 7,
    station: 'steam',
    note: 'Чанасан, сүмстэй',
  },

  /* ── grill ────────────────────────────────────────────────────── */
  khuushuur: {
    slug: 'khuushuur',
    name: 'Хуушуур',
    price: 10_000,
    prep: 7,
    hold: 2,
    station: 'grill',
    note: '3 ширхэг · шаржуухан',
  },
  gambir: {
    slug: 'gambir',
    name: 'Гамбир',
    price: 6_500,
    prep: 6,
    hold: 3,
    station: 'grill',
  },
  steak: {
    slug: 'steak',
    name: 'Стейк',
    price: 32_000,
    prep: 12,
    hold: 3,
    station: 'grill',
    note: 'Үхрийн мах, дунд зэрэг',
  },
  shorlog: {
    slug: 'shorlog',
    name: 'Шорлог',
    price: 18_000,
    prep: 11,
    hold: 4,
    station: 'grill',
  },
  takhia: {
    slug: 'takhia',
    name: 'Шарсан тахиа',
    price: 16_000,
    prep: 10,
    hold: 4,
    station: 'grill',
  },
  fries: {
    slug: 'fries',
    name: 'Шарсан төмс',
    price: 6_000,
    prep: 5,
    hold: 2,
    station: 'grill',
  },

  /* ── wok ──────────────────────────────────────────────────────── */
  tsuivan: {
    slug: 'tsuivan',
    name: 'Цуйван',
    price: 14_000,
    prep: 9,
    hold: 6,
    station: 'wok',
    note: 'Гар зуурсан гурил',
  },
  goimon: {
    slug: 'goimon',
    name: 'Гоймонтой хуурга',
    price: 13_000,
    prep: 8,
    hold: 6,
    station: 'wok',
  },
  nogootoi_huurga: {
    slug: 'nogootoi_huurga',
    name: 'Ногоотой хуурга',
    price: 13_500,
    prep: 8,
    hold: 5,
    station: 'wok',
  },
  tsagaan_budaa: {
    slug: 'tsagaan_budaa',
    name: 'Цагаан будаатай хуурга',
    price: 12_500,
    prep: 7,
    hold: 8,
    station: 'wok',
  },

  /* ── cold ─────────────────────────────────────────────────────── */
  salad: {
    slug: 'salad',
    name: 'Салат',
    price: 8_000,
    prep: 3,
    hold: 20,
    station: 'cold',
  },
  nogoon_salad: {
    slug: 'nogoon_salad',
    name: 'Ногоон салат',
    price: 9_500,
    prep: 4,
    hold: 18,
    station: 'cold',
  },
  suutei_tsai: {
    slug: 'suutei_tsai',
    name: 'Сүүтэй цай',
    price: 3_000,
    prep: 2,
    hold: 10,
    station: 'cold',
  },
  kompot: {
    slug: 'kompot',
    name: 'Компот',
    price: 3_500,
    prep: 2,
    hold: 25,
    station: 'cold',
  },
};

export interface Venue {
  name: string;
  tin: string;
  lat: number;
  lon: number;
  /** Minutes on foot from the tower lobby. */
  travel: number;
  /** How many tickets each station can cook at once. */
  lanes: Partial<Record<Dish['station'], number>>;
  menu: Array<keyof typeof DISHES>;
}

/**
 * Ten kitchens, each with a different bottleneck.
 *
 * The variety is the point rather than decoration: a буузны газар is a slow
 * steamer with a long hold, a шарлагын газар is two fast grill lanes with
 * almost none, and the planner behaves visibly differently at each. A demo
 * where every venue has the same kitchen shows one behaviour ten times.
 */
export const VENUES: Venue[] = [
  {
    name: 'Модерн Номадс',
    tin: '1234567',
    lat: 47.9138,
    lon: 106.9165,
    travel: 5,
    lanes: { grill: 2, wok: 2, soup: 1, cold: 2, steam: 1 },
    menu: ['tsuivan', 'khuushuur', 'buuz', 'guriltai_shol', 'steak', 'salad', 'suutei_tsai'],
  },
  {
    name: 'Хаан Буузны Газар',
    tin: '2345678',
    lat: 47.9155,
    lon: 106.9215,
    travel: 8,
    // One steamer, and everything on the board goes through it. The queue
    // forms here rather than at the grill, which is the interesting case.
    lanes: { steam: 1, soup: 1, cold: 1, grill: 1 },
    menu: ['buuz', 'bansh', 'khuushuur', 'banshtai_shol', 'suutei_tsai', 'salad'],
  },
  {
    name: 'Ногоон Байшин',
    tin: '3456789',
    lat: 47.9105,
    lon: 106.9243,
    travel: 10,
    lanes: { cold: 3, wok: 1, soup: 1 },
    menu: ['nogoon_salad', 'salad', 'nogootoi_huurga', 'guriltai_shol', 'kompot'],
  },
  {
    name: 'Сүхбаатарын Гуанз',
    tin: '4567890',
    lat: 47.9192,
    lon: 106.9188,
    travel: 4,
    lanes: { soup: 2, steam: 1, wok: 1, cold: 1 },
    menu: ['guriltai_shol', 'banshtai_shol', 'bantan', 'buuz', 'tsuivan', 'suutei_tsai'],
  },
  {
    name: 'Талын Амт',
    tin: '5678901',
    lat: 47.9163,
    lon: 106.9128,
    travel: 7,
    lanes: { wok: 3, grill: 1, cold: 1 },
    menu: ['tsuivan', 'goimon', 'nogootoi_huurga', 'tsagaan_budaa', 'fries', 'salad'],
  },
  {
    name: 'Алтан Тавган',
    tin: '6789012',
    lat: 47.9121,
    lon: 106.9201,
    travel: 6,
    // Two grill lanes and nothing that holds: the venue where the planner has
    // to fire late rather than early, because there is no slack to spend.
    lanes: { grill: 2, cold: 1, wok: 1 },
    menu: ['steak', 'shorlog', 'takhia', 'fries', 'salad', 'kompot'],
  },
  {
    name: 'Хөх Морь',
    tin: '7890123',
    lat: 47.9174,
    lon: 106.9251,
    travel: 9,
    lanes: { grill: 2, steam: 1, soup: 1, cold: 1 },
    menu: ['khuushuur', 'gambir', 'buuz', 'huurga_shol', 'suutei_tsai'],
  },
  {
    name: 'Найман Шарга',
    tin: '8901234',
    lat: 47.9099,
    lon: 106.9159,
    travel: 10,
    lanes: { wok: 2, soup: 2, cold: 2 },
    menu: ['tsuivan', 'goimon', 'bantan', 'banshtai_shol', 'nogoon_salad', 'kompot'],
  },
  {
    name: 'Бөмбөгөр Ресторан',
    tin: '9012345',
    lat: 47.9147,
    lon: 106.9282,
    travel: 9,
    lanes: { grill: 2, wok: 2, soup: 1, cold: 2, steam: 1 },
    menu: ['steak', 'takhia', 'tsuivan', 'buuz', 'guriltai_shol', 'nogoon_salad', 'fries'],
  },
  {
    name: 'Сарны Гэрэл',
    tin: '0123456',
    lat: 47.9209,
    lon: 106.9231,
    travel: 7,
    lanes: { soup: 2, wok: 1, cold: 2, grill: 1 },
    menu: ['banshtai_shol', 'huurga_shol', 'tsagaan_budaa', 'gambir', 'salad', 'suutei_tsai'],
  },
];

/** Kitchen station display names, in Mongolian. */
export const STATIONS: Record<Dish['station'], string> = {
  grill: 'Шарах',
  wok: 'Хуурга',
  soup: 'Шөл',
  cold: 'Хүйтэн',
  steam: 'Уур',
};
