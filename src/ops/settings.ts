import { getPool, type Db } from '../db/pool.js';

/**
 * The few knobs the desk may turn, each named here so that a typo cannot
 * invent a new one and a page cannot store what nobody reads.
 */
export interface SettingSpec {
  key: string;
  label: string;
  hint: string;
  /** `flag` is on or off — kept as 1 or 0, drawn and chosen as «Нээлттэй» / «Хаалттай». */
  kind: 'number' | 'text' | 'flag';
  fallback: number | string;
}

export const SETTINGS: readonly SettingSpec[] = [
  { key: 'sms_unit_mnt', label: 'Нэг SMS-ийн үнэ, ₮', hint: 'CallPro-ийн гэрээний үнэ. Сарын зардлыг үүгээр тооцно.', kind: 'number', fallback: 0 },
  { key: 'push_unit_mnt', label: 'Нэг push-ийн үнэ, ₮', hint: 'Ихэвчлэн 0. APNs үнэгүй.', kind: 'number', fallback: 0 },
  { key: 'promo_featured_mnt', label: 'Онцгой зарын үнэ, ₮', hint: 'Нийлүүлэгч нэг удаа төлөхөд. 0 бол үнэгүй.', kind: 'number', fallback: 20000 },
  { key: 'promo_featured_days', label: 'Онцгой зарын хугацаа, хоног', hint: 'Төлснөөс хойш хэдэн хоног жагсаалтын дээд хэсэгт гарах.', kind: 'number', fallback: 7 },
  { key: 'promo_vip_mnt', label: 'VIP зарын үнэ, ₮', hint: 'Нийлүүлэгч нэг удаа төлөхөд. 0 бол үнэгүй.', kind: 'number', fallback: 50000 },
  { key: 'promo_vip_days', label: 'VIP зарын хугацаа, хоног', hint: 'Хамгийн дээр, нүүр хуудсанд хэдэн хоног гарах.', kind: 'number', fallback: 7 },
  { key: 'desk_banner', label: 'Ширээний зарлал', hint: 'Самбарын дээр бүх гишүүнд харагдана. Хоосон бол харагдахгүй.', kind: 'text', fallback: '' },
  { key: 'calls_open', label: 'Апп доторх дуудлага', hint: 'Нээлттэй бол Идэшийн зочин, нийлүүлэгч хоёр төлсөн захиалгаасаа бие биедээ залгана. Хаахад явж буй дуудлага дуустлаа үргэлжилнэ.', kind: 'flag', fallback: 0 },
];

export interface Setting extends SettingSpec {
  value: number | string;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export async function settings(db: Db = getPool()): Promise<Setting[]> {
  const { rows } = await db.query<{ key: string; value: unknown; updated_by: string | null; updated_at: Date }>('SELECT key, value, updated_by, updated_at FROM ops.setting');
  const stored = new Map(rows.map((r) => [r.key, r]));
  return SETTINGS.map((spec) => {
    const row = stored.get(spec.key);
    const raw = row?.value;
    const value = spec.kind === 'text' ? (typeof raw === 'string' ? raw : spec.fallback) : typeof raw === 'number' ? raw : spec.fallback;
    return { ...spec, value, updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null };
  });
}

export async function setting<T extends number | string>(key: string, db: Db = getPool()): Promise<T> {
  const all = await settings(db);
  const found = all.find((s) => s.key === key);
  if (!found) throw new Error(`no setting ${key}`);
  return found.value as T;
}

export class SettingError extends Error {
  constructor(readonly code: 'UNKNOWN' | 'BAD_VALUE', message: string) {
    super(message);
    this.name = 'SettingError';
  }
}

export async function setSetting(key: string, value: unknown, by: string, db: Db = getPool()): Promise<Setting> {
  const spec = SETTINGS.find((s) => s.key === key);
  if (!spec) throw new SettingError('UNKNOWN', `no setting ${key}`);
  let clean: number | string;
  if (spec.kind === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    if (!Number.isFinite(n) || n < 0) throw new SettingError('BAD_VALUE', `${key} must be a number ≥ 0`);
    clean = n;
  } else if (spec.kind === 'flag') {
    const said = typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (said === true || said === 1 || said === '1' || said === 'true' || said === 'on') clean = 1;
    else if (said === false || said === 0 || said === '0' || said === 'false' || said === 'off') clean = 0;
    else throw new SettingError('BAD_VALUE', `${key} is on (1) or off (0)`);
  } else {
    if (typeof value !== 'string' || value.length > 500) throw new SettingError('BAD_VALUE', `${key} must be text under 500 characters`);
    clean = value.trim();
  }
  await db.query(
    `INSERT INTO ops.setting (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(clean), by],
  );
  return (await settings(db)).find((s) => s.key === key)!;
}
