// src/components/forms/_contract.js
// Dev/test-only prop-contract guard for the Phase A form primitives.
// Runs in dev + test (import.meta.env.MODE !== 'production'); a no-op in prod
// builds so it never throws inside a render path. The Phase A contract-conformance
// test asserts these warnings fire on violation (warn, not throw — a thrown error
// in render would take the whole form down; the contract is enforced by review +
// this signal, not by crashing Jen's screen).
function currentMode() {
  return (
    (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.MODE) ||
    (typeof process !== 'undefined' && process.env && process.env.NODE_ENV) ||
    'development'
  )
}

export function contractWarn(component, message) {
  if (currentMode() === 'production') return
  // eslint-disable-next-line no-console
  console.warn(`[forms contract] ${component}: ${message}`)
}

// BUG-FIELDCHILDDROP-001. The stronger tier, for a violation whose consequence is
// SILENT AND DESTRUCTIVE rather than merely sloppy — a child that disappears from the
// render, or a label wired to an id no element carries. `contractWarn` is the right
// signal for "this is not how the primitive is meant to be used"; it is the wrong one
// for "the code you wrote is not the code that runs", because a console.warn buried in
// dev-server output is indistinguishable from nothing. Two Field call sites shipped a
// help <div> that no user has ever seen, each with this warning firing the whole time.
//
// Prod keeps the crashing-Jen's-screen rule above: no throw, no console noise. The
// CALLER must degrade without losing anything (Field renders every child either way),
// so the prod path is a safety net for a violation dev already made unmissable.
export function contractError(component, message) {
  const msg = `[forms contract] ${component}: ${message}`
  if (currentMode() === 'production') return
  throw new Error(msg)
}
