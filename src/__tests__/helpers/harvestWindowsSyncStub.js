// V4-RIPENESSCUES-001 — shared sync stub for the lazy colour-window resolver.
//
// CropCard lazy-loads `src/lib/harvestWindows.js` in an effect (the app's first code-split point).
// Suites that mount CropCard but are NOT about windows mock the module to this no-window resolver:
//   vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))
// An empty resolution never sets state in CropCard (only resolved-with-window re-renders), so with
// this stub those suites see ZERO async churn — no act() warnings, and absence assertions can
// never be flipped by a window popping in mid-test. Window rendering itself is covered by
// CropCard.window.test.jsx / CropCard.windowReject.test.jsx / CropCard.windowSparse.test.jsx,
// which do NOT use this stub.
export function resolveHarvestWindow() {
  return { cultivar: null, crop: null }
}
export function windowKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}
export const WINDOWS_BY_CULTIVAR = {}
export const WINDOWS_BY_CROP_TYPE = {}
