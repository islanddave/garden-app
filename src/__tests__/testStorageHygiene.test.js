// OPS-TESTLOCALSTORAGEPOLLUTION-001 — pins the global persisted-state reset in setup.ts.
//
// The reset it guards is worth almost nothing if it can be deleted without anything going red,
// because the class it prevents is SILENT: a test that inherits a persisted filter, mode or draft
// from the test above it renders a different screen and usually still passes, right up until it
// doesn't. Measured before the reset landed, with `--sequence.shuffle.tests` across the 29 test
// files that write storage: seed 1 → 1 failure, seed 2 → 1, seed 3 → 6 (PhotoLibrary,
// inventoryAddEnums, FieldCapture). After: 0 across seeds 1-6.
//
// Both cases below assert an EMPTY store on entry and then dirty it, so the pair holds whichever
// order they run in — a guard that only worked in declaration order would go vacuous under the
// very shuffle that found the bug.
// NOT asserted here: that the reset runs BEFORE file-level beforeEach hooks (the property that
// lets the 92 files which seed their own storage keep working). It holds — setup files register
// first and vitest fires beforeEach in registration order — but no mutation reddens it: forcing
// `sequence.hooks: 'stack'` in vitest.config.ts leaves all three cases green, because that option
// reorders hooks within a suite, not setup-file hooks against test-file hooks. A guard that cannot
// fail is worth nothing, so it stays a comment in setup.ts instead of a green test.
import { describe, it, expect } from 'vitest'

const dirty = (tag) => {
  localStorage.setItem(`__hygiene.local.${tag}`, tag)
  sessionStorage.setItem(`__hygiene.session.${tag}`, tag)
}

const bothEmpty = () => ({ local: localStorage.length, session: sessionStorage.length })

describe('every test starts with empty web storage (OPS-TESTLOCALSTORAGEPOLLUTION-001)', () => {
  it('case A: enters clean, then leaves both stores dirty for case B', () => {
    expect(bothEmpty(), 'storage carried over from another test').toEqual({ local: 0, session: 0 })
    dirty('a')
    expect(localStorage.getItem('__hygiene.local.a')).toBe('a')
  })

  it('case B: enters clean, then leaves both stores dirty for case A', () => {
    expect(bothEmpty(), 'storage carried over from another test').toEqual({ local: 0, session: 0 })
    dirty('b')
    expect(sessionStorage.getItem('__hygiene.session.b')).toBe('b')
  })

})
