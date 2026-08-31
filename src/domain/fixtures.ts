import type { KitchenConfig, OrderLine } from './types.js';

/**
 * The pilot restaurant from the spec. These prep and hold numbers are the
 * placeholders the онбординг stopwatch session replaces on day two — they are
 * here so tests and the simulator have something concrete, not because anyone
 * believes them yet.
 */
export const PILOT_KITCHEN: KitchenConfig = {
  platingBufferMinutes: 1,
  stations: {
    grill: { code: 'grill', displayName: 'Шарах', parallelLanes: 2 },
    wok: { code: 'wok', displayName: 'Хуурга', parallelLanes: 2 },
    soup: { code: 'soup', displayName: 'Шөл', parallelLanes: 1 },
    cold: { code: 'cold', displayName: 'Хүйтэн', parallelLanes: 2 },
  },
};

export interface MenuItem {
  id: string;
  name: string;
  prepMinutes: number;
  holdToleranceMinutes: number;
  station: string;
  priceMnt: number;
}

export const PILOT_MENU: Record<string, MenuItem> = {
  soup_guril: {
    id: 'soup_guril',
    name: 'Гурилтай шөл',
    prepMinutes: 4,
    holdToleranceMinutes: 15,
    station: 'soup',
    priceMnt: 9_000,
  },
  soup_bansh: {
    id: 'soup_bansh',
    name: 'Банштай шөл',
    prepMinutes: 6,
    holdToleranceMinutes: 15,
    station: 'soup',
    priceMnt: 11_000,
  },
  salad: {
    id: 'salad',
    name: 'Салат',
    prepMinutes: 3,
    holdToleranceMinutes: 20,
    station: 'cold',
    priceMnt: 8_000,
  },
  tsuivan: {
    id: 'tsuivan',
    name: 'Цуйван',
    prepMinutes: 9,
    holdToleranceMinutes: 6,
    station: 'wok',
    priceMnt: 14_000,
  },
  khuushuur: {
    id: 'khuushuur',
    name: 'Хуушуур',
    prepMinutes: 7,
    holdToleranceMinutes: 2,
    station: 'grill',
    priceMnt: 10_000,
  },
  fries: {
    id: 'fries',
    name: 'Шарсан төмс',
    prepMinutes: 5,
    holdToleranceMinutes: 2,
    station: 'grill',
    priceMnt: 6_000,
  },
  steak: {
    id: 'steak',
    name: 'Стейк',
    prepMinutes: 12,
    holdToleranceMinutes: 3,
    station: 'grill',
    priceMnt: 32_000,
  },
};

let lineSeq = 0;

/** Build an order line from the pilot menu. */
export function line(menuId: keyof typeof PILOT_MENU, qty = 1): OrderLine {
  const item = PILOT_MENU[menuId];
  if (!item) throw new Error(`unknown menu item: ${String(menuId)}`);
  return {
    id: `line-${++lineSeq}`,
    name: item.name,
    qty,
    prepMinutes: item.prepMinutes,
    holdToleranceMinutes: item.holdToleranceMinutes,
    station: item.station,
  };
}

/** `at('12:30')` — a wall-clock time on the pilot's test day, Ulaanbaatar. */
export function at(hhmm: string, day = '2026-09-02'): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error(`expected HH:MM, got ${hhmm}`);
  return new Date(`${day}T${match[1]}:${match[2]}:00+08:00`);
}
