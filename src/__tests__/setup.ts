/**
 * src/__tests__/setup.ts
 * Vitest global test setup — runs before each test file.
 * Keep this file minimal; heavy setup goes in individual test files or fixtures.
 */

// Tell React we're in a test environment (suppresses act() warnings)
// @ts-expect-error — global not typed by default
global.IS_REACT_ACT_ENVIRONMENT = true;

// Silence noisy console.error in tests unless you need to debug
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = (...args: unknown[]) => {
    // Re-throw actual errors; suppress React prop-type/act warnings in test output
    const msg = typeof args[0] === 'string' ? args[0] : '';
    if (msg.includes('Warning:') || msg.includes('act(')) return;
    originalConsoleError(...args);
  };
});
afterEach(() => {
  console.error = originalConsoleError;
});
