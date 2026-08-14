import React from 'react'
import { P } from '../lib/constants.js'

// V4-EVENTSEL-005 — THE section card for the event-logging forms. Previously this same construct
// existed twice, verbatim-in-behavior: LogMany.jsx and EventNew.jsx each declared a private
// `Section`. V4-EVENTSEL-004 had already hand-matched them ("so the event selector looks IDENTICAL
// on both surfaces"), which is exactly the state that decays — two copies held in sync by comment.
//
// Deliberately NOT in `src/components/forms/`: that directory is freeze-gated
// (formsPrimitivesFreeze.test.js + FROZEN.md must move in the same change as any barrel export).
// This is layout chrome, not a form primitive, so it lives as a plain non-barrel module — the
// same call the GroupByControl sibling made. Promoting it into the frozen set later is a
// freeze-contract change and belongs in its own ticket.
//
// `style` exists for ONE reason: the two surfaces space their sections differently and correctly.
// EventNew's sections are flex children of a `gap: 16` <form>; LogMany's are loose children of a
// plain container and carry their own `marginBottom: 16`. Baking the margin in would double
// EventNew's spacing to 32px; dropping it would collapse LogMany's. The CARD is single-sourced,
// which is what the row asks for; the outer spacing stays the caller's business.
//
// The `label &&` guard is LogMany's (EventNew's copy was unguarded). Every call site on both
// surfaces passes a label today, so the guard is defensive only and preserves both behaviors.
export default function FormSection({ label, children, style }) {
  return (
    <div style={{
      backgroundColor: P.white, border: `1px solid ${P.border}`,
      borderRadius: 10, padding: '16px 18px',
      ...style,
    }}>
      {label && (
        <label style={{
          display: 'block', fontSize: '0.77rem', fontWeight: 700,
          color: P.mid, marginBottom: 10,
          letterSpacing: '0.4px', textTransform: 'uppercase',
        }}>
          {label}
        </label>
      )}
      {children}
    </div>
  )
}
