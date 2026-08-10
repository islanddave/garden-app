// src/components/forms/SelectChip.jsx
// Lane D / Phase D — shared selection "pill" chip. ONE selection grammar across the
// bulk-log surfaces: LogMany's event-type primaries AND ScopeChecklist's scope chips
// both render selection state through this single primitive (same active treatment,
// same touch target, same aria-pressed semantics). Lifted verbatim from LogMany's
// local Chip so the two stop drifting.
//
// NOT the EventTypePicker grid — that's a button-grid quick-picker, a different render
// tree, intentionally NOT unified under a mode= switch (plan §5 Phase D: "compose,
// don't overload"). This is the pill-chip grammar only.
import React from 'react'
import { P } from '../../lib/constants.js'

// `touch` (V4-HARVQTYCHIPS-001): opt-in 48x48 minimum for chips on a one-thumb fast path where the
// label is short enough that padding alone leaves an undersized target. Measured at 375px: a
// single-digit chip renders 37x40, under the 44-48px touch guidance, and the harvest quantity chips
// are tapped while holding produce. Default (undefined) is byte-identical to before, so LogMany and
// ScopeChecklist are untouched. Extending with a size prop is the sanctioned path per FROZEN.md
// ("extend one of these — new prop / tone / size") rather than adding a second chip primitive.
export default function SelectChip({ active, small, touch, onClick, children, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        minHeight: touch ? 48 : 40,
        // 44 not 48: measured at 375px, a 48px WIDTH floor wraps a 6-chip row onto two lines and
        // takes the block from 48px to 104px tall — which pushes the primary action toward the fold
        // on the very surface this exists to speed up. 48px HEIGHT is the dimension that carries
        // thumb accuracy; 44px width is the WCAG 2.5.5 floor. Callers laying these out in a grid
        // get more than 44 anyway (the harvest row renders 45.2px/chip in one line).
        minWidth: touch ? 44 : undefined,
        padding: small ? '6px 12px' : '8px 14px',
        borderRadius: 20,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: small ? '0.82rem' : '0.88rem',
        fontWeight: 600,
        border: `1px solid ${active ? P.green : P.border}`,
        backgroundColor: active ? P.green : P.white,
        color: active ? P.white : P.dark,
      }}
      {...rest}
    >
      {children}
    </button>
  )
}
