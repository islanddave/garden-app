import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    // Integration tests (tests/integration/**) run in the integration-tests workflow via
    // vitest.integration.config.ts (real Neon driver + DB). Exclude them from the unit run
    // so `npm test` doesn't try to resolve @neondatabase/serverless.
    exclude: [...configDefaults.exclude, 'tests/integration/**'],
    // Stub VITE_ env vars for tests — real values not needed in unit tests
    env: {
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_unit_test_placeholder',
      VITE_API_PROJECTS:          'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_PLANTS:            'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_LOCATIONS:         'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_EVENTS:            'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_FAVORITES:         'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_PHOTOS:            'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_DASHBOARD:         'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_INVENTORY:         'https://test-placeholder.lambda-url.us-east-1.on.aws/',
      VITE_API_VARIETIES:         'https://test-placeholder.lambda-url.us-east-1.on.aws/',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        // Floor thresholds — set just below current actual coverage to prevent regression.
        // Forward enforcement is driven by coverage-ratchet.json + scripts/check-coverage-ratchet.py
        // (calendar-due target). When the ratchet calendar bumps the target, raise these
        // thresholds in lockstep AND add tests to clear them.
        // Current actual (2026-05-08, post INV-LAMBDA-FOUNDATION): lines 16.93 / funcs 7.69 /
        // branches 69.01 / stmts 16.93. components/, context/, lib/ at 0% — preexisting tech debt.
        // hooks/useInventory.js at 97.65% (carry that forward via per-file thresholds in a
        // future pass — not done here to keep the unblock surgical).
        lines:      15,
        functions:   5,
        branches:   45,
        statements: 15,
      },
      include: [
        'src/lib/**',
        'src/hooks/**',
        'src/components/**',
        'src/context/**',
        // A0.4: instrument the daily-plan Lambda (engine/handler/station are heavily unit-tested but
        // lambda/** was entirely absent from coverage; index.js is the AWS entrypoint, currently 0%).
        // Ratchet stays at active_target: 0 — this only adds measurement, no new gate.
        'lambda/daily-plan/**',
      ],
      exclude: [
        'src/__tests__/**',
        'src/main.jsx',
        'src/shims/**',
        '**/*.d.ts',
        // Colocated lambda test files must not count as covered source (this custom exclude list
        // replaces vitest's defaults, which would otherwise have excluded them).
        'lambda/**/*.test.js',
      ],
    },
  },
});
