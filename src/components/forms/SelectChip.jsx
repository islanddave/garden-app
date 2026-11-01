// Shared selection "pill" chip: ONE selection grammar across the bulk-log surfaces (LogMany's
// event-type primaries and ScopeChecklist's scope chips: same active treatment, touch target and
// aria-pressed semantics). NOT the EventTypePicker grid, a button-grid quick-picker with a different
// render tree; this is the pill-chip grammar only.
import React from 'react'
import { P } from '../../lib/constants.js'
import { T } from './formStyles.js'

// `touch`: opt-in 48x48 minimum for chips on a one-thumb fast path where the label is short enough
// that padding alone leaves an undersized target (a single-digit chip renders 37x40 at 375px, and
// the harvest quantity chips are tapped while holding produce). Extending with a prop is the
// sanctioned path per FROZEN.md rather than adding a second chip primitive.
export default function SelectChip({ active, small, touch, onClick, children, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        minHeight: touch ? T.buttonMinHeight : T.chipMinHeight,
        // 44 not 48: a 48px WIDTH floor wraps a 6-chip row onto two lines at 375px (48px → 104px
        // tall), pushing the primary action toward the fold. 48px HEIGHT carries thumb accuracy;
        // 44px width is the WCAG 2.5.5 floor. Callers laying these out in a grid get more than 44
        // anyway.
        minWidth: touch ? 44 : undefined,
        padding: small ? T.chipPadSm : T.chipPadLg,
        borderRadius: T.radiusPill,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: small ? T.type.sm : T.type.sm2,
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
