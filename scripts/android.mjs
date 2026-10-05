#!/usr/bin/env node
/**
 * The Android app, from a cold checkout to a running phone.
 *
 *   npm run android          # build, install on the connected phone or emulator, launch
 *   npm run android:test     # unit tests
 *   npm run android:apk      # a debug APK to hand to somebody
 *
 * The app talks to the pilot unless told otherwise: `BASU_API=http://10.0.2.2:3000
 * npm run android` points a debug build at `npm run dev` on this machine
 * (10.0.2.2 is this machine as the emulator sees it; a phone needs the Mac's
 * LAN address). Release builds ignore it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'android');
const PACKAGE = 'mn.basu.app';

const step = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);

/** Android Studio brings its own JDK and SDK; either may also be named in the environment. */
const studioJdk = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
const javaHome = process.env.JAVA_HOME ?? (existsSync(studioJdk) ? studioJdk : undefined);
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library', 'Android', 'sdk');
const adb = join(sdk, 'platform-tools', 'adb');

/** Anything the machine is missing, said once and plainly. */
function checkTools() {
  const missing = [];
  if (!javaHome && spawnSync('java', ['-version']).status !== 0) missing.push('JDK 17+ (Android Studio-г суулгахад хамт ирнэ)');
  if (!existsSync(sdk)) missing.push('Android SDK (Android Studio → SDK Manager)');
  if (missing.length) {
    console.error(`\nДараах хэрэгтэй байна:\n  ${missing.join('\n  ')}\n`);
    process.exit(1);
  }
  // Gradle finds the SDK through local.properties, which git does not see.
  const local = join(android, 'local.properties');
  if (!existsSync(local)) writeFileSync(local, `sdk.dir=${sdk}\n`);
}

function gradle(...tasks) {
  const args = [...tasks];
  if (process.env.BASU_API) args.push(`-PBASU_API=${process.env.BASU_API}`);
  execFileSync(join(android, 'gradlew'), args, {
    stdio: 'inherit',
    cwd: android,
    env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) },
  });
}

checkTools();
const mode = process.argv[2] ?? 'run';

if (mode === 'test') {
  step('Нэгжийн тест');
  gradle(':app:testDebugUnitTest');
} else if (mode === 'apk') {
  step('Debug APK');
  gradle(':app:assembleDebug');
  console.log(`\n${join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')}`);
} else {
  const devices = execFileSync(adb, ['devices']).toString().split('\n').slice(1).filter((line) => /\tdevice$/.test(line));
  if (!devices.length) {
    console.error('\nХолбогдсон утас эсвэл ажиллаж буй emulator алга. Android Studio → Device Manager-ээс нэгийг асаана уу.\n');
    process.exit(1);
  }
  step('Build → суулгах');
  gradle(':app:installDebug');
  step('Нээж байна');
  execFileSync(adb, ['shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`], { stdio: 'inherit' });
}
