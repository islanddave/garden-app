// src/lib/seedsRoutes.js — V5-SEEDSTAB-001. The ONE spelling of every URL into the Seeds page.
//
// WHY A MODULE AND NOT CONSTANTS ON THE PAGE. Before this, /sow and /seeds/saved were hand-typed in
// twelve places across seven files and the add-a-packet URL was spelled three different ways.
// Retargeting each of those to a hand-written '/seeds?view=…' would have scattered them again on the
// day they were consolidated. Every door, both legacy redirects and the page itself build their URLs
// here. HarvestLog.jsx exports its path constants from the page, which works there because nothing
// in the shell imports it; this one is imported by BottomNav, Today's lead, SaveSeedSheet and the
// inventory pages, so it is a LEAF (no React, no page import) to keep the Seeds page out of their
// modules.

export const SEEDS_PATH = '/seeds'

// Lifecycle order, which is also the order of the view switch: acquire it, save your own, sow it —
// the order Inventory's seed chips already used. "Saved seeds" and "Sow now" are Dave's own names for
// the two pages this replaces; "My seeds" is ours for his "inventory seeds".
export const SEEDS_VIEWS = [
  { value: 'mine',  label: 'My seeds' },
  { value: 'saved', label: 'Saved seeds' },
  { value: 'sow',   label: 'Sow now' },
]

// EXACT and case-sensitive. Missing, empty, 'Saved' or 'garbage' are all null, which the page reads
// as "no door named a view" and settles by its default rule — a typo in a stale link must still land
// on a working page, never on a blank one. URLSearchParams.get returns the FIRST value, so
// `?view=sow&view=mine` is sow.
export function resolveView(raw) {
  return SEEDS_VIEWS.some(v => v.value === raw) ? raw : null
}

// `lot` names one seed lot the view should bring into sight and outline once (Saved seeds on a
// freshly-tracked lot, the ferment line, a lot's detail page). It is a one-shot arrival hint, never
// state the page writes back.
export function seedsHref(view, { lot } = {}) {
  const p = new URLSearchParams()
  if (resolveView(view)) p.set('view', view)
  if (lot != null && lot !== '') p.set('lot', String(lot))
  const s = p.toString()
  return s ? `${SEEDS_PATH}?${s}` : SEEDS_PATH
}

// The add form in seed mode, returning to `returnTo`. URLSearchParams encodes the return target
// whole (`%2Fseeds%3Fview%3Dmine`), so a `&` inside it can never cut it short. InventoryAdd's
// safeReturnTo still validates it on the way out — a URL is user-editable input either way.
export function addPacketHref(returnTo = seedsHref('mine')) {
  const p = new URLSearchParams({ type: 'consumable', category: 'seeds', return: returnTo })
  return `/inventory/add?${p.toString()}`
}

// location.state a Seeds door attaches when it PUSHES a page. The pushed page reads it to leave
// with navigate(-1) instead of pushing Seeds again, which is what keeps "N adds, then one Back"
// leaving the Seeds page rather than walking back through N copies of it.
export const SEEDS_RETURN_KEY = 'seedsReturn'

export function seedsReturnState(returnTo) {
  return { [SEEDS_RETURN_KEY]: returnTo }
}

// The Seeds URL the page underneath this one is showing, or null when a Seeds door did not push
// this page (a bookmark, Search, the general Inventory list, a reload that dropped state).
export function seedsReturnOf(state) {
  const v = state && state[SEEDS_RETURN_KEY]
  return typeof v === 'string' && v.startsWith(SEEDS_PATH) ? v : null
}

// The same answer read straight off the history entry, where BrowserRouter keeps location.state
// ({usr, key, idx}). For pages whose suites stub the router without useLocation — the value read is
// the one react-router wrote, as useScrollRestore also relies on. Read it once, at mount: it describes
// the entry the page arrived on.
export function seedsReturnFromHistory() {
  try { return seedsReturnOf(window.history?.state?.usr) } catch { return null }
}

// The add form leaves with navigate(-1), which can carry nothing back — so the id of the row it just
// created rides in sessionStorage, and the Seeds page takes it (once) on the way in and outlines that
// row. Best-effort by design: a lost note costs an outline, never a row.
const ADDED_KEY = 'seeds.justAdded.v1'

export function noteSeedAdded(id) {
  if (id == null) return
  try { window.sessionStorage.setItem(ADDED_KEY, String(id)) } catch { /* private mode */ }
}

// Read and clear are separate on purpose: the page reads in a state initialiser, which StrictMode
// runs twice, and a read that also cleared would hand the second run nothing.
export function peekSeedAdded() {
  try { return window.sessionStorage.getItem(ADDED_KEY) || null } catch { return null }
}

export function clearSeedAdded() {
  try { window.sessionStorage.removeItem(ADDED_KEY) } catch { /* private mode */ }
}
