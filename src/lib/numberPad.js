// numberPad.js — V4-QUICKHITRANGE-001 (BD-047) + V4-WEIGHKBDNEXT-001 (BD-046).
// The digit BUILDER that supersedes the replace-semantics quick-hit chips on the harvest quantity
// and weight fields. Pure string math, no React: the pad's LOGIC is falsifiable in jsdom even
// though its LAYOUT is not (tests/harness/README.md:14-16 — getBoundingClientRect returns zeros).
//
// Build, don't replace. Tapping 1 then 3 yields '13'. The single-digit fast path — 83.2% of
// measured quantities — is UNCHANGED: one tap still yields one digit. What changes is the tail,
// which previously required raising the Android keyboard to type at all.

export const PAD_BACKSPACE = '⌫' // ⌫

// Client-side only, and deliberately loose. harvest-constants.js mirrors lambda/events/validators.js
// with a server CHECK constraint behind it; a cap here pinned to MAX_PLAUSIBLE would read as a
// contract change it is not. 8 characters stops runaway build-up ('50000.5' is 7) without
// asserting a bound the server does not also assert.
export const PAD_MAX_LEN = 8

export function appendDigit(value, key, { maxLen = PAD_MAX_LEN } = {}) {
  const cur = value == null ? '' : String(value)
  if (key === PAD_BACKSPACE) return cur.slice(0, -1)
  if (key === '.') {
    // Number('3.4.5') is NaN, which validateHarvest() rejects with a generic error only AFTER the
    // user has finished typing — a late, confusing failure. Refuse the second dot at the keypress.
    if (cur.includes('.')) return cur
    if (cur.length + (cur === '' ? 2 : 1) > maxLen) return cur
    return cur === '' ? '0.' : cur + '.'
  }
  if (!/^[0-9]$/.test(key)) return cur
  if (cur.length >= maxLen) return cur
  // No leading-zero build-up: 0 then 5 is '5', not '05'. '0.' has already returned above.
  if (cur === '0') return key === '0' ? cur : key
  return cur + key
}

// A key that cannot change the value renders disabled — the second '.', any digit at the cap, and
// ⌫ on an empty field. Disabling rather than hiding keeps the pad's geometry fixed, which
// comboboxInput.js:138-144 requires of every tap target on this surface.
export function padKeyDisabled(value, key, opts = {}) {
  const cur = value == null ? '' : String(value)
  return appendDigit(cur, key, opts) === cur
}
