// src/components/forms/Field.jsx
// ────────────────────────────────────────────────────────────────────────────
// Lane D / Phase A — canonical labelled-field wrapper.
//
// Frozen prop contract (forms-consolidation-plan-V002 §5 Phase A):
//   label        node    — visible label text/markup (required)
//   htmlFor / id string  — explicit control id (PREFERRED — drift-resistant);
//                          falls back to a useId() if omitted (ProjectNew pattern)
//   error        string  — error message; when truthy the wrapper renders an
//                          id'd role="alert" node and wires the control to it
//   errorId      string  — id for the error node; defaults to `${id}-error`
//   required     bool    — shows the required asterisk + sets aria-required
//   optional     bool    — shows an "optional" affordance (ADHD: never make the
//                          user submit-to-discover which fields are optional)
//   help         node    — help text rendered under the control, id-associated
//   children     node    — EXACTLY ONE focusable control (input/select/textarea
//                          or a Phase A primitive). More than one → contract warn.
//
// The wrapper clones association + ARIA onto the single control child *unless the
// child already set that prop* (so a primitive passing its own aria-describedby
// wins). This is the InventoryAdd/ProjectNew cloneElement pattern, completed with
// the ARIA wiring the originals were missing (aria-invalid / aria-describedby /
// role="alert" error node) — see plan §0 condition 3.
import React from 'react'
import { labelChrome, requiredMarkChrome, optionalMarkChrome, helpChrome, errorChrome } from './formStyles.js'
import { contractWarn } from './_contract.js'

let _seq = 0
function useFallbackId() {
  // React.useId when available (React 18); deterministic fallback otherwise.
  if (typeof React.useId === 'function') return React.useId()
  const ref = React.useRef(null)
  if (ref.current == null) ref.current = `field-${++_seq}`
  return ref.current
}

export default function Field({
  label,
  htmlFor,
  id,
  error,
  errorId,
  required = false,
  optional = false,
  help,
  children,
  style,
  ...rest
}) {
  const auto = useFallbackId()
  const fieldId = id ?? htmlFor ?? auto
  const errId = errorId ?? `${fieldId}-error`
  const helpId = `${fieldId}-help`

  const kids = React.Children.toArray(children)
  const focusable = kids.filter(React.isValidElement)
  if (focusable.length > 1) {
    contractWarn('Field', `expected exactly one focusable child, received ${focusable.length}. Only the first gets the label id — wrap extras yourself.`)
  }

  const describedBy = [help ? helpId : null, error ? errId : null].filter(Boolean).join(' ') || undefined

  const controlChild = React.isValidElement(kids[0])
    ? React.cloneElement(kids[0], {
        id: kids[0].props.id ?? fieldId,
        'aria-invalid': kids[0].props['aria-invalid'] ?? (error ? true : undefined),
        'aria-describedby': kids[0].props['aria-describedby'] ?? describedBy,
        'aria-required': kids[0].props['aria-required'] ?? (required || undefined),
      })
    : kids[0]

  return (
    <div style={{ marginBottom: 0, ...style }} {...rest}>
      {label != null && (
        <label htmlFor={fieldId} style={labelChrome}>
          {label}
          {required && <span style={requiredMarkChrome} aria-hidden="true">*</span>}
          {required && <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>(required)</span>}
          {optional && !required && <span style={optionalMarkChrome}>optional</span>}
        </label>
      )}
      {controlChild}
      {kids.slice(1).filter(k => !React.isValidElement(k))}
      {help && <div id={helpId} style={helpChrome}>{help}</div>}
      {error && (
        <div id={errId} role="alert" style={errorChrome}>
          <span aria-hidden="true">⚠</span> {error}
        </div>
      )}
    </div>
  )
}
