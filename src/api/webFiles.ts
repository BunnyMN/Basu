import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

/**
 * The web's files on their way to a phone: how small they travel, and how
 * long a browser may keep them.
 *
 * Small: the text — pages, styles, scripts, the one SVG — is compressed once,
 * when the server is built, at the strongest settings there are: brotli 11,
 * gzip 9. Each file gets an `.br` and a `.gz` beside it, and the server
 * hands over whichever the browser said it reads (@fastify/static's
 * `preCompressed`), the file itself when it named neither. nginx in front
 * gzips only HTML, at its fastest level, and leaves an answer that already
 * says how it is encoded as it is; so app.css and api.js, which used to
 * cross the wire whole, now cross it at a quarter of their size or less,
 * and nobody spends a CPU cycle on it per request. Under `tsx` there is
 * nothing compressed beside src/web, and every file goes out as it is.
 *
 * Long: a file that never changes under its name need not be asked about
 * again. A font is cut once and a new cut gets a new name (scripts/web-fonts.sh),
 * so it is kept for a year and never revalidated. A photo may be re-encoded
 * under its name, so it is kept a month and refreshed in the background a week
 * past that. Pages, styles and scripts keep their names across every
 * release, so the browser asks each time whether they changed — a 304 when
 * they did not.
 */

/** What is worth compressing: text. Photos and fonts are compressed already. */
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.json', '.txt', '.xml', '.webmanifest']);

/** Beside each such file, as @fastify/static looks for them. */
const VARIANTS = ['.br', '.gz'] as const;

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

export interface Precompressed {
  /** Text files compressed. */
  files: number;
  /** Their bytes, and their bytes as brotli and as gzip. */
  bytes: number;
  br: number;
  gz: number;
}

/**
 * Write `<file>.br` and `<file>.gz` beside every text file under `root`, the
 * last step of `npm run build` (src/entry/precompress.ts).
 *
 * Every variant already there goes first — one a source has since outgrown,
 * and one whose source is gone — so a build that stops halfway leaves files
 * served as they are, never an older page beside a newer one. Each variant
 * is written aside and renamed into place, so the server that is still
 * running while a deploy builds never reads one half-written. A variant
 * that would not be smaller than its file is not written at all.
 */
export async function precompress(root: string): Promise<Precompressed> {
  const all = await filesUnder(root);
  const sources = all.filter(isCompressible);
  const variants = all.filter((file) => VARIANTS.some((v) => file.endsWith(v) && isCompressible(file.slice(0, -v.length))));
  await Promise.all(variants.map((file) => unlink(file)));

  const done: Precompressed = { files: 0, bytes: 0, br: 0, gz: 0 };
  await Promise.all(
    sources.map(async (file) => {
      const raw = await readFile(file);
      const [br, gz] = await Promise.all([
        brotli(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        }),
        gzipped(raw, { level: constants.Z_BEST_COMPRESSION }),
      ]);
      // Awaited before adding: `done.br += await …` would read the sum before
      // the wait, and the files compressed alongside would overwrite each other.
      const [brKept, gzKept] = await Promise.all([keepIfSmaller(`${file}.br`, br, raw.length), keepIfSmaller(`${file}.gz`, gz, raw.length)]);
      done.files += 1;
      done.bytes += raw.length;
      done.br += brKept;
      done.gz += gzKept;
    }),
  );
  return done;
}

/** The variant's bytes as written, or the file's own when it was not worth writing. */
async function keepIfSmaller(path: string, bytes: Buffer, size: number): Promise<number> {
  if (bytes.length >= size) return size;
  const aside = `${path}.${process.pid}.tmp`;
  await writeFile(aside, bytes);
  await rename(aside, path);
  return bytes.length;
}

function isCompressible(file: string): boolean {
  return COMPRESSIBLE.has(extname(file).toLowerCase());
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return filesUnder(path);
      return Promise.resolve(entry.isFile() ? [path] : []);
    }),
  );
  return nested.flat();
}

/** A year, never revalidated: the name changes when the bytes do. */
export const FOREVER = 'public, max-age=31536000, immutable';
/** A month, then a week more in the background while the browser asks again. */
export const A_MONTH = 'public, max-age=2592000, stale-while-revalidate=604800';

/** A font cut, named with the version of its cut: `fonts/GolosText-Regular.v2.woff2`. */
const FONT = /^fonts\/[^/]+\.v\d+\.woff2$/;
/** The brand's art and photos, and the idesh animals. */
const PICTURE = /^(brand|idesh)\/.+\.(webp|jpe?g|png|svg|avif)$/;

/**
 * How long a browser may keep a file under the web root, by its path there
 * (`fonts/…`, `brand/meat/hero.webp`), or nothing for the plugin's own
 * `public, max-age=0`: ask every time. A compressed variant is kept as long
 * as its file.
 */
export function cacheControl(path: string): string | undefined {
  const file = path.split(sep).join('/').replace(/\.(br|gz)$/, '');
  if (FONT.test(file)) return FOREVER;
  if (PICTURE.test(file)) return A_MONTH;
  return undefined;
}

/** `cacheControl` for the absolute path @fastify/static is about to send. */
export function cacheControlUnder(root: string, absolutePath: string): string | undefined {
  return cacheControl(relative(root, absolutePath));
}
