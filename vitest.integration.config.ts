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
  resolve: {
    dedupe: ['@aws-sdk/client-secrets-manager', '@clerk/backend', '@neondatabase/serverless'],
  },
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    hookTimeout: 20000,
    include: ['tests/integration/**/*.int.test.js'],
    server: {
      deps: {
        inline: [/lambda\//, /^@clerk\/backend/, /^@aws-sdk\/client-secrets-manager/, /^@neondatabase\/serverless/],
      },
    },
  },
})
