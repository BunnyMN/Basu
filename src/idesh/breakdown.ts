import { IdeshError } from './errors.js';

/**
 * Задаргаа: how a whole animal is taken apart for the guest.
 *
 * Pure: no clock, no database. The words are Basu's and not each supplier's,
 * so a guest reads the same six parts on every stall and two listings can be
 * told apart by what they offer rather than by how they happen to say it.
 *
 * A supplier offers styles on a listing; a guest chooses one way for the
 * order. There are two shapes of choice and three names for them: the carcass
 * untouched, or jointed — and of the joints, the ones to be cut small and
 * bagged for the pot. None cut is «мөчилсөн», all cut is «хоолны хэмжээгээр»,
 * and anything between is the guest saying «the legs whole, the ribs small».
 */

/** What a supplier can say they do. */
export type Style = 'carcass' | 'jointed' | 'cut';
export const STYLES: readonly Style[] = ['carcass', 'jointed', 'cut'];

/** The joints a guest chooses between, in the order a butcher names them. */
export type Part = 'fore' | 'hind' | 'rump' | 'spine' | 'ribs' | 'neck';
export const PARTS: readonly Part[] = ['fore', 'hind', 'rump', 'spine', 'ribs', 'neck'];

export const STYLE_LABEL: Record<Style, string> = {
  carcass: 'Бүтэн гулууз',
  jointed: 'Мөчилсөн',
  cut: 'Хоолны хэмжээгээр',
};

export const STYLE_HINT: Record<Style, string> = {
  carcass: 'Задлахгүй, гулуузаар нь',
  jointed: 'Үе мөчөөр нь салгасан, хэсэг бүр бүхлээрээ',
  cut: 'Бүх хэсгийг жижиглэж хэрчээд ууталсан',
};

export const PART_LABEL: Record<Part, string> = {
  fore: 'Хаа',
  hind: 'Гуя',
  rump: 'Ууц',
  spine: 'Нуруу, сээр',
  ribs: 'Хавирга, өвчүү',
  neck: 'Хүзүү',
};

/** The longest wish a guest may add: one line a butcher reads at a glance. */
export const NOTE_MAX = 140;

/** Only these are carried home in one piece. */
const SMALL_STOCK: readonly string[] = ['sheep', 'goat'];

export interface BreakdownOffer {
  styles: Style[];
  /** Per head, for cutting small. */
  cutFeeMnt: number;
}

/** What a guest chose. */
export interface Breakdown {
  style: 'carcass' | 'parts';
  /** The joints to cut small, in `PARTS` order. Empty for a carcass, and for joints left whole. */
  cut: Part[];
  note: string | null;
}

/** What a guest sends: a style, the joints to cut, a wish. */
export interface BreakdownWant {
  style?: unknown;
  cut?: unknown;
  note?: unknown;
}

/**
 * What a supplier may offer on this listing, in `STYLES` order, or a refusal.
 * Nothing offered is a listing that asks the guest nothing.
 */
export function offerOf(input: { kind: string; unit: string; styles?: readonly string[] | undefined; cutFeeMnt?: number | undefined }): BreakdownOffer {
  const asked = input.styles ?? [];
  for (const s of asked) {
    if (!STYLES.includes(s as Style)) throw new IdeshError('BAD_BREAKDOWN', `unknown breakdown style ${s}`);
  }
  const styles = STYLES.filter((s) => asked.includes(s));
  const fee = input.cutFeeMnt ?? 0;
  if (!Number.isInteger(fee) || fee < 0) {
    throw new IdeshError('BAD_BREAKDOWN', 'the cutting fee has to be a whole number of tugriks, or nothing');
  }
  if (styles.length === 0) {
    if (fee > 0) throw new IdeshError('BAD_BREAKDOWN', 'a cutting fee is for a listing that offers cutting');
    return { styles: [], cutFeeMnt: 0 };
  }
  if (input.unit !== 'whole') {
    throw new IdeshError('BAD_BREAKDOWN', 'only a whole animal is taken apart to order');
  }
  if (styles.includes('carcass') && !SMALL_STOCK.includes(input.kind)) {
    throw new IdeshError('BAD_BREAKDOWN', 'only a sheep or a goat is handed over as one carcass');
  }
  if (styles.includes('cut') && !styles.includes('jointed')) {
    throw new IdeshError('BAD_BREAKDOWN', 'whoever cuts small also joints');
  }
  if (fee > 0 && !styles.includes('cut')) {
    throw new IdeshError('BAD_BREAKDOWN', 'a cutting fee is for a listing that offers cutting');
  }
  return { styles, cutFeeMnt: fee };
}

/**
 * The guest's choice held against what the listing offers.
 *
 * A choice that does not fit is refused rather than bent into one that does.
 * A choice not made at all is the plain way — jointed where the supplier
 * joints, else the carcass: what the guest was handed before there was a
 * question, and never the way that costs. So a page from before the listing
 * offered anything still buys the animal. A listing that offers nothing takes
 * no choice, and a page showing yesterday's offer is told so instead of
 * having its guest's wish silently dropped.
 */
export function choose(offer: BreakdownOffer, want: BreakdownWant | null | undefined): Breakdown | null {
  const said = want !== null && want !== undefined && want.style !== undefined && want.style !== null;
  if (offer.styles.length === 0) {
    if (said) throw new IdeshError('BAD_BREAKDOWN', 'this listing takes no breakdown');
    return null;
  }

  const note = noteOf(want?.note);
  if (!said) {
    // «cut» is never offered alone (it brings «jointed»), so one of these two is always there.
    return offer.styles.includes('jointed') ? { style: 'parts', cut: [], note } : { style: 'carcass', cut: [], note };
  }

  if (want!.style === 'carcass') {
    if (!offer.styles.includes('carcass')) throw new IdeshError('BAD_BREAKDOWN', 'this listing is not handed over as a carcass');
    if (Array.isArray(want!.cut) && want!.cut.length > 0) {
      throw new IdeshError('BAD_BREAKDOWN', 'a carcass has no parts cut small');
    }
    return { style: 'carcass', cut: [], note };
  }
  if (want!.style !== 'parts') throw new IdeshError('BAD_BREAKDOWN', 'breakdown style is carcass or parts');

  const asked = want!.cut === undefined || want!.cut === null ? [] : want!.cut;
  if (!Array.isArray(asked)) throw new IdeshError('BAD_BREAKDOWN', 'cut is a list of parts');
  for (const p of asked) {
    if (!PARTS.includes(p as Part)) throw new IdeshError('BAD_BREAKDOWN', `unknown part ${String(p)}`);
  }
  const cut = PARTS.filter((p) => asked.includes(p));
  if (cut.length > 0 && !offer.styles.includes('cut')) {
    throw new IdeshError('BAD_BREAKDOWN', 'this supplier does not cut small');
  }
  if (cut.length === 0 && !offer.styles.includes('jointed')) {
    throw new IdeshError('BAD_BREAKDOWN', 'this supplier does not joint');
  }
  return { style: 'parts', cut, note };
}

function noteOf(sent: unknown): string | null {
  if (sent === undefined || sent === null) return null;
  if (typeof sent !== 'string') throw new IdeshError('BAD_BREAKDOWN', 'the note is a line of text');
  // One line: a butcher reads it off a ticket.
  const note = sent.replace(/\s+/g, ' ').trim();
  if (!note) return null;
  if ([...note].length > NOTE_MAX) throw new IdeshError('BAD_BREAKDOWN', `the note is at most ${NOTE_MAX} characters`);
  return note;
}

/** Is anything cut small? What the fee is charged for. */
export function isCut(b: Breakdown | null): boolean {
  return b !== null && b.cut.length > 0;
}

/**
 * The choice in words, the same on the guest's page, the supplier's ticket
 * and the desk: a name, and under it what happens to which part.
 */
export function describe(b: Breakdown): { label: string; detail: string } {
  if (b.style === 'carcass') return { label: STYLE_LABEL.carcass, detail: STYLE_HINT.carcass };
  if (b.cut.length === 0) return { label: STYLE_LABEL.jointed, detail: STYLE_HINT.jointed };
  if (b.cut.length === PARTS.length) return { label: STYLE_LABEL.cut, detail: STYLE_HINT.cut };
  const names = (parts: readonly Part[]) => parts.map((p) => PART_LABEL[p].toLowerCase()).join(', ');
  const whole = PARTS.filter((p) => !b.cut.includes(p));
  return {
    label: 'Хэсгээр',
    detail: `Жижиглэнэ: ${names(b.cut)}. Бүхлээр: ${names(whole)}.`,
  };
}

/** A row's three columns as the choice they hold; null where the guest was asked nothing. */
export function breakdownOf(row: { breakdown: string | null; cut_parts: string[] | null; breakdown_note: string | null }): Breakdown | null {
  if (row.breakdown !== 'carcass' && row.breakdown !== 'parts') return null;
  const cut = PARTS.filter((p) => (row.cut_parts ?? []).includes(p));
  return { style: row.breakdown, cut, note: row.breakdown_note };
}
