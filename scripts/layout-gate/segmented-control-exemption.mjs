// segmented-control-exemption.mjs — the ONE named exemption from the tap floor on the Seeds page,
// shared by gate:seeds-saved and gate:seeds-page so the two gates cannot disagree about it.
//
// WHAT IS EXEMPT, AND WHY IT IS NAMED RATHER THAN SILENT. SegmentedControl is a FROZEN primitive
// (src/components/forms/SegmentedControl.jsx) and draws every option as a <button role="radio"> at
// `minHeight: 40` — under T.tapMinHeight (44). The Seeds page renders one: the view switch ("My
// seeds · Saved seeds · Sow now"). (My seeds' sort was a second until it became a native select to
// fit the search line at 360px; its group left this list with it.) A census that
// counted them would red both gates on a primitive neither lane owns; a census that skipped radios
// wholesale would stop measuring every radio anyone adds later. So the exemption is a LIST OF GROUPS
// by data-testid, it applies only to a role=radio whose parent is that role=radiogroup, and the
// exempt radios still have a floor: the primitive's own minHeight, READ from its source rather than
// spelled here. Every exempt radio is printed with its height on every run.
//
// WHEN TO DELETE THIS: the day the primitive draws 44. The gates print "exemption inert" once every
// exempt radio clears the real floor, which is the signal to remove the group names below.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const SEGMENTED_CONTROL_GROUPS = Object.freeze(['seeds-view-switch'])

// Read, not spelled: a gate carrying its own copy of the primitive's floor keeps exempting 40px
// radios after someone shrinks the primitive to 32. Exactly one `minHeight: N` in the file is the
// shape measured on 2026-09-18; anything else means the primitive changed shape and this reading
// is no longer trustworthy, so it throws rather than guessing.
export function segmentedRadioFloorPx(root) {
  const src = readFileSync(resolve(root, 'src/components/forms/SegmentedControl.jsx'), 'utf8')
  const found = [...src.matchAll(/minHeight:\s*(\d+)/g)].map((m) => Number(m[1]))
  if (found.length !== 1) {
    throw new Error(`SegmentedControl.jsx carries ${found.length} minHeight literals (${found.join(', ') || 'none'}); expected exactly 1 — re-derive the named exemption in scripts/layout-gate/segmented-control-exemption.mjs`)
  }
  return found[0]
}

// `t` is a tap record carrying `role` and `group` (the parent radiogroup's data-testid, or null).
export const isExemptSegmentedRadio = (t) => t.role === 'radio' && SEGMENTED_CONTROL_GROUPS.includes(t.group)
