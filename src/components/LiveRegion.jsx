// LiveRegion.jsx — V4-HAPTICVOCAB-001. A polite status region that actually announces.
//
// WHY A COMPONENT AND NOT JSX-IN-PLACE. A live region created in the SAME COMMIT as its content is
// never spoken: TalkBack (and every other AT) watches an already-present region for MUTATIONS, so a
// region that arrives holding its own text arrives with nothing to observe. This app has already
// shipped that bug once — PlantingSelect.jsx:886-896 documents an `aria-live="polite"` that "could
// never announce anything" and was REMOVED rather than relocated, because a dead live region reads
// as coverage that does not exist. Packaging the mount-empty invariant as a component is what stops
// the third occurrence: there is no prop through which content can arrive at mount.
//
// The mechanism is the one already shipped and working in CareNeeded.jsx:383/531 — an empty div
// held by a ref, written imperatively. React NEVER owns this element's children. That is not a
// stylistic preference: React-owned children would be reconciled, and a re-render that produced the
// same string would produce no DOM mutation and therefore no announcement.
//
// WHAT IT IS FOR HERE. WCAG 2.2 SC 4.1.3 Status Messages (AA): a save result is a status message and
// on the weigh-in surface it is currently conveyed only visually. `PostSaveFeedback` cannot cover
// it — `showPostSaveStrip = inOverlay && !!confirmation` (EventNew.jsx:1652) and
// `inHarvestSession = harvestSessionParam && !inOverlay` (EventNew.jsx:535) are mutually exclusive
// on `inOverlay`, so that strip NEVER renders in a weigh-in session. Verified by reading both lines.
import { useCallback, useRef } from 'react'

// Same visually-hidden block CareNeeded.jsx:531 and PlantingDetail.jsx:1455 use. Hidden because the
// session strip ALREADY shows this information: the gap is the programmatic status channel, not the
// visual one, and a second visible copy would be redundant chrome on a 500px keyboard-open viewport.
const srOnly = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
}

// Returns { ref, announce }. Mount the ref on a <LiveRegion>, then call announce(text) from any
// handler. announce returns whether a region was actually present to write to — a mounted-in-the-
// wrong-branch region is otherwise a silent no-op, which is the failure mode this whole file is
// about.
export function useLiveRegion() {
  const ref = useRef(null)
  const announce = useCallback((message) => {
    const el = ref.current
    if (!el) return false
    // Node.textContent's setter removes every existing child and appends a FRESH Text node. That
    // matters for the repeat case: harvesting the same plant at the same weight twice in a row
    // produces an identical string, and a value-equality write (or React-owned children) would
    // produce no mutation and no second announcement. This always mutates.
    el.textContent = message == null ? '' : String(message)
    return true
  }, [])
  return { ref, announce }
}

// `regionRef` as an ordinary prop rather than forwardRef: ref-as-a-prop is React 19 behaviour and
// forwardRef is deprecated there, so an explicit prop is the one spelling that is correct on both
// sides of that line and needs no revisit at upgrade.
//
// NO `children`, NO content prop, and props are not spread — deliberately. Every route by which
// text could arrive at mount is the dead-region bug above, so none of them exists.
export default function LiveRegion({ regionRef, label, testId }) {
  return (
    <div
      ref={regionRef}
      role="status"
      aria-live="polite"
      // The save announcement is one sentence carrying five facts (plant, quantity, weight, session
      // count, running total). Atomic so a partial read can never hand back a number without the
      // noun it belongs to — on a surface whose whole purpose is recording the right weight, half a
      // sentence is worse than silence.
      aria-atomic="true"
      aria-label={label}
      data-testid={testId}
      style={srOnly}
    />
  )
}
