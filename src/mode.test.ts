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
 * `scripts/deploy.sh` pins the mode into the units, and what it pins is what
 * the API runs as. Its own functions, lifted out of it and run in a folder
 * that holds nothing but an .env.
 */
describe('the mode a deploy pins', () => {
  const script = readFileSync(join(ROOT, 'scripts', 'deploy.sh'), 'utf8');
  const lift = (name: string): string => {
    const start = script.indexOf(`\n${name}() {`);
    if (start < 0) throw new Error(`deploy.sh has no ${name}()`);
    const from = start + 1;
    const line = script.slice(from, script.indexOf('\n', from));
    return line.trimEnd().endsWith('}') ? line : script.slice(from, script.indexOf('\n}\n', from) + 2);
  };
  const prodDb = /^PROD_DB=(\S+)$/m.exec(script)?.[1];

  async function pinned(dotenv: string) {
    const folder = mkdtempSync(join(tmpdir(), 'basu-deploy-'));
    try {
      writeFileSync(join(folder, '.env'), dotenv);
      const functions = ['env_value', 'named_mode', 'named_db', 'pinned_mode'].map(lift).join('\n');
      return await run('bash', ['-c', `set -euo pipefail\nPROD_DB=${prodDb}\n${functions}\npinned_mode`], {}, folder);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  const real = `DATABASE_URL=postgres://basu@127.0.0.1:5433/${prodDb}\n`;
  const demoDb = 'DATABASE_URL=postgres://basu@127.0.0.1:5433/basu\n';

  it('pins production for an .env that names it, however it names it', async () => {
    expect(prodDb).toBe('basu_prod');
    for (const named of ['BASU_MODE=production', 'BASU_MODE="Production" # the pilot', 'BASU_MODE=demo\nBASU_MODE=production']) {
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

  it('refuses a mode that is neither, and pins nothing', async () => {
    const typo = await pinned(`BASU_MODE=prod\n${real}`);
    expect(typo.code).not.toBe(0);
    expect(typo.stdout).toBe('');
    expect(typo.stderr).toContain('neither demo nor production');
  });
});
