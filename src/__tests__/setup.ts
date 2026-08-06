/**
 * src/__tests__/setup.ts
 * Vitest global test setup — runs before each test file.
 * Keep this file minimal; heavy setup goes in individual test files or fixtures.
 */

// Tell React we're in a test environment (suppresses act() warnings)
// @ts-expect-error — global not typed by default
global.IS_REACT_ACT_ENVIRONMENT = true;

// Node-version tolerance (Wave 0 / WS-B M1): some Node×jsdom combinations don't
// expose a working localStorage/sessionStorage on the test global (observed under
// Node 26). CI pins Node 20.19 (see .nvmrc + package.json "engines") where jsdom
// provides them; this guard installs a minimal in-memory Storage ONLY when the
// native one is missing/broken, so the suite is green on newer local Node too.
// No-op on CI where jsdom's Storage is present.
function makeMemoryStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() { return Object.keys(store).length; },
    clear() { store = {}; },
    getItem(key: string) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key: string, value: string) { store[key] = String(value); },
    removeItem(key: string) { delete store[key]; },
    key(i: number) { return Object.keys(store)[i] ?? null; },
  } as Storage;
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  let broken = false;
  try {
    const existing = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
    if (!existing || typeof existing.clear !== 'function') broken = true;
  } catch {
    broken = true;
  }
  if (broken) {
    const mem = makeMemoryStorage();
    Object.defineProperty(globalThis, name, { value: mem, writable: true, configurable: true });
    // In the jsdom env `window` aliases globalThis, but bind it explicitly in case
    // a test reaches for `window.localStorage` on a distinct window object.
    if (typeof window !== 'undefined' && (window as unknown) !== globalThis) {
      Object.defineProperty(window, name, { value: mem, writable: true, configurable: true });
    }
  }
}

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

// V4-BACKNAV-001 Slice 3a — GLOBAL SCROLL-LOCK LEAK DETECTOR.
//
// Sheet.jsx locks body scroll through a module-level refcount (`openStack`) and restores on the
// LAST close. A stranded lock is the worst failure mode in the dismiss program: it bricks body
// scrolling with NO in-app recovery short of a reload. It is also invisible within a single test —
// `lockBodyScroll` no-ops while the stack is non-empty, so a token leaked in test N silently
// poisons test N+1's `savedOverflow` capture, and the failure surfaces far from its cause.
//
// This afterEach converts every test file that renders a Sheet into a leak detector for free. It
// asserts BOTH properties, because Sheet sets and clears both and a regression that restores only
// `overflow` would otherwise pass.
afterEach(() => {
  const leakedOverflow = document.body.style.overflow;
  const leakedOverscroll = document.body.style.overscrollBehavior;
  // Reset before asserting, so one leaking test fails once rather than cascading into every
  // subsequent test in the same file.
  document.body.style.overflow = '';
  document.body.style.overscrollBehavior = '';
  if (leakedOverflow !== '' || leakedOverscroll !== '') {
    throw new Error(
      `Scroll lock leaked out of this test: body.style.overflow=${JSON.stringify(leakedOverflow)}, ` +
      `overscrollBehavior=${JSON.stringify(leakedOverscroll)}. A surface was closed by a path that ` +
      `bypassed Sheet's [open] cleanup — the stranded-lock class. Close through the owner's onDismiss.`
    );
  }
});
