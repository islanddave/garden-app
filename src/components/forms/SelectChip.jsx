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

export default function SelectChip({ active, small, onClick, children, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        minHeight: 40,
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
