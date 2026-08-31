import { existsSync } from 'node:fs';

/**
 * Node can read .env itself since 20.12, so there is no reason to take a
 * dependency for it. Importing this module once, early, is the whole contract.
 */
let loaded = false;

export function loadEnv(file = '.env'): void {
  if (loaded) return;
  loaded = true;
  if (existsSync(file)) process.loadEnvFile(file);
}

loadEnv();
