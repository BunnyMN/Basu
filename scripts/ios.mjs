#!/usr/bin/env node
/**
 * The iOS app, from a cold checkout to a running phone.
 *
 *   npm run ios          # generate, build, boot a simulator, install, launch
 *   npm run ios:test     # unit tests + the whole-flow UI test
 *
 * The Xcode project is not in git — `ios/project.yml` is, and xcodegen makes
 * the project from it. A generated file in version control churns on every
 * file added and merges badly, and this one is regenerated in a second.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ios = join(root, 'ios');
const DEVICE = process.env.BASU_SIM ?? 'iPhone 17';
const BUNDLE = 'mn.basu.app';
const derived = join(ios, 'DerivedData');

const step = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', cwd: ios, ...options });

/** Anything the machine is missing, said once and plainly. */
function checkTools() {
  const missing = [];
  if (spawnSync('xcodebuild', ['-version']).status !== 0) missing.push('Xcode (xcode-select --install)');
  if (spawnSync('xcodegen', ['--version']).status !== 0) missing.push('xcodegen (brew install xcodegen)');
  if (missing.length) {
    console.error(`\nДараах хэрэгтэй байна:\n  ${missing.join('\n  ')}\n`);
    process.exit(1);
  }
}

function generate() {
  step('Xcode төсөл үүсгэж байна');
  run('xcodegen', ['generate']);
}

function test() {
  step(`Тест (${DEVICE})`);
  run('xcodebuild', [
    'test',
    '-project', 'Basu.xcodeproj',
    '-scheme', 'Basu',
    '-destination', `platform=iOS Simulator,name=${DEVICE}`,
    '-derivedDataPath', derived,
    '-quiet',
  ]);
  console.log('\n\x1b[32m✓ iOS тестүүд өнгөрлөө\x1b[0m');
}

function launch() {
  step(`Build (${DEVICE})`);
  run('xcodebuild', [
    'build',
    '-project', 'Basu.xcodeproj',
    '-scheme', 'Basu',
    '-destination', `platform=iOS Simulator,name=${DEVICE}`,
    '-derivedDataPath', derived,
    '-quiet',
  ]);

  const app = join(derived, 'Build', 'Products', 'Debug-iphonesimulator', 'Basu.app');
  if (!existsSync(app)) {
    console.error(`Build гарсангүй: ${app}`);
    process.exit(1);
  }

  step('Симулятор');
  spawnSync('xcrun', ['simctl', 'boot', DEVICE], { stdio: 'ignore' });
  spawnSync('open', ['-a', 'Simulator'], { stdio: 'ignore' });
  run('xcrun', ['simctl', 'install', DEVICE, app]);
  run('xcrun', ['simctl', 'launch', DEVICE, BUNDLE]);

  console.log(`
\x1b[32m✓ Basu симулятор дээр ажиллаж байна\x1b[0m

  API:  http://localhost:3000  (\x1b[1mnpm run dev\x1b[0m ажиллаж байх ёстой)
  Нэвтрэх: баруун дээд булан → «Демо: кодгүй нэвтрэх»
`);
}

checkTools();
generate();
if (process.argv[2] === 'test') test();
else launch();
