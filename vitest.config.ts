import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // OPS-JSXCLASSICFALLBACK-001. The unit run transforms JSX with esbuild, NOT with the plugin above.
  // `@vitejs/plugin-react` 5.2.0 targets vite 6/7/8 (the top-level vite here is 8.0.9), but vitest
  // 2.1.9 pins `vite-node` to its own nested vite@5.4.21 and that is the pipeline that transforms
  // test-run modules — so the plugin's automatic-runtime configuration never reaches it and esbuild
  // falls back to its DEFAULT `jsx: 'transform'` (classic), emitting bare `React.createElement`.
  // Every .jsx in the repo that does not `import React` then throws `ReferenceError: React is not
  // defined` the moment a test renders it — measured on src/pages/Home.jsx, 2026-08-14.
  // It stayed invisible because until now no unit test had rendered any of the 10 such files.
  // Setting the automatic runtime here is the systemic fix; the alternative (an `import React` in
  // each affected file) treats the symptom and re-arms with every new component.
  // This file governs the UNIT RUN ONLY — the production bundle is built from vite.config.js, where
  // plugin-react runs under a vite it supports and is unaffected by this block.
  // Guarded by src/__tests__/jsxAutomaticRuntime.test.jsx: revert this and that file goes red.
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    // OPS-FLAKEFAMILYWIDER-001. Must stay ABOVE the asyncUtilTimeout set in setup.ts (5000): if the
    // per-test budget is not larger, vitest kills the test before waitFor can report WHICH element
    // it could not find, and a diagnosable failure degrades into a bare "Test timed out in 5000ms".
    // The headroom is deliberate — a test may run several sequential waitFors. Like that setting,
    // this is a ceiling and not a duration: a passing test finishes when it finishes.
    testTimeout: 20000,
    // Integration tests (tests/integration/**) run in the integration-tests workflow via
    // vitest.integration.config.ts (real Neon driver + DB). Exclude them from the unit run
    // so `npm test` doesn't try to resolve @neondatabase/serverless.
    // '**/.claude/**': agent worktrees under .claude/worktrees/ hold full copies of the repo —
    // a bare `vitest run` swept 3 of them into 2,145 test files with ~96 phantom-failed files
    // and zero failing tests, twice (2026-08-12 and -13). Local-DX only; CI runners never have
    // these directories.
    exclude: [...configDefaults.exclude, 'tests/integration/**', '**/.claude/**'],
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
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        // Anti-regression floor (Wave 0 / WS-B) — set ~8pts below current MEASURED coverage of
        // the `include` set below, so normal churn passes but a re-skin that guts the tests reds
        // CI. Enforced two ways: vitest fails `npm test` if measured < these, AND
        // scripts/check-coverage-ratchet.py --measured (WS-B M4) fails if the lowest measured
        // metric drops below coverage-ratchet.json active_target.
        // Measured 2026-07-23 (dev 451fd56): lines 90.97 / funcs 83.21 / branches 81.32 / stmts 90.97.
        // Advancing the floor is a milestone decision (No-Date-Gating, gardening.md) — raise these
        // in lockstep with active_target and add tests to clear the new bar.
        lines:      82,
        functions:  75,
        branches:   73,
        statements: 82,
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
        // V4-COMPOSEPOST-002: instrument the harvests read model. The compose surface reads its wire
        // shape, and the 2026-08-10 audit found aggregate.js's projector was outside every coverage
        // measurement while the L-081 schema audit was simultaneously blind to its SELECT columns —
        // so nothing measured it from either direction. Ratchet stays at active_target: 0, same as
        // the daily-plan precedent: this adds measurement, not a new gate.
        'lambda/harvests/**',
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
