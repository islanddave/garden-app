// src/components/putup/origin.js
// Put-Up UX pass R1 (prep) — WHERE A PUT-UP MODE WAS OPENED FROM, the pure half.
//
// A surface that opens batch detail, recipe detail or the closed list names itself on the pushed entry's
// router state as `from`, so the mode's in-page Back can say "← Pantry" and go back there. The page
// (PutUp.jsx) does every push; a sender (a Pantry row, a closed row, a recipe, the planting page) only hands
// a From to a callback.
//
// A From is { label: string, kind?: 'recipe' | 'batch', id?: string }.
//
// history.state outlives a reload AND a deploy (src/lib/putUpClientState.js records the same hazard for
// params and drafts), so a From is VALIDATED ON READ, every time, and never trusted as it was stored.
//
// PURE: no React, no router, no window.
import { CONTINUES_ENTRY_KEY } from '../../lib/pageEntry.js'
import { FIND_PARAM } from '../../lib/putUpClientState.js'

// A plain object in ANY realm: its prototype is null or a root prototype. An array, a Date, a Map and a
// class instance are not.
function isPlain(v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === null || Object.getPrototypeOf(proto) === null
}

// The origin on a router state, or null. Never throws. null unless state.from is a plain object whose
// label is a non-blank string (returned trimmed). kind is kept only if 'recipe' or 'batch'; id only if a
// string or a number (returned as a string). Every other key on it is dropped, and what comes back is a
// new object, never the stored one.
export function readFrom(state) {
  try {
    const from = state == null ? null : state.from
    if (!isPlain(from)) return null
    const label = typeof from.label === 'string' ? from.label.trim() : ''
    if (!label) return null
    const out = { label }
    if (from.kind === 'recipe' || from.kind === 'batch') out.kind = from.kind
    if (typeof from.id === 'string' || typeof from.id === 'number') out.id = String(from.id)
    return out
  } catch {
    return null
  }
}

// The `state` option for a PUSH into a Put-Up mode.
//   · never mutates `state`; copies its own keys when it is a plain object, else starts empty
//   · ALWAYS removes an inherited `from`, then sets `from` only when the one handed in reads as a From
//     (and sets the validated copy) — so a push that names no origin cannot carry the last entry's
//   · removes the page-entry stamp (pageEntry.js CONTINUES_ENTRY_KEY): it names the entry being LEFT, and
//     a pushed entry that kept it would answer to the list's scroll identity instead of its own
//   · keeps every other key as it is, same references: an overlay's `background` (with its
//     historyEntry), `prefill`, and any key this file has never heard of
//   · returns null, not {}, when nothing is left
// A sender on ANOTHER route (the planting page) calls withFrom(null, from): it never spreads its own
// route's state into /put-up.
export function withFrom(state, from) {
  const out = isPlain(state) ? { ...state } : {}
  delete out.from
  delete out[CONTINUES_ENTRY_KEY]
  const origin = readFrom({ from })
  if (origin) out.from = origin
  return Object.keys(out).length ? out : null
}

// The words after the arrow; the page prints "← " once, in its own JSX. `fallback` is the label of the
// segment the page shows when it leaves the mode by its own push.
export function backLabel(state, fallback) {
  const from = readFrom(state)
  if (!from) return fallback
  return from.label + (from.kind === 'recipe' ? ' (recipe)' : from.kind === 'batch' ? ' (batch)' : '')
}

// ONE MODE KEY PER URL. A copy of `params` (a URLSearchParams, not mutated) with the three mode keys and
// the page search removed, then exactly one mode set: `{ batch: id }` → batch=<id>, `{ recipe: id }` →
// recipe=<id>, `{ state: 'closed' }` → state=closed. null sets none. Every other param stays.
// A mode object naming more than one is read in the page's own order (batch, then recipe, then state);
// an id that is not a non-empty string or a number names nothing.
const idText = (v) => ((typeof v === 'string' && v !== '') || typeof v === 'number' ? String(v) : null)
export function modeSearch(params, mode) {
  const next = new URLSearchParams(params)
  for (const k of ['batch', 'recipe', 'state', FIND_PARAM]) next.delete(k)
  const batch = idText(mode?.batch)
  const recipe = idText(mode?.recipe)
  if (batch != null) next.set('batch', batch)
  else if (recipe != null) next.set('recipe', recipe)
  else if (mode?.state === 'closed') next.set('state', 'closed')
  return next
}
