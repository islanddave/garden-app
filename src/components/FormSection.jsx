import React from 'react'
import { P } from '../lib/constants.js'

// V4-EVENTSEL-005 — THE section card for the event-logging forms, shared by LogMany.jsx and
// EventNew.jsx so the event selector looks IDENTICAL on both surfaces without two copies held in
// sync by comment.
//
// Deliberately NOT in `src/components/forms/`: that directory is freeze-gated
// (formsPrimitivesFreeze.test.js + FROZEN.md must move in the same change as any barrel export).
// This is layout chrome, not a form primitive, so it is a plain non-barrel module, like the
// GroupByControl sibling. Promoting it into the frozen set is a freeze-contract change and belongs
// in its own ticket.
//
// `style` exists for ONE reason: the two surfaces space their sections differently and correctly.
// EventNew's sections are flex children of a `gap: 16` form; LogMany's are loose children of a
// plain container and carry their own `marginBottom: 16`. Baking the margin in would double
// EventNew's spacing to 32px; dropping it would collapse LogMany's. The CARD is single-sourced,
// which is what the row asks for; the outer spacing stays the caller's business.
//
// The `label &&` guard is defensive only: every call site passes a label today.
// `id` is an optional DOM handle for scroll anchoring (V4-HARVSCROLLANCHOR-001 /
// V4-HARVPOSTSAVESCROLL-001). An id rather than a forwarded ref deliberately: these sections are
// declared as plain consts far from the effects that scroll to them, so a ref would have to be
// threaded through the block-building code, and the card stays a plain function component.
export default function FormSection({ label, children, style, id }) {
  return (
    <div id={id} style={{
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
