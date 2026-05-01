import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
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
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        // Baseline thresholds — raise as test coverage grows.
        // lib/ and hooks/ (Lambda-equivalent logic): target 70%
        // components/ (React UI): target 60%
        // Overall floor to prevent undetected regression:
        lines:      50,
        functions:  50,
        branches:   45,
        statements: 50,
      },
      include: [
        'src/lib/**',
        'src/hooks/**',
        'src/components/**',
        'src/context/**',
      ],
      exclude: [
        'src/__tests__/**',
        'src/main.jsx',
        'src/shims/**',
        '**/*.d.ts',
      ],
    },
  },
});
