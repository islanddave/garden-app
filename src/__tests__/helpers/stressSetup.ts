// src/__tests__/helpers/stressSetup.ts — exposure instrument for OPS-RTLEVENTPRIORITY-001. NOT part of a normal run.
//
// React's scheduler runs a DEFAULT-priority render from setImmediate. This file delays setImmediate by 20ms, so every
// such render (a fetch answer's, since helpers/browserEvent.js went global in setup.ts) arrives LATE, and a test that
// waits for the fetch CALL and then reads the DOM in the same breath goes red every time instead of once in a while.
//
//   STRESS     npx vitest run -c vitest.stress.config.ts --maxWorkers=5 --reporter=dot --reporter=json --outputFile.json=<a>
//   STRESSCTL  STRESSCTL=1 npx vitest run -c vitest.stress.config.ts --maxWorkers=5 --reporter=dot --reporter=json --outputFile.json=<b>
//
// STRESSCTL is the same delay with the browserEvent install undone before each test (window.event remembers React's
// write-back again, as it did before the install). READ THE DIFFERENCE, not either run: a test red under STRESS and
// green under STRESSCTL leans on a fast default render only because of the global install — fix its timing. A test red
// under both is older fragility the install did not cause. Both runs over-state: no real machine is 20ms late every time.
import { beforeEach, afterEach } from 'vitest';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
// Before setup.ts and before any test file, so the scheduler captures the delayed one when it loads.
globalThis.setImmediate = ((fn: () => void, ...args: unknown[]) =>
  realSetTimeout(fn, 20, ...args)) as unknown as typeof setImmediate;
globalThis.clearImmediate = ((handle: unknown) =>
  realClearTimeout(handle as ReturnType<typeof setTimeout>)) as unknown as typeof clearImmediate;

await import('../setup');

if (process.env.STRESSCTL) {
  // Registered after setup.ts's pair: this beforeEach runs after its install, this afterEach before its restore.
  let kept = Object.getOwnPropertyDescriptor(globalThis, 'event');
  beforeEach(() => {
    if (kept) Object.defineProperty(globalThis, 'event', kept);
    else delete (globalThis as { event?: unknown }).event;
  });
  afterEach(() => {
    kept = Object.getOwnPropertyDescriptor(globalThis, 'event');
  });
}
