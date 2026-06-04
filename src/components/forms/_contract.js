// src/components/forms/_contract.js
// Dev/test-only prop-contract guard for the Phase A form primitives.
// Runs in dev + test (import.meta.env.MODE !== 'production'); a no-op in prod
// builds so it never throws inside a render path. The Phase A contract-conformance
// test asserts these warnings fire on violation (warn, not throw — a thrown error
// in render would take the whole form down; the contract is enforced by review +
// this signal, not by crashing Jen's screen).
export function contractWarn(component, message) {
  const mode =
    (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.MODE) ||
    (typeof process !== 'undefined' && process.env && process.env.NODE_ENV) ||
    'development'
  if (mode === 'production') return
  // eslint-disable-next-line no-console
  console.warn(`[forms contract] ${component}: ${message}`)
}
