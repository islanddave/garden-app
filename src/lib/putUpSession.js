// putUpSession.js — V4-PUTUPSESSION-001 slice 0. The freezer walk: a retrospective put-up sitting.
//
// Pure string/array math plus two localStorage accessors, no React and no DOM layout, because the
// walk's LOGIC has to be falsifiable in jsdom even though its geometry is not (same split
// lib/numberPad.js states for the pad).
//
// WHY localStorage AND NOT draftStash.js (which is sessionStorage). draftStash's own header says a
// draft is "scoped to the tab/session, never resurrected weeks later", and that is RIGHT for the
// ordinary form. It is wrong for this: Dave answered the volume question with "sixty or more,
// several evenings", so the walk spans days by design, and he runs it as an installed PWA on
// Android where a backgrounded process can be discarded outright — taking sessionStorage with it.
// A walk that forgets which freezer you are standing at because a phone call came in is the failure
// that makes the feature get abandoned. So the walk keeps its OWN store, and draftStash is left
// alone rather than widened.
//
// What is stashed is deliberately thin: the two session answers, the crop you were on, and a count.
// Everything already saved is in the database (one POST per item, no batch), so the stash is not a
// queue and cannot lose data — it only restores your PLACE.

export const WALK_PARAM = 'putup'
const WALK_KEY = 'garden:putup-walk:v1'
const DISMISS_KEY = 'garden:putup-not-mine:v1'

// ── dates ───────────────────────────────────────────────────────────────────
// Local-time YYYY-MM-DD. Duplicated rather than imported from PutUp.jsx because a lib importing a
// page would invert the dependency direction every other module here holds to.
function pad(n) { return String(n).padStart(2, '0') }
function parseYmd(s) { return new Date(`${s}T00:00:00`) }

// Midpoint arithmetic runs in UTC, deliberately. These are CALENDAR spans, and a local-time span
// crossing the March DST boundary is 23 hours short — enough to slide the answer a whole day, which
// would make the same button resolve differently in March than in July for no reason a reader could
// ever guess. Display still parses local (parseYmd above), matching the rest of the page.
function utcMs(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
// The midpoint of a window, as a date string. A midpoint is the estimate with the smallest possible
// worst-case error for "somewhere in this window", which is the whole claim the coarse buttons make.
function midpoint(startYmd, endYmd) {
  const a = utcMs(startYmd)
  const b = utcMs(endYmd)
  if (!(b >= a)) return null
  const mid = new Date(a + Math.floor((b - a) / 2))
  return `${mid.getUTCFullYear()}-${pad(mid.getUTCMonth() + 1)}-${pad(mid.getUTCDate())}`
}

// The two coarse answers, resolved against TODAY so neither can ever propose a future date — the
// form's own `max={todayYMD()}` says a put-up cannot be in the future and this must agree with it.
// Returns null when the window has not opened yet (asking "this summer" in March), and the caller
// drops the choice rather than offering a button that resolves to a lie.
//
// `approx` rides alongside the date and is the POINT of this function. Dave accepted "my tomatoes,
// this summer" as a finished record with only the date marked approximate — so the walk has to be
// able to TELL an estimate from a date he actually picked. Slice 0 has no column to store it in
// (preserved_at_approx is slice 1) and does not send it; keeping the distinction in state anyway is
// what lets slice 1 be a one-line addition to the POST body instead of a redesign, and it is what
// lets the band say "around Jul 16" rather than presenting a guess as a fact.
export function coarseDate(choice, todayYmd) {
  const year = todayYmd.slice(0, 4)
  if (choice === 'summer') {
    const end = todayYmd < `${year}-08-31` ? todayYmd : `${year}-08-31`
    const date = midpoint(`${year}-06-01`, end)
    return date ? { date, approx: true } : null
  }
  if (choice === 'earlier') {
    const end = todayYmd < `${year}-05-31` ? todayYmd : `${year}-05-31`
    const date = midpoint(`${year}-01-01`, end)
    return date ? { date, approx: true } : null
  }
  return null
}

export function exactDate(ymd) {
  return ymd ? { date: ymd, approx: false } : null
}

// "around Jul 16" vs "Jul 16". ONE STRING, ONE PLACE — this is the only literal in the app that
// marks a date as an estimate, so the walk's band, the form, and a record read back out of the
// database cannot drift into saying it three different ways (or one of them not saying it at all).
//
// Slice 1 split the wording out of describeDate so the two READ surfaces can reach it without
// re-deriving a YYYY-MM-DD string. PutUp.jsx and PutUpFromPlanting.jsx each already own a prettyDate
// that copes with the neon driver handing dates back as JS Date objects; describeDate's parseYmd
// does not, and passing it a Date returns the Date itself, which React then refuses to render. So
// they format first and mark second. `approx === true` at every call site, never truthiness: the
// column is three-valued and NULL means "nobody was asked", which must read exactly as it does today.
export function describeApprox(pretty, approx) {
  return approx ? `around ${pretty}` : pretty
}
export function describeDate(date, approx) {
  if (!date) return ''
  const d = parseYmd(date)
  const pretty = isNaN(d.getTime())
    ? date
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return describeApprox(pretty, approx)
}

// ── auto-resolution (design §4.2 G2) ────────────────────────────────────────
// 18 of 31 harvested crops have exactly one planting, so for most of the freezer the app can name
// the plant with no input at all. It returns the planting only when there is EXACTLY one: two is a
// choice and the caller must ask.
export function plantingsForCrop(plants, cropSlug) {
  if (!Array.isArray(plants) || !cropSlug) return []
  // ARCHIVED PLANTINGS ARE EXCLUDED, and this is load-bearing rather than tidy. The picker
  // projection RETURNS archived_at rather than filtering in SQL, so every consumer filters it
  // itself — EventNew and VoiceHarvest.jsx:340 both do. Without it, a crop whose only planting is
  // archived would silently auto-attribute the put-up to it, and a crop with one live + one
  // archived would count 2 and decline to auto-resolve at all. Both are wrong, and the first is the
  // worse kind: a default the user is shown as a stated fact. Archive-Hiding Rule, and "a wrong
  // default launders a wrong decision".
  //
  // The picker query param is deliberately NOT spelled out above: the consumer census in
  // lambda/plants/grid-view.test.js greps that literal string across src/, so naming it in a comment
  // registers this file as a call site and reds the guard. Found exactly that way, 2026-08-31.
  return plants.filter(p => p?.variety_ref?.crop_type_slug === cropSlug && !p.archived_at)
}
export function solePlanting(plants, cropSlug) {
  const hits = plantingsForCrop(plants, cropSlug)
  return hits.length === 1 ? hits[0] : null
}

// ── "what haven't I put up?" (design §6 Q4) ─────────────────────────────────
// Crops picked this year with no put-up row, minus the ones Dave has said are not his to put up.
// The dismissal is the load-bearing half: most of what he grows is eaten fresh — "i pick watermelons
// for example but mostly eat them fresh, not freezing" — so without it this list would permanently
// accuse him of failing to record things he never intended to record, and it would grow all season.
// Dismissal means "not one I put up", not "done".
export function unrecordedCrops({ harvestCrops, putUpSlugs, dismissed }) {
  const put = new Set(putUpSlugs ?? [])
  const skip = new Set(dismissed ?? [])
  return (harvestCrops ?? [])
    .filter(c => c?.crop_type_slug && !put.has(c.crop_type_slug) && !skip.has(c.crop_type_slug))
    .map(c => ({ slug: c.crop_type_slug, name: c.crop_name || c.crop_type_slug }))
}

// ── stores ──────────────────────────────────────────────────────────────────
// Every accessor is try/catch'd and falls back to "no stash". localStorage throws in Safari private
// mode and when the quota is full, and a walk that white-screens because it could not remember a
// freezer is strictly worse than a walk that forgets one.
function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}
function writeJson(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* non-fatal */ }
}

export function readWalk() {
  const v = readJson(WALK_KEY)
  if (!v || v.v !== 1) return null
  if (!v.date) return null            // a stash with no date answer cannot skip the setup screen
  return v
}
export function writeWalk(walk) {
  writeJson(WALK_KEY, { v: 1, ...walk })
}
export function clearWalk() {
  try { window.localStorage.removeItem(WALK_KEY) } catch { /* non-fatal */ }
}

export function readDismissed() {
  const v = readJson(DISMISS_KEY)
  return Array.isArray(v?.slugs) ? v.slugs.filter(s => typeof s === 'string') : []
}
export function dismissCrop(slug) {
  if (!slug) return readDismissed()
  const next = [...new Set([...readDismissed(), slug])]
  writeJson(DISMISS_KEY, { v: 1, slugs: next })
  return next
}
