// vitest.integration.config.ts — real-Postgres integration suite (Phase 2 / RES-001).
// Separate from vitest.config.ts (jsdom unit + coverage ratchet). node env, no coverage floor.
// server.deps.inline forces vitest to transform the lambda handlers + their AWS/Clerk deps so
// vi.mock() can intercept imports the handler resolves from its OWN nested node_modules.
import { defineConfig } from 'vitest/config'
export default defineConfig({
  // dedupe forces a SINGLE physical copy of these packages (the root-installed one) so the
  // inlined lambda handler and the test's vi.mock() target the same module — otherwise the
  // handler resolves its own nested lambda/<fn>/node_modules copy and the mock misses it
  // (first run: real SecretsManagerClient ran -> CredentialsProviderError). neon stays REAL.
  // s3-request-presigner + client-s3 are here for lambda/photos: its handler signs URLs at request
  // time, so the photos integration test must be able to vi.mock the presigner (there are no AWS
  // credentials in CI). Same dedupe reasoning as above — without it the inlined handler resolves its
  // own lambda/photos/node_modules copy and the mock silently misses.
  resolve: {
    dedupe: [
      '@aws-sdk/client-secrets-manager',
      '@aws-sdk/client-s3',
      '@aws-sdk/s3-request-presigner',
      '@clerk/backend',
      '@neondatabase/serverless',
    ],
  },
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    hookTimeout: 20000,
    include: ['tests/integration/**/*.int.test.js'],
    // BUG-INTFIXTURELEAK-001. Per-file afterAll() is best-effort: it is skipped when beforeAll
    // throws, when a file fails to import, or when the run is cancelled. globalSetup's teardown runs
    // once after every file regardless, so it is the only hook that can guarantee the `int-test-`
    // namespace is empty at exit. It also refuses to start against prod/staging (assertEphemeralDatabase).
    globalSetup: ['tests/integration/_globalSetup.js'],
    server: {
      deps: {
        inline: [
          /lambda\//,
          /^@clerk\/backend/,
          /^@aws-sdk\/client-secrets-manager/,
          /^@aws-sdk\/client-s3/,
          /^@aws-sdk\/s3-request-presigner/,
          /^@neondatabase\/serverless/,
        ],
      },
    },
  },
})
