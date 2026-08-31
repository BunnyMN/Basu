#!/usr/bin/env node
/**
 * One command that exercises everything, in the order that makes a failure
 * easy to read: arithmetic first, then a whole simulated service, then the
 * real database, then a live server over HTTP.
 *
 * If this passes, the product works. If it fails, the earliest failing stage
 * is the one to look at — the later ones are usually just its consequences.
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const stages = [];
let apiProcess;

function run(label, command, args) {
  process.stdout.write(`\n── ${label} ${'─'.repeat(Math.max(0, 58 - label.length))}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  const ok = result.status === 0;
  stages.push({ label, ok });
  return ok;
}

async function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return false;
}

function stopApi() {
  if (apiProcess && !apiProcess.killed) apiProcess.kill('SIGTERM');
}

process.on('exit', stopApi);
process.on('SIGINT', () => {
  stopApi();
  process.exit(130);
});

/* ── 1–3: everything that needs no server ────────────────────────── */

run('Төрлийн шалгалт', 'npx', ['tsc', '-p', 'tsconfig.json', '--noEmit']);
run('Нэгжийн ба интеграцийн тест', 'npx', ['vitest', 'run']);
run('Өдрийн симуляц', 'npx', ['tsx', 'src/sim/run.ts']);

/* ── 4: the live server ──────────────────────────────────────────── */

run('Миграц', 'npm', ['run', '--silent', 'db:migrate']);
run('Демо өгөгдөл', 'npm', ['run', '--silent', 'seed']);

process.stdout.write(`\n── Сервер асааж байна ${'─'.repeat(38)}\n`);
apiProcess = spawn('npx', ['tsx', 'src/entry/api.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: process.env.PORT ?? '3000' },
});
let serverLog = '';
apiProcess.stdout.on('data', (chunk) => (serverLog += chunk));
apiProcess.stderr.on('data', (chunk) => (serverLog += chunk));

const port = process.env.PORT ?? '3000';
const up = await waitForServer(`http://localhost:${port}/health`);
if (!up) {
  console.error('Сервер асаагүй:\n' + serverLog);
  stages.push({ label: 'Сервер', ok: false });
} else {
  console.log(`  http://localhost:${port} бэлэн`);
  run('Бүтэн урсгалын шалгалт', 'npx', ['tsx', 'src/test/smoke.ts']);
}

stopApi();

/* ── verdict ─────────────────────────────────────────────────────── */

const failed = stages.filter((s) => !s.ok);
console.log(`\n${'═'.repeat(62)}`);
for (const stage of stages) console.log(`  ${stage.ok ? '✓' : '✗'} ${stage.label}`);
console.log(
  `\n${failed.length === 0 ? '✓ Бүх шат өнгөрлөө.' : `✗ ${failed.length} шат унасан.`}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
