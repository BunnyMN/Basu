import { describe, expect, it } from 'vitest';
import { PARTS, choose, describe as words, isCut, offerOf, type BreakdownOffer } from './breakdown.js';
import { IdeshError } from './errors.js';

/**
 * Задаргаа, with no database in the room: what a supplier may offer on a
 * listing, what a guest may choose of it, and how the choice is said.
 */

const refused = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof IdeshError ? error.code : String(error);
  }
  return null;
};

const everything: BreakdownOffer = { styles: ['carcass', 'jointed', 'cut'], cutFeeMnt: 15_000 };
const jointsOnly: BreakdownOffer = { styles: ['jointed'], cutFeeMnt: 0 };
const nothing: BreakdownOffer = { styles: [], cutFeeMnt: 0 };

describe('what a supplier may offer', () => {
  it('keeps the styles in Basu’s order, whatever order they were ticked in', () => {
    expect(offerOf({ kind: 'sheep', unit: 'whole', styles: ['cut', 'carcass', 'jointed'], cutFeeMnt: 15_000 })).toEqual(everything);
  });

  it('is nothing when nothing is said — and then no fee either', () => {
    expect(offerOf({ kind: 'sheep', unit: 'whole' })).toEqual(nothing);
    expect(refused(() => offerOf({ kind: 'sheep', unit: 'whole', cutFeeMnt: 5_000 }))).toBe('BAD_BREAKDOWN');
  });

  it('is a whole animal’s only: meat by the kilogram is already whatever it is', () => {
    expect(refused(() => offerOf({ kind: 'beef', unit: 'kg', styles: ['jointed'] }))).toBe('BAD_BREAKDOWN');
  });

  it('hands over one carcass of a sheep or a goat, never of a cow or a horse', () => {
    expect(offerOf({ kind: 'goat', unit: 'whole', styles: ['carcass'] }).styles).toEqual(['carcass']);
    expect(refused(() => offerOf({ kind: 'beef', unit: 'whole', styles: ['carcass', 'jointed'] }))).toBe('BAD_BREAKDOWN');
    expect(refused(() => offerOf({ kind: 'horse', unit: 'whole', styles: ['carcass'] }))).toBe('BAD_BREAKDOWN');
  });

  it('takes cutting small only from whoever joints, and a fee only for cutting', () => {
    expect(refused(() => offerOf({ kind: 'sheep', unit: 'whole', styles: ['cut'] }))).toBe('BAD_BREAKDOWN');
    expect(refused(() => offerOf({ kind: 'sheep', unit: 'whole', styles: ['jointed'], cutFeeMnt: 5_000 }))).toBe('BAD_BREAKDOWN');
    expect(refused(() => offerOf({ kind: 'sheep', unit: 'whole', styles: ['jointed', 'cut'], cutFeeMnt: -1 }))).toBe('BAD_BREAKDOWN');
    expect(refused(() => offerOf({ kind: 'sheep', unit: 'whole', styles: ['minced'] }))).toBe('BAD_BREAKDOWN');
  });
});

describe('what a guest may choose', () => {
  it('asks nothing of a listing that offers nothing, and refuses a choice made of it', () => {
    expect(choose(nothing, undefined)).toBeNull();
    expect(choose(nothing, { note: 'ууцыг бүтэн' })).toBeNull();
    expect(refused(() => choose(nothing, { style: 'parts' }))).toBe('BAD_BREAKDOWN');
  });

  it('takes the plain way when none is said: jointed, or the carcass where that is all there is', () => {
    expect(choose(everything, undefined)).toEqual({ style: 'parts', cut: [], note: null });
    expect(choose({ styles: ['carcass'], cutFeeMnt: 0 }, null)).toEqual({ style: 'carcass', cut: [], note: null });
    // Never the way that costs.
    expect(isCut(choose(everything, {}))).toBe(false);
  });

  it('keeps the legs whole and cuts the ribs, in the parts’ own order', () => {
    const chosen = choose(everything, { style: 'parts', cut: ['neck', 'ribs', 'ribs'], note: '  Ууцыг   бүтэн үлдээгээрэй ' });
    expect(chosen).toEqual({ style: 'parts', cut: ['ribs', 'neck'], note: 'Ууцыг бүтэн үлдээгээрэй' });
    expect(isCut(chosen)).toBe(true);
  });

  it('refuses what the supplier does not do, and what is not a part', () => {
    expect(refused(() => choose(jointsOnly, { style: 'parts', cut: ['ribs'] }))).toBe('BAD_BREAKDOWN');
    expect(refused(() => choose(jointsOnly, { style: 'carcass' }))).toBe('BAD_BREAKDOWN');
    expect(refused(() => choose(everything, { style: 'parts', cut: ['tail'] }))).toBe('BAD_BREAKDOWN');
    expect(refused(() => choose(everything, { style: 'carcass', cut: ['ribs'] }))).toBe('BAD_BREAKDOWN');
    expect(refused(() => choose(everything, { style: 'minced' }))).toBe('BAD_BREAKDOWN');
    expect(refused(() => choose(everything, { style: 'parts', cut: 'ribs' }))).toBe('BAD_BREAKDOWN');
  });

  it('keeps a wish to one line a butcher reads at a glance', () => {
    expect(choose(everything, { style: 'carcass', note: '   ' })?.note).toBeNull();
    expect(choose(everything, { style: 'carcass', note: 'а'.repeat(140) })?.note).toHaveLength(140);
    expect(refused(() => choose(everything, { style: 'carcass', note: 'а'.repeat(141) }))).toBe('BAD_BREAKDOWN');
    expect(refused(() => choose(everything, { style: 'carcass', note: 7 }))).toBe('BAD_BREAKDOWN');
  });
});

describe('how the choice is said', () => {
  it('names the three ways, and anything between by its parts', () => {
    expect(words({ style: 'carcass', cut: [], note: null }).label).toBe('Бүтэн гулууз');
    expect(words({ style: 'parts', cut: [], note: null }).label).toBe('Мөчилсөн');
    expect(words({ style: 'parts', cut: [...PARTS], note: null }).label).toBe('Хоолны хэмжээгээр');
    expect(words({ style: 'parts', cut: ['ribs', 'neck'], note: null })).toEqual({
      label: 'Хэсгээр',
      detail: 'Жижиглэнэ: хавирга, өвчүү, хүзүү. Бүхлээр: хаа, гуя, ууц, нуруу, сээр.',
    });
  });
});
