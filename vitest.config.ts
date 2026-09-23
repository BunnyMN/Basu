import { defineConfig } from 'vitest/config';

// Tests own their own database so a broken run can never touch dev data.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/basu_test';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The database-backed suites share one schema, so they must not interleave.
    fileParallelism: false,
    env: { DATABASE_URL: TEST_DATABASE_URL },
    globalSetup: ['src/test/globalSetup.ts'],
    // The page tests drive a real DOM against a real server and poll for the
    // result, so they need more room than a unit test — and a shared CI
    // runner is two to three times slower than a laptop. The ceiling has to
    // stay above the longest wait inside a test (see PATIENCE in
    // pages.test.ts), or vitest kills the test before the wait can report
    // what it was waiting for.
    testTimeout: process.env['CI'] ? 60_000 : 20_000,
  },
});
