// Loaded through vite alone: imported.case.mjs imports it and nothing requires it, as every module under src/ is
// loaded. One function is called, one never is, and one arm is never taken: a count of zero has to come out as
// zero in this form too.
export function called(n) {
  if (n > 10) return 'big'
  return 'small'
}

export function notCalled() {
  return 'never'
}
