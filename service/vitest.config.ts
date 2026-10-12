import { defineConfig } from 'vitest/config';

// Three projects:
//  - unit:   every *.test.ts under packages/ and apps/ (mock runtime, PGlite, fs artifact store)
//  - parity: tests that exercise the upstream CLI/viewer against the service (test/parity)
//  - live:   paid provider calls; only runs with ANALYSIS_LIVE=1 and a spend ceiling
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'parity',
          include: ['test/parity/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          testTimeout: 1_800_000,
        },
      },
    ],
  },
});
