#!/usr/bin/env node
/**
 * The design pass: every shell screen, photographed on the simulator.
 *
 *   npm run ios:pass                  # light + dark, default type
 *   npm run ios:pass -- --xxl         # …and again at XXL Dynamic Type
 *   npm run ios:pass -- --out dir     # where the PNGs go (default ios/pass)
 *
 * Needs the app already built and installed (`npm run ios`), the API up, and
 * the demo guest reachable. Each screen is opened through the debug doors in
 * `RootView` — `BASU_SCREEN`, `BASU_APPS`, `BASU_DEMO_SIGNIN` — which exist in
 * debug builds only. Compare the output against `design/handoff/` by eye.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join('ios', 'pass');
const sizes = args.includes('--xxl') ? ['medium', 'extra-extra-extra-large'] : ['medium'];
/**
 * The bundle id, with the developer's own suffix if Developer.xcconfig sets
 * one (see ios/Developer.example.xcconfig): a personal team builds as
 * mn.basu.app.yourname, and that is what the simulator has to be asked to launch.
 */
const BUNDLE = `mn.basu.app${idSuffix()}`;
function idSuffix() {
  if (process.env.BASU_ID_SUFFIX) return process.env.BASU_ID_SUFFIX;
  try {
    const text = readFileSync(join(root, 'ios', 'Developer.xcconfig'), 'utf8');
    return /^\s*BASU_ID_SUFFIX\s*=\s*(\S+)/m.exec(text)?.[1] ?? '';
  } catch {
    return '';
  }
}
const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const screens = [
  { name: 'splash', env: { BASU_SCREEN: 'splash' } },
  { name: 'home-1', env: { BASU_APPS: '1' } },
  { name: 'home-4', env: { BASU_APPS: '4' } },
  { name: 'home-9', env: { BASU_APPS: '9' } },
  { name: 'wallet', env: { BASU_SCREEN: 'wallet' } },
  { name: 'inbox', env: { BASU_SCREEN: 'inbox' } },
  { name: 'profile', env: { BASU_SCREEN: 'profile' } },
];

mkdirSync(out, { recursive: true });
for (const size of sizes) {
  simctl('ui', 'booted', 'content_size', size);
  for (const appearance of ['light', 'dark']) {
    simctl('ui', 'booted', 'appearance', appearance);
    for (const screen of screens) {
      try { simctl('terminate', 'booted', BUNDLE); } catch {}
      // The pass photographs the developer's own server's data, like `npm run ios`.
      const env = { BASU_API: process.env.BASU_API ?? 'http://localhost:3000', BASU_DEMO_SIGNIN: '1', ...screen.env };
      const prefixed = Object.fromEntries(Object.entries(env).map(([k, v]) => [`SIMCTL_CHILD_${k}`, v]));
      execFileSync('xcrun', ['simctl', 'launch', 'booted', BUNDLE], { env: { ...process.env, ...prefixed }, stdio: 'ignore' });
      await sleep(screen.name === 'splash' ? 1200 : 4500);
      const suffix = size === 'medium' ? '' : '-xxl';
      const file = join(out, `${screen.name}-${appearance}${suffix}.png`);
      simctl('io', 'booted', 'screenshot', file);
      console.log(file);
    }
  }
}
simctl('ui', 'booted', 'content_size', 'medium');
simctl('ui', 'booted', 'appearance', 'light');
