import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mode } from './mode.js';

/**
 * The mode, as a process reads it and as a deploy pins it.
 *
 * The demo mounts `/dev`, which signs anybody in as anybody and hands out
 * the desk's secret, so no reading of either may fall back to it: a server
 * runs the demo only when it is told so in as many words.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let saved: { mode: string | undefined; nodeEnv: string | undefined };

beforeEach(() => {
  saved = { mode: process.env['BASU_MODE'], nodeEnv: process.env['NODE_ENV'] };
});

afterEach(() => {
  for (const [name, value] of [['BASU_MODE', saved.mode], ['NODE_ENV', saved.nodeEnv]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A process to its end — or stopped, if it starts instead of refusing. */
function run(command: string, args: string[], env: Record<string, string>, cwd = ROOT) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('the mode a process reads', () => {
  it('is production however production was typed', () => {
    for (const typed of ['production', 'production ', ' Production', 'PRODUCTION\n']) {
      process.env['BASU_MODE'] = typed;
      expect(mode(), JSON.stringify(typed)).toBe('production');
    }
    process.env['BASU_MODE'] = ' Demo ';
    expect(mode()).toBe('demo');
  });

  it('is the demo, unnamed, only where NODE_ENV does not say production', () => {
    delete process.env['BASU_MODE'];
    process.env['NODE_ENV'] = 'development';
    expect(mode()).toBe('demo');
    process.env['NODE_ENV'] = 'production';
    expect(mode()).toBe('production');
    process.env['BASU_MODE'] = '';
    expect(mode()).toBe('production');
  });

  it('refuses a word that is neither, rather than guess the demo', () => {
    delete process.env['NODE_ENV'];
    for (const typed of ['"production"', 'prod', 'live', 'true']) {
      process.env['BASU_MODE'] = typed;
      expect(() => mode(), typed).toThrow(/BASU_MODE/);
    }
  });

  it('stops the API and the scheduler before they start, and says why', async () => {
    for (const entry of ['api', 'scheduler']) {
      const { code, stderr } = await run(process.execPath, ['--import', 'tsx', `src/entry/${entry}.ts`], {
        BASU_MODE: 'prod',
        PORT: '0',
      });
      expect(code, `${entry}: ${stderr}`).toBe(1);
      expect(stderr).toContain(`[${entry}] BASU_MODE is "prod"`);
    }
  });
});

/**
 * `scripts/deploy.sh` reads .env to decide what the API runs as, and whether
 * this is the deploy that leaves the demo. Its own functions, lifted out of it
 * and run in a folder that holds nothing but an .env.
 */
const script = readFileSync(join(ROOT, 'scripts', 'deploy.sh'), 'utf8');
const lift = (name: string): string => {
  const start = script.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`deploy.sh has no ${name}()`);
  const from = start + 1;
  const line = script.slice(from, script.indexOf('\n', from));
  return line.trimEnd().endsWith('}') ? line : script.slice(from, script.indexOf('\n}\n', from) + 2);
};
const prodDb = /^PROD_DB=(\S+)$/m.exec(script)?.[1];

/** Some of the deploy's functions, and then `call`, in a folder holding this .env. */
async function deploying(dotenv: string, functions: string[], call: string) {
  const folder = mkdtempSync(join(tmpdir(), 'basu-deploy-'));
  try {
    writeFileSync(join(folder, '.env'), dotenv);
    const lifted = functions.map(lift).join('\n');
    return await run('bash', ['-c', `set -euo pipefail\nPROD_DB=${prodDb}\n${lifted}\n${call}`], {}, folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const real = `DATABASE_URL=postgres://basu@127.0.0.1:5433/${prodDb}\n`;
const demoDb = 'DATABASE_URL=postgres://basu@127.0.0.1:5433/basu\n';
/** A password with a # in it, unquoted: the value ends at the #, for the API as much as the deploy. */
const unreadable = `DATABASE_URL=postgres://basu:pa#ss@127.0.0.1:5433/${prodDb}\n`;

/** What a deploy pins into the units is what the API runs as. */
describe('the mode a deploy pins', () => {
  const pinned = (dotenv: string) => deploying(dotenv, ['env_value', 'named_mode', 'named_db', 'pinned_mode'], 'pinned_mode');

  it('pins production for an .env that names it, however it names it', async () => {
    expect(prodDb).toBe('basu_prod');
    for (const named of [
      'BASU_MODE=production',
      'BASU_MODE="Production" # the pilot',
      'BASU_MODE=" production "',
      'BASU_MODE=demo\nBASU_MODE=production',
    ]) {
      const { code, stdout, stderr } = await pinned(`${named}\n${real}`);
      expect(code, `${named}: ${stderr}`).toBe(0);
      expect(stdout.trim(), named).toBe('production');
    }
  });

  it('pins production, not the demo, for an .env that names no mode', async () => {
    const { code, stdout } = await pinned(demoDb);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('production');
  });

  it('pins the demo only by name, and never on the real database', async () => {
    const demo = await pinned(`BASU_MODE=demo\n${demoDb}`);
    expect(demo.stdout.trim()).toBe('demo');

    const onReal = await pinned(`BASU_MODE=demo\n${real}`);
    expect(onReal.code).not.toBe(0);
    expect(onReal.stdout).toBe('');
    expect(onReal.stderr).toContain('refused');
  });

  it('pins no demo on a database it cannot name, rather than guess it is another', async () => {
    const guessed = await pinned(`BASU_MODE=demo\n${unreadable}`);
    expect(guessed.code).not.toBe(0);
    expect(guessed.stdout).toBe('');
    expect(guessed.stderr).toContain('names no database');
    // Production does not hang on which database it is.
    expect((await pinned(`BASU_MODE=production\n${unreadable}`)).stdout.trim()).toBe('production');
  });

  it('refuses a mode that is neither, and pins nothing', async () => {
    const typo = await pinned(`BASU_MODE=prod\n${real}`);
    expect(typo.code).not.toBe(0);
    expect(typo.stdout).toBe('');
    expect(typo.stderr).toContain('neither demo nor production');
  });

  it('is asked before the deploy changes anything, so a refusal leaves the server as it was', () => {
    const asked = [script.indexOf('\npinned_mode >/dev/null || exit 1\n'), script.indexOf('\nif still_the_demo; then')];
    for (const change of ['npm ci', 'npm run build', 'pg_dump "$DATABASE_URL"', 'dist/db/migrate.js', '\npin_mode\n']) {
      const at = script.indexOf(change);
      expect(at, change).toBeGreaterThan(-1);
      for (const question of asked) {
        expect(question, change).toBeGreaterThan(-1);
        expect(question, change).toBeLessThan(at);
      }
    }
  });
});

/**
 * The one switch out of the demo, which a deploy makes once: a fresh
 * production database, the demo's .env kept as the way back. Made a second
 * time, on a server that has left the demo, it would keep production's .env
 * as the demo's and, on any failure after it, put that back and stop the
 * scheduler.
 */
describe('the switch a deploy makes out of the demo', () => {
  const leaves = (dotenv: string) =>
    deploying(dotenv, ['env_value', 'named_mode', 'named_db', 'still_the_demo'], 'if still_the_demo; then echo leaves; else echo stays; fi');

  /** The pilot's .env as the switch and the repository's secrets left it. */
  const pilot = [
    'PORT=3210',
    'BASU_MODE=production',
    'NODE_ENV=production',
    `DATABASE_URL=postgres://basu:s3cret@127.0.0.1:5433/${prodDb}`,
    'BANK_KEY=q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=',
    'GOOGLE_CLIENT_ID="123-abc.apps.googleusercontent.com"',
    'GOOGLE_CLIENT_SECRET="GOCSPX-not-a-secret"',
    'SMTP_URL="smtps://basuappmn%40gmail.com:app%20pass@smtp.gmail.com:465"',
    'MAIL_FROM="Basu <basuappmn@gmail.com>"',
    'OPS_MEMBERS="desk@example.com"',
    '',
  ].join('\n');

  it('never makes it on a server that has left the demo', async () => {
    const asIs = await leaves(pilot);
    expect(asIs.code, asIs.stderr).toBe(0);
    expect(asIs.stdout.trim()).toBe('stays');
    // Production however it is spelled, or no mode at all on the production database.
    const respelled = pilot.replace('BASU_MODE=production', 'BASU_MODE=" Production"');
    const unnamed = pilot.replace('BASU_MODE=production\n', '');
    expect((await leaves(respelled)).stdout.trim()).toBe('stays');
    expect((await leaves(unnamed)).stdout.trim()).toBe('stays');
  });

  it('makes it once for the demo’s own .env', async () => {
    for (const dotenv of [`BASU_MODE=demo\n${demoDb}OPS_TOKEN=demo-desk\n`, demoDb]) {
      const { code, stdout, stderr } = await leaves(dotenv);
      expect(code, stderr).toBe(0);
      expect(stdout.trim()).toBe('leaves');
    }
  });

  it('refuses to guess, rather than make it, when it cannot tell which database this is', async () => {
    const { code, stdout, stderr } = await leaves(unreadable);
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('names no database');
  });
});
