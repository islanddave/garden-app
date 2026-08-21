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
//   children     node    — EXACTLY ONE element child (input/select/textarea or a
//                          Phase A primitive). More than one → contract ERROR.
//
// The wrapper clones association + ARIA onto the single control child *unless the
// child already set that prop* (so a primitive passing its own aria-describedby
// wins). This is the InventoryAdd/ProjectNew cloneElement pattern, completed with
// the ARIA wiring the originals were missing (aria-invalid / aria-describedby /
// role="alert" error node) — see plan §0 condition 3.
//
// BUG-FIELDCHILDDROP-001 (fixed here). Until now the render DISCARDED every element
// child after the first: `{kids.slice(1).filter(k => !isValidElement(k))}` kept the
// strings and threw the elements away. The contract warning that accompanied it said
// "only the first gets the label id — wrap extras yourself", which reads as "the
// extras still render, just unlabelled". They did not render at all. Two shipped call
// sites (AddSeeds, InventoryAdd) lost a help <div> to this and nobody noticed, because
// no test renders either one. Two changes: nothing is dropped now, and the violation
// throws in dev/test instead of warning. See _contract.js §contractError.
import React from 'react'
import { labelChrome, requiredMarkChrome, optionalMarkChrome, helpChrome, errorChrome } from './formStyles.js'
import { contractError } from './_contract.js'

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

  // toArray already drops null/undefined/booleans, so `{cond && <X/>}` in its false
  // state is not a violation.
  const kids = React.Children.toArray(children)
  const elements = kids.filter(React.isValidElement)

  // toArray does NOT descend into a Fragment — it counts as one element — so the id and
  // ARIA cloned below land on the Fragment, where React drops every prop but `key` and
  // `children`. The control comes out unlabelled and `htmlFor` points at an id nothing
  // carries. Same silent class as the drop, and the old warning never fired for it.
  if (elements.length === 1 && elements[0].type === React.Fragment) {
    contractError('Field', 'received a Fragment as its only child. React.Children.toArray does not look inside a Fragment, so the label/ARIA wiring is cloned onto the Fragment and discarded — the control ends up unlabelled. Pass the control element directly; put help text in the `help` prop and anything else outside the Field.')
  }
  if (elements.length > 1) {
    const shapes = elements.map(el => (typeof el.type === 'string' ? `<${el.type}>` : `<${el.type?.displayName || el.type?.name || 'Component'}>`))
    contractError('Field', `expected exactly one element child (the control), received ${elements.length}: ${shapes.join(', ')}. Only the first is wired to the label. Move help text into the \`help\` prop — it renders under the control AND gets aria-describedby — or move the extra element outside the Field.`)
  }

  const describedBy = [help ? helpId : null, error ? errId : null].filter(Boolean).join(' ') || undefined

  // The control is the first ELEMENT child, not literally kids[0] — a leading string
  // would otherwise take the slot, get no id, and leave `htmlFor` dangling.
  const controlIndex = kids.findIndex(React.isValidElement)
  const renderedKids = kids.map((kid, i) => (
    i === controlIndex
      ? React.cloneElement(kid, {
          id: kid.props.id ?? fieldId,
          'aria-invalid': kid.props['aria-invalid'] ?? (error ? true : undefined),
          'aria-describedby': kid.props['aria-describedby'] ?? describedBy,
          'aria-required': kid.props['aria-required'] ?? (required || undefined),
        })
      : kid
  ))

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
      {renderedKids}
      {help && <div id={helpId} style={helpChrome}>{help}</div>}
      {error && (
        <div id={errId} role="alert" style={errorChrome}>
          <span aria-hidden="true">⚠</span> {error}
        </div>
      )}
    </div>
  )
}
