// src/pages/PutUp.jsx
// V4-HARVESTCENTER-001 "Put-Up" — what is put up, what is on the go, and the recipes.
// Route-backed, overlayable (App.jsx renderRoutes, path /put-up); when the OVERLAY flag is on it opens
// as a Sheet flyover (OverlayHost) and when off it renders full-page — byte-identical route element.
//
// THREE segments behind one segmented control (goingNow.js PUT_UP_SEGMENTS):
//   'going'   — the batches in progress (GoingNowView).
//   'pantry'  — everything put up or bought, one list over GET /api/pantry (PantryView); a row opens its
//               sheet, and a jar's Edit there is RowEditor, at the foot of this file.
//   'recipes' — the recipes (RecipesView).
// and three MODES that replace the segments, each a search param on this same route: a batch (?batch=),
// a recipe (?recipe=) and the closed batches (?state=closed). The walk (?session=putup) is a fourth.
//
// THE ONE WAY TO PUT SOMETHING UP is the Put something up door (components/pantry/PutSomethingUpSheet.jsx),
// opened from the header's filled button. The "Log a put-up" form that used to be a fourth segment here was
// retired in Put-Up R2b (V5-PUTUPLOGRETIRE-001) with its harvest picker, its photo field and its place
// manager. Three things outlive it on a phone, and this page deals with each: an entry whose router state
// still carries what the form was opened with (never read: it is a bare open), an origin that names the
// form's segment (it stands for the Pantry: goingNow.js), and the form's draft (cleared at mount: DRAFT_KEY).
// The server still accepts the form's create body, because a bundle cached on a phone can still send it.
//
// Rules honored: Reward-UX (cadence-utility, no streak/celebration/interrupt); Soft-Delete (deleted
// rows vanish from the read surface — the Lambda filters deleted_at IS NULL, we just refetch);
// Cross-Device (all state server-side).
import React, { useState, useEffect, useCallback, useMemo, useId, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { T } from '../lib/tokens.js'
import { Field, Input, Select, Textarea, Button, SegmentedControl } from '../components/forms'
// V4-RELOADGATEWIRE-001 — the jar's Edit holds a deploy's reload while it is dirty or saving (reloadGate).
// The retired "Log a put-up" form's sessionStorage draft is only ever CLEARED here (see DRAFT_KEY).
import { clearDraft } from '../lib/draftStash.js'
import { setReloadBlocked } from '../lib/reloadGate.js'
import { useInOverlaySurface } from '../context/OverlayContext.jsx'
import { useAuthOptional } from '../context/AuthContext.jsx'
// V5-INFLIGHTBATCH-001 slice "going now" — a THIRD view behind the same segmented toggle. Same
// reason ?session=putup is a mode flag rather than a page: the app has a three-times-repeated
// pattern for "a thing you are in the middle of" and it is never a new destination.
import GoingNowView from '../components/putup/GoingNowView.jsx'
import BatchDetailView from '../components/putup/BatchDetailView.jsx'
import ClosedBatchesView from '../components/putup/ClosedBatchesView.jsx'
import RecipesView from '../components/recipes/RecipesView.jsx'
// V4-PUTUPSESSION-001 — the walk is a MODE FLAG on this page (?session=putup), not a new page.
import { WALK_PARAM } from '../lib/putUpSession.js'
// Put-Up release 1a (V4 §6.5) — every write on this page reads the server's `code` and says why it
// was refused; client_stale is answered with a user-tapped "Refresh now", never a reload by itself.
import { REFRESH_NOW_LABEL } from '../lib/putUpErrors.js'
import { useAppUpdate } from '../hooks/useAppUpdate.js'
// Put-Up release 1b — a jar's name, its no-size form, its date at its precision and its discard words
// come from one module shared with Put it up and batch detail; a move is its own write (V4 §3.4).
import { qtyText } from '../components/putup/jarWords.js'
// Put-Up B′ release 2 (V4 §2.2, §2.5, §6.1) — the Pantry, its page search, the Put something up door,
// the generalised walk and the rename bridge live in components/pantry/, each its own module.
import PantryView, { usePantryList, useBatchNames } from '../components/pantry/PantryView.jsx'
import PantrySearchResults, { PantrySearchBox } from '../components/pantry/PantrySearch.jsx'
import PutSomethingUpSheet from '../components/pantry/PutSomethingUpSheet.jsx'
import WalkPlace, { WALK_TITLE } from '../components/pantry/WalkPlace.jsx'
import { USE_SOON_FILTER } from '../components/pantry/pantryRows.js'
import { DOOR_CTA, completionWords } from '../components/pantry/putSomethingUp.js'
import { noteBridgeVisit, dismissBridge } from '../components/pantry/pantryBridge.js'
import { FIND_PARAM } from '../lib/putUpClientState.js'
// Put-Up UX pass R1 — every door into a mode goes through ONE opener on this page, and a mode's Back says
// where it lands. The pure halves are not written here: origin.js (the state a push rides on, the one-mode-key
// URL) and the foot of goingNow.js (pop or push, the Back's words, the segments).
import { withFrom, modeSearch } from '../components/putup/origin.js'
import {
  START_BATCH_CTA, PUT_UP_SEGMENTS, leaveSegment, segmentLabel, segmentOrigin, originSegment, leavePlan, popLanding,
  backWords, recipeSearchItems,
} from '../components/putup/goingNow.js'
import { readMarker } from '../lib/backNav.js'
// Put-Up R2a — the jar's Edit (RowEditor) says what the door says: the door's own method words, under an
// alias because this file's METHOD_LABELS was the retired log form's and its text is frozen (a parity
// test reads METHOD_GROUPS through METHOD_LABELS as written).
import { METHOD_LABELS as JAR_METHOD_LABELS, DISCARD_LABELS } from '../components/putup/putItUp.js'
import { USE_BY_METHODS } from '../components/putup/jarWords.js'
import { DISCARD_DATE_TEXT } from '../components/pantry/putSomethingUp.js'
import { HOUSE_DETAIL_TEXT } from '../components/pantry/PantryRowSheet.jsx'
import SelectChip from '../components/forms/SelectChip.jsx'
import { labelChrome } from '../components/forms/formStyles.js'
import WhereFromField, { whereFromError } from '../components/pantry/WhereFromField.jsx'

// ── Vocabulary (mirrors lambda/preservation VALID_METHODS + lambda/storage-location VALID_KINDS) ──
// Grouped for the picker; the canning SAFETY split (water-bath = high-acid, pressure = low-acid) is
// made legible at log time (L5) — full guidance deferred to the crop guides.
const METHOD_GROUPS = [
  { group: 'Freeze', options: [
    { value: 'whole_freeze',  label: 'Freeze (raw / whole)' },
    { value: 'blanch_freeze', label: 'Blanch & freeze' },
    { value: 'roast_freeze',  label: 'Roast & freeze' },
  ] },
  { group: 'Dry', options: [
    { value: 'dehydrate', label: 'Dehydrate' },
    { value: 'powder',    label: 'Powder' },
  ] },
  { group: 'Cook down / can', options: [
    { value: 'passata',        label: 'Passata / sauce' },
    // V4-PUTUPTAXONOMY-001 (BD-034). Dave named pesto as a gap and said it "arguably fits sauce but
    // really does not" — 2 of 5 live rows are pesto filed as passata, so the mis-fit is measurable
    // and not just felt. hot_sauce sits here rather than under Store because the making of it is a
    // cook-down, even when it starts as a ferment.
    { value: 'pesto',          label: 'Pesto' },
    { value: 'hot_sauce',      label: 'Hot sauce' },
    { value: 'can_water_bath', label: 'Water-bath can (high-acid)' },
    { value: 'can_pressure',   label: 'Pressure can (low-acid)' },
    { value: 'jam_preserve',   label: 'Jam / preserve' },
    // V5-PUTUPCANDY-001. Beside jam because both preserve in sugar and a candying batch is a staged
    // syrup cook. Its shelf life is the one figure in this vocabulary with no published source, so
    // picking it reveals the provenance note below — see HOUSE_SOURCED_SHELF_LIFE.
    { value: 'candy',          label: 'Candied' },
    // Vinegar pickling: not a ferment (no culture), and a fridge pickle is never processed. This
    // was the only method='other' row in prod ('Vinegar dill pickles').
    { value: 'quick_pickle',   label: 'Quick / vinegar pickle' },
  ] },
  { group: 'Store', options: [
    { value: 'ferment',    label: 'Ferment' },
    // Named by Dave, who was not confident plain `ferment` covered it. Labelled by what it IS
    // rather than by the jargon — "mash" will not read back in six months.
    { value: 'ferment_mash', label: 'Fermenting mash (unfinished)' },
    { value: 'cure_store', label: 'Cure & store' },
    { value: 'cold_store', label: 'Cold store (root cellar)' },
    // D6 (V4-PUTUPPROV-001): bought already preserved. Every other value names something you DID;
    // this one records that you did nothing because it arrived preserved. Without it, store-bought
    // frozen fruit could only be logged as 'other', which would make that value mean two things.
    { value: 'purchased_preserved', label: 'Bought already preserved' },
    { value: 'other',      label: 'Other…' },
  ] },
]
const METHOD_LABELS = Object.fromEntries(METHOD_GROUPS.flatMap(g => g.options).map(o => [o.value, o.label]))

// ── V5-PUTUPCANDY-001 — methods whose use-by comes from the HOUSE, not from published guidance. ──
// The client half of lambda/preservation/index.js's HOUSE_SOURCED_SHELF_LIFE; the two are separate
// deploy artifacts and cannot import each other, so putUpMethodParity.test.js binds them.
// FOODSAFETY-RULING-V101 §8.2 is why this exists as a set rather than as a comment: a house-sourced
// shelf life is either DISTINGUISHABLE ON THE SURFACE — a provenance line the user can see — or it
// takes `default: null`. The number reaches every viewer as a date and a warn-coloured chip, and a
// second person in the household has no way to learn that a migration header exists. Anything added
// to the Lambda's list must appear here too, or the parity test fails and the chip goes back to
// being an unattributed assessment.
const HOUSE_SOURCED_SHELF_LIFE = new Set(['candy'])

// Curated unit pick-list (L5) — free-text units make "how many quarts left" un-queryable. Weight /
// count / volume / container classes. Grouped views list per-record units and never sum across them.
// V4-PUTUPPROV-003: the Bulk group exists because provenance made bought produce loggable, and
// bought produce does not arrive in cups. Orchards and farm stands sell by the bushel, half-bushel,
// peck and flat — an apple bushel is ~42 lb, a peach bushel ~48-50 lb, a peck of apples ~10-12 lb.
// Without these you guess-convert to pounds at entry time and permanently degrade the quantity data
// on exactly the purchases this feature was built to record. The conversions are deliberately NOT
// applied automatically: a bushel is a volume measure and its weight varies by fruit, so silently
// storing an inferred poundage would be writing a guess into a column the UI shows as fact.
//
// quantity_unit IS bounded: by JAR_UNITS (lambda/preservation/jarRules.js) and chk_preservation_log_quantity_unit (v5-putupmake-001), the same 35 values.
// Read by the jar's Edit (RowEditor) alone now. It was exported for the harvest-to-put-up unit mapping's
// test (putUpPrefill, retired with the "Log a put-up" form in R2b); nothing imports it.
//
// V4-GRAMSUNIVERSAL-001 — 'g' and 'kg' added, leading the Weight group. This was the ONE surface in
// the app where a weight could not be entered in grams: harvest weights are stored, computed and
// displayed in grams throughout (harvest_log.weight_grams via formatGrams), and Put-Up offered lbs
// and oz and nothing else. Grams lead because grams are the house unit; lbs and oz stay because
// Dave's kitchen scale reads them and this list is what he picks from, not what gets stored.
//
// SINGULAR 'g'/'kg', against this list's plural house style ('lbs','cups'), deliberately: they match
// harvest_log.unit's CHECK vocabulary exactly. Matching the SOURCE vocabulary is worth more than
// matching the local plural.
//
// A NEW UNIT HERE NEEDS A MIGRATION FIRST: widen that CHECK and JAR_UNITS, deployed before this list offers it (inventory_items.unit has its own 11-value CHECK).
export const UNIT_GROUPS = [
  { group: 'Weight',     options: ['g', 'kg', 'lbs', 'oz'] },
  { group: 'Count',      options: ['count'] },
  { group: 'Volume',     options: ['cups', 'pints', 'quarts'] },
  { group: 'Bulk',       options: ['bushels', 'half-bushels', 'pecks', 'flats'] },
  { group: 'Containers', options: ['jars', 'bags'] },
]

// Local-time YYYY-MM-DD (toISOString would shift behind-UTC offsets a day). Accepts a Date, an ISO
// string, or a YYYY-MM-DD — the neon driver hands dates back as JS Date objects on the read surface.
function ymd(v) {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(typeof v === 'string' && v.length === 10 ? v + 'T00:00:00' : v)
  if (isNaN(d.getTime())) return typeof v === 'string' ? v.slice(0, 10) : ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// V4-RELOADGATEWIRE-001 — the draftStash route key of the "Log a put-up" form. RETIRED with the form
// (Put-Up R2b) and KEPT, spelled as it is stored: nothing reads or writes a draft under it any more, and
// the page clears it once at mount so a half-typed entry left on a phone does not sit there for good.
// Do not rename it — a renamed key would clear nothing and orphan every draft already in sessionStorage.
const DRAFT_KEY = 'put-up'

// BUG-GOINGNOWENVELOPE-001 — THE WIRE SHAPE, in one place, for every kitchen-batch LIST read.
//
// GET /api/kitchen-batches?state=… returns `{ state, batches }` (kitchenRoutes.js:172) and apiFetch
// hands the parsed body back verbatim (api.js:152-160). This page shipped `Array.isArray(rows) ? rows
// : []`, and an object is not an array, so `going` was set to [] on EVERY load: the segment rendered
// "Nothing going right now." forever and the bare-open promote below could never fire. The entire
// feature was inert in production. It was invisible because the client test fixture INVENTED a bare
// array while the Lambda test asserted the envelope — both sides green, disagreeing about the wire.
//
// The bare-array arm is kept deliberately, matching src/lib/batches.js:38, which already defends
// against exactly this shape on the unrelated event_log batch concept: coercing an unrecognised
// payload straight to [] is what silently disabled the feature instead of failing loudly, and a
// second route returning the bare form later would do it again. Anything else — null, a 500 body,
// a string — still yields [], which is what keeps the route-unavailable case (see `going` below)
// behaving exactly as it does today.
export function batchRows(payload) {
  return Array.isArray(payload) ? payload : (Array.isArray(payload?.batches) ? payload.batches : [])
}

// ── Put-Up release 1a — the shared Start sheet (V4 §2.2 "Start a batch", §10.1) ──────────────────
// The sheet is the batch lane's file and lands in its own merge; its contract is
// `{ open, onClose, onStarted(batch) }`, default or named `StartBatchSheet` export. GLOBBED rather than
// imported so this page builds and ships with or without it: no match is `{}`, the resolved component
// is null, and GoingNowView is handed no onStartBatch — its shipped door stays exactly as it is. When
// the file lands, this same line picks it up with no edit here. The literal path is bound to the
// contract by PutUp.startBatch.test.jsx, because a typo here would fail silently: a glob that matches
// nothing is not an error.
const START_BATCH_SHEET_MODULES = import.meta.glob('../components/kitchen/StartBatchSheet.jsx', { eager: true })
export function pickStartBatchSheet(modules) {
  for (const m of Object.values(modules ?? {})) {
    const c = m?.StartBatchSheet ?? m?.default
    if (c) return c
  }
  return null
}
export const StartBatchSheetImpl = pickStartBatchSheet(START_BATCH_SHEET_MODULES)

// Put-Up B′ — "How it was made →" (V4 §2.2, release 3) is the batch-builder lane's sheet, and its seam is
// `useHowItWasMade({ onSaved })` → `{ open(rowOrJar), sheet }` (+ `canSayHowItWasMade(jar)`), exported from
// components/putup/HowItWasMadeSheet.jsx. Globbed exactly like the Start sheet above, so this page builds
// with or without that file: without it there is no seam and no "How it was made →" anywhere; with it,
// the Pantry row sheet and the Put something up completion offer the door for a batchless put-up. The
// module is chosen once per build, so the hook below is always the same hook (rules of hooks hold).
// `howItWasMade` is also a PutUp prop so a test can hand in a stand-in.
const HOW_IT_WAS_MADE_MODULES = import.meta.glob('../components/putup/HowItWasMadeSheet.jsx', { eager: true })
export function pickHowItWasMade(modules) {
  for (const m of Object.values(modules ?? {})) {
    if (typeof m?.useHowItWasMade === 'function') {
      return { useHowItWasMade: m.useHowItWasMade, canSay: typeof m.canSayHowItWasMade === 'function' ? m.canSayHowItWasMade : null }
    }
  }
  return null
}
export const HowItWasMadeImpl = pickHowItWasMade(HOW_IT_WAS_MADE_MODULES)
const NO_HOW = { open: null, sheet: null }
function useNoHowItWasMade() { return NO_HOW }
// A Pantry row can say how it was made when it is a put-up with no batch yet (and the seam agrees).
function howRowCheck(seam) {
  return (row) => !!row && row.stock_kind === 'put_up' && row.batch_id == null
    && (!seam?.canSay || seam.canSay({ id: row.stock_id, batch_id: null, harvest_log_id: null, deleted_at: null }))
}
const NO_EXTRA_SEARCH_ITEMS = []

// `StartBatchSheet` is a prop only so a test can hand the page a stand-in for a file this branch does
// not have yet; App renders the route with no props, so production always takes the default.
// `howItWasMade` and `extraSearchItems` are the B′ seams (see above and the page search below);
// App renders the route with no props, so production takes the defaults.
export default function PutUp({
  StartBatchSheet = StartBatchSheetImpl, howItWasMade = HowItWasMadeImpl, extraSearchItems: extraSearchItemsProp = NO_EXTRA_SEARCH_ITEMS,
} = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // V4-PUTUPSESSION-001. ONE derived predicate for the whole walk, so there is no way to ship half
  // of it — the same shape EventNew's `inHarvestSession = param && !inOverlay` uses, and for the
  // same reason: the walk's fixed bottom band and BottomNav suppression cannot survive inside a
  // Sheet, so in an overlay the param degrades to a plain deep link to the ordinary page.
  const inOverlay = useInOverlaySurface()
  const inWalk = searchParams.get('session') === WALK_PARAM && !inOverlay

  // The default: every open lands on the inventory ("what have I got?"). V5-INFLIGHTBATCH-001 promotes a
  // bare open to 'going' the moment there is anything to check; see autoDefaultedRef. Put-Up R2b: an entry
  // stored while the "Log a put-up" form existed can still carry what the form was opened with on its
  // router state. That key is not read here or anywhere: such an entry is an open like any other.
  const [view, setView] = useState('pantry')
  // Put-Up release 1a (V4 §6.1, §10.2) — a door that NAMES its destination. `?view=pantry` is the
  // Pantry segment (B′ release 2 renamed it from "What's put up"); Today's use-soon band links here
  // with it. It counts as a choice already made, so the bare-open promote below never moves someone who
  // was sent to the list.
  const viewNamed = searchParams.get('view') === 'pantry'
  // Set the moment the user picks a view themselves. The auto-default below is a DEFAULT, not a
  // preference — it may never move someone off a segment they chose.
  const viewTouchedRef = useRef(viewNamed)
  const chooseView = useCallback((v) => { viewTouchedRef.current = true; setView(v) }, [])

  // `?filter=use-soon` — the list narrowed to what the band showed, behind a removable "Use soon ×"
  // chip. Clearing REPLACES the entry, so Back still returns to where the band was tapped (Today), and
  // carries the entry's state so an overlay's background survives (V4 §6.2) — through withFrom, like every
  // write on this page (R1): the background and every other key ride along, an origin does not.
  const useSoonOnly = searchParams.get('filter') === USE_SOON_FILTER
  const clearUseSoon = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.delete('filter')
    setSearchParams(next, { replace: true, state: withFrom(location.state, null) })
  }, [searchParams, setSearchParams, location.state])

  // ── V5-INFLIGHTBATCH-001 — open batches, fetched at the PAGE and passed down ───────────────────
  // The page owns this fetch rather than GoingNowView, because the default-view decision below needs
  // the count on every open regardless of which segment renders. One GET, not two.
  //
  // Three-valued on purpose, and the third value is the load-bearing one: `null` means "not loaded,
  // or the route is unavailable". Until the migration is applied to a database the route 500s, and
  // in that state this page must behave EXACTLY as it does today — no flip, no banner, no change to
  // the bare-open landing. Only an array is an answer.
  const { fetch: pageFetch } = useApiFetch()
  // The signed-in user, for the landing rule below. The non-throwing selector: PutUp is only ever
  // rendered signed in (Protected), and outside a provider it reads as nobody, never as a crash.
  const viewerId = useAuthOptional().user?.id ?? null
  const [going, setGoing] = useState(null)
  const [goingLoading, setGoingLoading] = useState(true)
  const [goingError, setGoingError] = useState(false)
  const loadGoing = useCallback(() => {
    setGoingLoading(true)
    pageFetch('/api/kitchen-batches?state=going')
      .then(rows => { setGoing(batchRows(rows)); setGoingError(false) })
      .catch(() => { setGoingError(true) })
      .finally(() => setGoingLoading(false))
  }, [pageFetch])
  useEffect(() => { loadGoing() }, [loadGoing])

  // ── V5-BATCHCLOSE-001 — the batch detail and the closed list are MODE FLAGS, not child routes ───
  //
  // `?batch=<id>` and `?state=closed` on /put-up. NOT /put-up/batch/:id. /put-up is one of exactly
  // four `overlayable: true` routes and the overlay tree is `routes.filter(r => r.overlayable)` with
  // NO catch-all, so a child route entered from an overlay-opened PutUp matches nothing and renders a
  // BLANK SCREEN on a dead tap — it would be the app's first child path of an overlayable parent,
  // which is why the hole has never been hit. A query param leaves the route match untouched: the
  // page never unmounts, the segment the user chose survives, Back pops the param rather than
  // remounting onto 'stores', the onChanged -> loadGoing invalidation contract keeps working, and
  // App.routes.test.jsx's 58-route freeze does not move.
  //
  // Put-Up UX pass R1 (PLAN-V3 D11) — `?recipe=<id>` is a third mode flag, for the same reason the other two
  // are flags: recipe detail is a full mode, with the page's own Back and no search row, button or segments.
  //
  // `batch` wins over `recipe`, and `recipe` over `state`. That order only ever decides a hand-typed or
  // deep-link URL: every door on this page writes exactly ONE mode key (openMode below), so a batch's
  // recipe link opens the recipe and a closed row opens its batch without either being outranked.
  const batchId = searchParams.get('batch')
  const recipeId = batchId ? null : (searchParams.get('recipe') || null)
  const closedMode = !batchId && !recipeId && searchParams.get('state') === 'closed'
  const modeActive = !!batchId || !!recipeId || closedMode
  // The page search's text (`?find=`), and whether its results are what the page is showing. Read here,
  // above the opener, because the opener asks it: a door under the results is opened from the results,
  // not from a segment.
  const findText = searchParams.get(FIND_PARAM) ?? ''
  const searching = !modeActive && findText.trim() !== ''

  // ONE instant for the detail surface, collapsed once per opened batch — GoingNowView.jsx:221-225's
  // rule applied at the page. PutUp is a route element that App renders with no props, so it cannot
  // receive an injected clock; the injection point is BatchDetailView's own `nowMs` prop, which is where a test
  // pins an age to a fixed literal.
  const detailNowMs = useMemo(() => Date.now(), [batchId])

  // The detail GET. Controlled surface: the PAGE owns the fetch and BatchDetailView issues none of
  // its own, so one reload path invalidates both this and the list.
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const loadDetail = useCallback(() => {
    if (!batchId) { setDetail(null); setDetailError(false); return }
    setDetailLoading(true)
    pageFetch(`/api/kitchen-batches/${batchId}`)
      .then(row => { setDetail(row && typeof row === 'object' ? row : null); setDetailError(false) })
      .catch(() => { setDetailError(true) })
      .finally(() => setDetailLoading(false))
  }, [pageFetch, batchId])
  useEffect(() => { loadDetail() }, [loadDetail])
  // The batch this page is showing IS the one the URL names (a switch to another batch shows the new
  // one's opening state, never the old one's body).
  const detailOnScreen = !!detail && String(detail.id) === String(batchId)

  // BOTH, always. A write from the detail surface changes the row the LIST renders too (a pause moves
  // a card into the Paused group, a close removes it entirely), and a retry after a dropped response
  // reports a delta rather than the truth — so the honest recovery is to re-read, never to trust what
  // the write returned.
  const onBatchChanged = useCallback(() => { loadGoing(); loadDetail() }, [loadGoing, loadDetail])

  // The closed list. Fetched only in closed mode: on a normal open this page already issues one GET
  // it did not used to, and a second unconditional one for a surface nobody asked for would be a
  // round trip on rural LTE for nothing.
  const [closed, setClosed] = useState(null)
  const [closedLoading, setClosedLoading] = useState(false)
  const [closedError, setClosedError] = useState(false)
  const loadClosed = useCallback(() => {
    if (!closedMode) return
    setClosedLoading(true)
    pageFetch('/api/kitchen-batches?state=closed')
      .then(rows => { setClosed(batchRows(rows)); setClosedError(false) })
      .catch(() => { setClosedError(true) })
      .finally(() => setClosedLoading(false))
  }, [pageFetch, closedMode])
  useEffect(() => { loadClosed() }, [loadClosed])

  // Reopening from the closed list moves a row back into `going`, so the list the user is NOT looking
  // at is the one that goes stale. Both, for the same reason onBatchChanged does both.
  const onClosedChanged = useCallback(() => { loadClosed(); loadGoing() }, [loadClosed, loadGoing])

  // ── Put-Up UX pass R1 (PLAN-V3 section 3, "What the page does") — THE ONE OPENER ─────────────────
  // Every door into a mode comes through here: the Going-now card and its closed-list door, a closed row,
  // a Pantry row sheet (from the list or from the search), a batch's recipe link, a recipe's batches, a
  // search hit and a batch just started. So there is one answer to each of three questions:
  //   · THE URL carries exactly ONE mode key (origin.js modeSearch), with the page search dropped and
  //     every other param kept. A mode that names nothing (a start that answered with no id) opens nothing.
  //   · THE STATE is withFrom(location.state, origin): the overlay's background and every other key ride
  //     along, and the origin is the SENDER's, never the last entry's. A sender that names none is opened
  //     from the segment on screen, so that segment is its origin (goingNow.js segmentOrigin): the card, the
  //     closed list's door, a Recipes row and a batch just started are then left by a POP, like every other
  //     door, and the system's Back after "← Going now" does not walk back INTO the batch. With no segment
  //     on screen — over the search's results, or inside a mode — there is none to name and the origin is
  //     REMOVED, so the next mode's Back can never read the last one's.
  //   · IT IS A PUSH, so Back (the system's and the page's) returns to the sender. A sender inside an
  //     armed sheet lands first (kitchen/sheetLanding.js). The one exception is the net for a sender that did
  //     not: while a sheet's Back marker is still the current entry, a push would strand it mid-stack as
  //     a Back press that does nothing, so the mode REPLACES it and one Back still lands on the sender.
  const openMode = useCallback((mode, origin) => {
    const next = modeSearch(searchParams, mode)
    if (!next.has('batch') && !next.has('recipe') && !next.has('state')) return
    const overMarker = typeof window !== 'undefined' && !!readMarker(window.history?.state)
    const from = origin ?? segmentOrigin(view, { onScreen: !modeActive && !searching })
    setSearchParams(next, { state: withFrom(location.state, from), replace: overMarker })
  }, [searchParams, setSearchParams, location.state, view, modeActive, searching])
  const openBatch = useCallback((id, origin) => openMode({ batch: id }, origin), [openMode])
  const openRecipe = useCallback((id, origin) => openMode({ recipe: id }, origin), [openMode])
  const openClosed = useCallback(() => openMode({ state: 'closed' }), [openMode])

  // THE WAY BACK OUT (goingNow.js leavePlan decides which). It POPS when this entry names where it was
  // opened from and an app entry is under it: the sender is one Back away, on this route or another, with
  // its own state — and a system Back after it does not walk back INTO the mode. Otherwise it is the push
  // it has always been — the URL with the mode keys removed (anything else, ?session= included, survives)
  // — so a cold deep link, a restored session and a search hit (which names no origin) all have an exit that
  // never leaves the page by surprise and never does nothing. That push lands on the segment the page is
  // holding, except a recipe, which is left onto Recipes; the Back's words (backWords, below) name that
  // same landing. A second press while a pop is still landing WAITS: a pop, unlike the push, is not safe
  // to do twice.
  //
  // The router's own history index (react-router writes it into history.state as `idx`; EventNew's Close
  // reads the same counter): 0 on the first app entry of a session, undefined under a router that keeps
  // no browser history.
  const routerIndex = () => (typeof window === 'undefined' ? undefined : window.history?.state?.idx)
  // The router's key on the entry the browser is standing on NOW (it writes one beside `idx` on every entry
  // it pushes or replaces), against `location.key`, which is the entry a given render was made for.
  const standingOnKey = () => (typeof window === 'undefined' ? undefined : window.history?.state?.key)
  // The entry the last pop was started from, and when — forgotten the moment the location changes, so an
  // entry re-entered later (the system's Forward) can be left again.
  const popStartedRef = useRef(null)
  useEffect(() => { popStartedRef.current = null }, [location.key])
  // …and settled by the LANDING itself (goingNow.js popLanding), because a location key does not always
  // change: after a reload with a sheet open, the entry under this one is its twin — same key, same URL —
  // and a pop onto it moves nothing on screen. The landing clears the latch, and a pop that landed on the
  // key it started from goes ONE entry further, so one press still reaches the sender.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onPop = () => {
      const started = popStartedRef.current
      const landing = popLanding({ started, landedKey: window.history.state?.key })
      if (landing === 'keep') return
      popStartedRef.current = null
      if (landing !== 'hop') return
      popStartedRef.current = { key: started.key, at: Date.now(), hopped: true }
      navigate(-1)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [navigate])
  const leaveMode = useCallback(() => {
    const plan = leavePlan({ state: location.state, historyIndex: routerIndex(), entryKey: location.key,
      started: popStartedRef.current, nowMs: Date.now() })
    if (plan === 'wait') return
    if (plan === 'pop') {
      // A STALE CALL NEVER POPS. A removed batch and a removed recipe call this after a wait on the server,
      // through the function they were handed BEFORE it. If the Back was pressed meanwhile, the browser is
      // already standing on the sender — while this closure still reads the mode's entry, sees its origin,
      // finds no pop under way, and would pop a second time: one entry past the sender, possibly out of
      // Put-Up. The entry this call was made for must still be the current one, or it does nothing.
      if (standingOnKey() !== location.key) return
      popStartedRef.current = { key: location.key, at: Date.now(), overMarker: !!readMarker(window.history.state) }
      // THE POP LANDS ON WHAT THE BACK SAYS. When the origin is a segment, the entry under this one is the
      // list — and which segment the list shows is this page's own state, not the URL's. It can have moved
      // since the door was opened: a page that MOUNTED on this entry (a reload, a restored PWA, a return
      // from another route) holds what a fresh page defaults to, and the bare-open default is decided on
      // the first list answer, whenever that comes. So the press selects the segment it names.
      const named = originSegment(location.state)
      if (named) chooseView(named)
      navigate(-1)
      return
    }
    popStartedRef.current = null
    chooseView(leaveSegment(view, { recipe: !!recipeId }))
    setSearchParams(modeSearch(searchParams, null), { state: withFrom(location.state, null) })
  }, [location.state, location.key, navigate, chooseView, view, recipeId, searchParams, setSearchParams])

  // RecipesView's `onOpen(id | null)`: an id opens that recipe (it names no origin, so the opener names the
  // Recipes segment it was tapped on); null, which a removed recipe sends, is the same act as the page's own
  // Back.
  const onRecipeOpen = useCallback((id) => {
    if (id == null || id === '') { if (recipeId) leaveMode() } else openRecipe(id)
  }, [recipeId, leaveMode, openRecipe])

  // Put-Up release 1a — Start a batch opens the shared sheet here instead of leaving for /capture, and
  // a started batch opens straight into the shipped `?batch=` mode: a PUSH, so Back returns to the list
  // it was started from, with the list re-read because it has a new card. R1: through the one opener,
  // and with the origin a sender names — a recipe's Make this and its "Made from this" rows hand theirs
  // in as the second argument, so the batch's Back returns to that recipe; Start's own sheet hands none, and
  // the opener names the segment it was started on.
  //
  // `startLabel` is the name Start opens WITH — the one the Put something up door carried over when its
  // escape line was tapped (PLAN-V3 D6, D10) — and '' from every other door. Anything that is not text (a
  // click event from a host that wired the callback straight to onClick) is no name.
  const [startOpen, setStartOpen] = useState(false)
  const [startLabel, setStartLabel] = useState('')
  const openStartSheet = useCallback((label) => {
    setStartLabel(typeof label === 'string' ? label : '')
    setStartOpen(true)
  }, [])
  const closeStartSheet = useCallback(() => setStartOpen(false), [])
  const onBatchStarted = useCallback((batch, origin) => {
    setStartOpen(false)
    loadGoing()
    openBatch(batch?.id, origin)
  }, [loadGoing, openBatch])

  // THE BARE-OPEN DEFAULT. A bare Put-Up open landing on "what have I got" is correct today and
  // wrong the moment batches exist, because the answer to "what is going on right now" would then be
  // one tap further away than the answer to a question nobody asked. This one flip takes "what needs
  // me" to ONE tap from app open and is the entire discoverability fix — no Today band, no new tab,
  // no new surface of any kind.
  //
  // Decided ONCE, on the first load that produces an answer, and never revisited: a late-arriving
  // fetch may not yank someone off a segment they chose. Hence both guards plus the view === 'pantry'
  // check, which is the state this flip is defined to replace.
  //
  // Put-Up release 1a (V4 §6.1 "Jen's landing") — and only when a listed batch is the VIEWER's own.
  // Batches are household-visible, so Jen opening Put-Up while Dave has a ferment going used to land
  // on a list of his batches instead of on the jars she came for. Ownership is the row's user_id — the
  // Clerk subject of whoever started it (kitchenRoutes createBatch), a column the list already sends
  // (SELECT * over v_kitchen_batch_current) — compared with the signed-in user's Clerk id. An unknown
  // viewer owns nothing, so it lands on the list: the rule, read literally.
  const autoDefaultedRef = useRef(false)
  useEffect(() => {
    if (autoDefaultedRef.current || !Array.isArray(going)) return
    autoDefaultedRef.current = true
    if (viewTouchedRef.current || view !== 'pantry') return
    if (viewerId == null || !going.some(b => b?.user_id === viewerId)) return
    setView('going')
  }, [going, view, viewerId])

  // Put-Up R2b — THE RETIRED FORM'S DRAFT. "Log a put-up" kept a half-typed entry in sessionStorage under
  // DRAFT_KEY, and a phone that was mid-entry when the form left still holds one, with no form to restore
  // it into. Cleared once, when the page mounts, by its EXACT key: 'put-up/batch-close' (BatchCloseField's
  // draft) begins with the same letters and is a different draft, which this must never touch.
  useEffect(() => { clearDraft(DRAFT_KEY) }, [])

  // ── Put-Up B′ release 2 — the Pantry, the page search, the door, the bridge ───────────────────────
  // The Pantry list is read at the PAGE: the segment, the page search and the door's name search all
  // read the same rows, and a write from any of them re-reads once.
  const [pantryGroup, setPantryGroup] = useState('place')
  const [doorOpen, setDoorOpen] = useState(false)
  const [doorName, setDoorName] = useState('')
  const pantry = usePantryList({ fetch: pageFetch, group: pantryGroup,
    enabled: !inWalk && ((!modeActive && view === 'pantry') || searching || doorOpen) })
  // The names of the batches the listed jars came from, read ONCE for the page and handed to both lists that
  // name them (the Pantry, the search's results), so neither reads its own on every mount. Read only while
  // one of them is showing: never for the door's name search alone, never on the walk.
  const batchNames = useBatchNames({ fetch: pageFetch, rows: pantry.rows,
    enabled: !inWalk && ((!modeActive && view === 'pantry') || searching) })
  // What the person did on a row this visit — "3 left · used one · Undo" until their next visit (V4 §2.5).
  const [pantryRecent, setPantryRecent] = useState({})
  // The door's completion, shown in place on the Pantry with Undo (V4 §2.2).
  const [completion, setCompletion] = useState(null)
  // How it was made → (the batch-builder seam; absent → no door anywhere).
  const useHow = howItWasMade?.useHowItWasMade ?? useNoHowItWasMade
  const how = useHow({ onSaved: () => { pantry.reload(); loadGoing() } })
  const onHowItWasMade = typeof how?.open === 'function' ? how.open : null
  const canHowItWasMade = useMemo(() => howRowCheck(howItWasMade), [howItWasMade])
  // The page search's extra corpus: `{ kind, id, name, type_label?, onOpen? }` items (a `key` and
  // `kindLabel` are read too), from the `extraSearchItems` prop and — R1, PLAN-V3 D16 — the household's
  // recipes. Their list is read ONCE, the first time the search holds text: never at a bare open (this
  // page already refuses a GET nobody asked for), and not once per keystroke. A failed read leaves the
  // search exactly as it was, over the Pantry alone, and the next search asks again.
  const [extraSearchState, setExtraSearchItems] = useState(NO_EXTRA_SEARCH_ITEMS)
  const extraSearchItems = useMemo(() => [...extraSearchItemsProp, ...extraSearchState], [extraSearchItemsProp, extraSearchState])
  const recipesAskedRef = useRef(false)
  useEffect(() => {
    if (!searching || recipesAskedRef.current) return
    recipesAskedRef.current = true
    pageFetch('/api/recipes')
      .then(r => setExtraSearchItems(recipeSearchItems(r)))
      .catch(() => { recipesAskedRef.current = false })
  }, [searching, pageFetch])
  // The rename bridge (V4 §2.5): counted once per page visit, per viewer.
  const [bridgeShown, setBridgeShown] = useState(() => noteBridgeVisit(viewerId))
  const onDismissBridge = useCallback(() => { dismissBridge(viewerId); setBridgeShown(false) }, [viewerId])

  // The search text lives in `?find=`: the first keystroke PUSHES (so Back clears it), the rest replace.
  const setFind = useCallback((text) => {
    const next = new URLSearchParams(searchParams)
    if (text) next.set(FIND_PARAM, text); else next.delete(FIND_PARAM)
    setSearchParams(next, { replace: searchParams.has(FIND_PARAM), state: withFrom(location.state, null) })
  }, [searchParams, setSearchParams, location.state])
  const clearFind = useCallback(() => setFind(''), [setFind])
  // A search hit from the extra corpus opens through its own `onOpen` when it has one; a recipe item
  // ({kind:'recipe', id, name, …}, the recipes lane's shape) otherwise opens recipe detail, `?recipe=`
  // (V4 §6.2) — through the one opener, with no origin: a push, with the search dropped, so the system
  // Back returns to the results and the page's Back leaves onto Recipes.
  const openSearchItem = useCallback((item) => {
    if (typeof item?.onOpen === 'function') { item.onOpen(item); return }
    if (item?.kind === 'recipe') openRecipe(item.id)
  }, [openRecipe])

  // `name` is the text a door is opened WITH (the search's "Put something up: <text> →", the empty
  // Pantry's button). Anything that is not text — a click event from a host that wired the callback
  // straight to onClick — opens the door empty, never with an object for a name.
  const openDoor = useCallback((name) => { setDoorName(typeof name === 'string' ? name : ''); setDoorOpen(true) }, [])
  // The walk's door, on the header row and on the empty Pantry.
  const openWalk = useCallback(() => navigate(`/put-up?session=${WALK_PARAM}`), [navigate])
  // The door's escape, "Still going (a ferment)? Start a batch instead →": the door closes and Start opens
  // with the name it carried. One armed sheet handing over to another in one handler reuses the Back
  // marker, so there is nothing to land and nothing navigates.
  const onStartBatchInstead = useCallback((name) => { setDoorOpen(false); openStartSheet(name) }, [openStartSheet])
  const onDoorSaved = useCallback(({ route, saved, place }) => {
    setDoorOpen(false)
    setCompletion({ route, saved, place, text: completionWords({ route, saved, place }) })
    if (findText) clearFind()
    chooseView('pantry')
    pantry.reload()
  }, [chooseView, clearFind, findText, pantry])

  // Declared AFTER every hook above, so the walk branch cannot reorder them.
  if (inWalk) {
    return (<>
      <WalkPlace JarEditor={RowEditor} onHowItWasMade={onHowItWasMade} canHowItWasMade={canHowItWasMade} />
      {how?.sheet ?? null}
    </>)
  }

  // The segment bodies stand down while a mode is open, and while the page search holds text (its
  // results replace the body, V4 §2.5). `view` itself is untouched, which is the whole point of the mode
  // flag: leaving the mode restores the segment the user was on instead of remounting the page onto the
  // Pantry behind a network round trip.
  const seg = modeActive || searching ? null : view
  // The Back's words name where the press lands (see leaveMode): the sender when it will pop to it,
  // otherwise the segment the push shows. Read at render — every navigation re-renders this page, and
  // a sheet's Back marker copies the router's index, so the two cannot disagree between renders.
  const back = backWords(location.state, routerIndex(), segmentLabel(leaveSegment(view, { recipe: !!recipeId })))
  // Going now, and not under search results: the one state in which the header's filled button starts a batch.
  const onGoing = view === 'going' && !searching
  // ONE min-width for the filled button, wide enough for the longer of its two labels, so the search box
  // beside it keeps its width when the segment — and the label — changes. In em: it follows the text size.
  // Measured at this type size (0.82rem): "Put something up" is 132.2px wide in Roboto (the phones) and
  // 142.5px in San Francisco; 11em is 144.3px.
  const headerButton = { flexShrink: 0, minWidth: '11em', minHeight: T.buttonMinHeight, padding: '0 14px', backgroundColor: P.green,
    color: P.white, border: 'none', borderRadius: T.radiusButton, fontSize: T.type.sm, fontWeight: 700, fontFamily: 'inherit',
    whiteSpace: 'nowrap', cursor: 'pointer' }
  const quietDoor = { minHeight: T.buttonMinHeight, background: 'none', border: 'none', padding: '0 2px', color: P.green,
    fontSize: T.type.sm, fontWeight: 600, fontFamily: 'inherit', textDecoration: 'underline', cursor: 'pointer' }

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '24px 18px 80px' }}>
        <h1 style={{ margin: '0 0 4px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Put-Up</h1>

        {/* THE WAY BACK, in the page rather than in the browser chrome. An installed PWA has no
            address bar and no visible Back control (App.jsx records exactly this hazard for /admin/*),
            so a mode with no in-page exit is a mode a user can be stuck in. History Back also works
            and lands in the same place, because the mode is a search param on this same route.
            R1 (PLAN-V3 D11): ONE line. The name shortens with an ellipsis; " (recipe)" / " (batch)", which
            is what tells a recipe from the batch named after it, stays whole. */}
        {modeActive && (
          <button type="button" onClick={leaveMode} data-testid="putup-mode-back"
            style={{ display: 'inline-flex', alignItems: 'center', maxWidth: '100%', minHeight: T.buttonMinHeight,
              background: 'none', border: 'none', padding: '2px 8px 2px 0', margin: '2px 0 8px', whiteSpace: 'nowrap',
              cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>← {back.name}</span>
            {back.suffix && <span style={{ flexShrink: 0, whiteSpace: 'pre' }}>{back.suffix}</span>}
          </button>
        )}

        {!modeActive && (
          <p style={{ margin: '0 0 12px', fontSize: '0.84rem', color: P.light }}>
            What you&rsquo;ve put up, what&rsquo;s on the go, and what you&rsquo;ve bought.
          </p>
        )}

        {/* B′ release 2 (V4 §6.1) — the page header row: search + ONE filled button, hidden while a mode
            is open; a quiet "Walk a place" beneath it (the shipped freezer walk's door, generalised —
            still on this line's posture: not a full-width filled CTA, V4-WEIGHINCTA-001's reversal).
            R1 (PLAN-V3 D10): the filled button is the thing that segment is FOR. On Going now it starts a
            batch — he lands there with a ferment going and used to find only "Put something up", which is
            the wrong door for a ferment. Everywhere else, and over search results (what was typed there
            is something to put up), it is Put something up. Two buttons, each with its own fixed testid and name, never
            one that changes what it does; and on Going now the door stays ONE tap away as a quiet link
            beside the walk's, under the same testid the filled one carries elsewhere. */}
        {!modeActive && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm }}>
              <PantrySearchBox value={findText} onChange={setFind} onClear={clearFind} />
              {onGoing && (
                <button type="button" onClick={() => (StartBatchSheet ? openStartSheet() : openDoor(''))} data-testid="start-a-batch"
                  style={headerButton}>
                  {START_BATCH_CTA}
                </button>
              )}
              {!onGoing && (
                <button type="button" onClick={() => openDoor('')} data-testid="putup-door" style={headerButton}>
                  {DOOR_CTA}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: T.space.md }}>
              <button type="button" onClick={openWalk} data-testid="putup-walk-door" style={quietDoor}>
                {WALK_TITLE}
              </button>
              {onGoing && (
                <button type="button" onClick={() => openDoor('')} data-testid="putup-door" style={quietDoor}>
                  {DOOR_CTA}
                </button>
              )}
            </div>
          </div>
        )}

        {/* LIFECYCLE ORDER, left to right: going → logged → kept. The grammar was already
            inconsistent (a VERB beside a QUESTION) and a third label had to join it; "Going now"
            names the OBJECT's state, which is what the other two labels are really doing too.
            B′ release 2: "What's put up" is the Pantry (V4 §6.1). R2b: "Log a put-up" (the shipped form)
            is gone; Put something up is the one way in. Three segments, each at the 48 px tap target
            the rest of Put-Up's controls have (`touch`). */}
        {!modeActive && !searching && (
          <div style={{ marginBottom: 18 }}>
            <SegmentedControl
              ariaLabel="Put-Up view"
              value={view}
              onChange={chooseView}
              options={PUT_UP_SEGMENTS}
              touch
            />
          </div>
        )}

        {searching && (
          <PantrySearchResults query={findText} rows={pantry.rows} loading={pantry.loading} extraSearchItems={extraSearchItems}
            onOpenExtra={openSearchItem} onOpenBatch={openBatch} batchNames={batchNames}
            fetch={pageFetch} onPutUp={(text) => openDoor(text)} JarEditor={RowEditor}
            onHowItWasMade={onHowItWasMade} canHowItWasMade={canHowItWasMade}
            onUsed={(entry) => { setPantryRecent(prev => ({ ...prev, [`${entry.row.stock_kind}:${entry.row.stock_id}`]: { ...entry, undone: false, err: null, undoKey: null } })); pantry.reload() }}
            onChanged={() => pantry.reload()} />
        )}

        {seg === 'going' && (
          <GoingNowView batches={going} loading={goingLoading} error={goingError} onReload={loadGoing}
            onStartBatch={StartBatchSheet ? openStartSheet : undefined} onOpenBatch={openBatch} onOpenClosed={openClosed} />
        )}
        {seg === 'pantry' && (
          <PantryView fetch={pageFetch} group={pantryGroup} onGroupChange={setPantryGroup} rows={pantry.rows}
            loading={pantry.loading} error={pantry.error} onReload={pantry.reload} recent={pantryRecent} onRecent={setPantryRecent}
            useSoonOnly={useSoonOnly} onClearUseSoon={clearUseSoon} JarEditor={RowEditor}
            onHowItWasMade={onHowItWasMade} canHowItWasMade={canHowItWasMade}
            completion={completion} onCompletionDone={() => setCompletion(null)}
            showBridge={bridgeShown} onDismissBridge={onDismissBridge}
            onOpenBatch={openBatch} onPutSomethingUp={openDoor} onWalkPlace={openWalk} batchNames={batchNames} />
        )}
        {/* ONE element for the Recipes list and for recipe detail (R1, PLAN-V3 D11): the same instance stays
            mounted across opening and closing a recipe, so its two list reads and its type filter are not
            thrown away on every tap. With `onOpen` it is controlled by the URL: `openId` is `?recipe=`. */}
        {(seg === 'recipes' || recipeId) && (
          <RecipesView onBatchStarted={onBatchStarted} openId={recipeId} onOpen={onRecipeOpen} />
        )}

        {/* The batch's own surface. Controlled — it issues no GET of its own, so `onChanged` is the
            only invalidation path and it re-reads BOTH this row and the list.
            "Opening that batch…" and "Couldn't open that batch." are for a batch not on screen yet —
            never for the re-read after a write (release F, found by the ferment walks): that swapped the
            whole body out and back, remounting everything under it, so each write's own answer — "Saved ·
            Undo", "Taken out · Undo", a salt step half typed — was gone by the time the re-read landed,
            and a re-read that FAILED replaced a batch that was already on screen with an error. A failed
            re-read keeps the batch and says so in one quiet line, with Try again. */}
        {batchId && (
          <div data-testid="putup-batch-mode">
            <BatchDetailView
              batch={detail} inputs={detail?.inputs ?? []} stages={detail?.stages ?? []}
              outputs={detail?.outputs ?? []} loading={detailLoading && !detailOnScreen} error={detailError && !detailOnScreen}
              refreshFailed={detailError && detailOnScreen} refreshing={detailLoading} onRetry={loadDetail}
              nowMs={detailNowMs} onChanged={onBatchChanged} onOpenRecipe={openRecipe}
              onRemoved={() => { loadGoing(); leaveMode() }} />
          </div>
        )}

        {closedMode && (
          <div data-testid="putup-closed-mode">
            <ClosedBatchesView batches={closed} loading={closedLoading} error={closedError}
              onReload={onClosedChanged} now={detailNowMs} onOpenBatch={openBatch} />
          </div>
        )}

        {/* Mounted only while open. Sheet renders nothing when closed and its close path IS its
            unmount cleanup (scroll unlock, focus return), so this changes nothing about closing — but
            it means the sheet's hooks (its draft read, anything identity-scoped) run only when someone
            asked for it, and can never take down an ordinary visit to this page. */}
        {StartBatchSheet && startOpen && (
          <StartBatchSheet open onClose={closeStartSheet} onStarted={onBatchStarted} onExists={loadGoing} initialLabel={startLabel} />
        )}
        {doorOpen && (
          <PutSomethingUpSheet open initialName={doorName} stockRows={pantry.rows} onClose={() => setDoorOpen(false)}
            onSaved={onDoorSaved} onExists={pantry.reload} onStartBatchInstead={StartBatchSheet ? onStartBatchInstead : undefined} />
        )}
        {how?.sheet ?? null}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Put-Up B′ release 2 — "What's put up" is the Pantry (components/pantry/PantryView.jsx). The read
// surface that lived here (StoresView / GroupCard / RecordRow over GET whats-put-up) is replaced by the
// one Pantry list over GET /api/pantry; its row actions moved to the Pantry row and its row sheet
// (V4 §10.1). RowEditor below stays: it is the jar's Edit, handed to the row sheet as `JarEditor`.
// ─────────────────────────────────────────────────────────────────────────────

// The line a failed write leaves on screen. `err` is the caller's own copy (a string: offline, a
// timeout, an uncoded 400 — unchanged from before) or a refusal from describeRefusal, which carries
// its own sentence and, for client_stale only, the Refresh now button.
function WriteError({ err, style }) {
  if (!err) return null
  const refusal = typeof err === 'string' ? null : err
  return (
    <div style={style}>
      <div role="alert" style={{ color: P.terra, fontSize: '0.78rem' }}>{refusal ? refusal.text : err}</div>
      {refusal?.refresh && <RefreshNowButton />}
    </div>
  )
}

// Mounted only while a client_stale refusal is on screen, so useAppUpdate's listener and version
// probe cost nothing on an ordinary visit. apply() runs on the TAP and nowhere else (V4 §6.5, B66):
// it reloads the page without consulting the reload gate, so running it unasked would discard any
// other surface that is still holding one.
function RefreshNowButton() {
  const { apply } = useAppUpdate()
  return (
    <button type="button" onClick={() => apply()} data-testid="putup-refresh-now"
      style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, marginTop: 6,
        padding: '6px 14px', background: 'none', border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton,
        color: P.green, fontSize: T.type.sm, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}>
      {REFRESH_NOW_LABEL}
    </button>
  )
}

// Put-Up R2a — the jar's Edit panel's own words. Constants read by RowEditor only; METHOD_GROUPS and
// UNIT_GROUPS, which it also reads, are the retired log form's and are left as they were written. Each of
// these is BOTH the label a person sees and the name a screen reader says, so the two cannot drift apart.
const EDIT_COUNT_LABEL = 'How many were put up?'
const EDIT_METHOD_LABEL = 'How was it put up?'
// "Bought already preserved" is not something a put-up becomes: Edit offers it only on a row that is one.
const EDIT_BOUGHT_METHOD = 'purchased_preserved'

// THE ECHO UNDER THE AMOUNT. The door asks the size of EACH container and Edit asks how much IN ALL, in
// the same unit, so each screen says the other number: "3 containers · 1 qt each", or "about 0.83 qt
// each" when the amount does not divide evenly at the column's two places. From the TYPED amount, unit
// and count as they stand (it moves as any of them changes), never from the stored row, and it changes
// no field: the person is shown the mismatch, not corrected. Null — nothing to say — with no unit, one
// container or none (the amount IS that container), or a share that comes to nothing (no amount is one).
// Decimal arithmetic on the typed digits, as jarWords.totalOfEach does it: 2.5 / 3 in floats is not 0.83.
const jarEachWords = (amountText, unit, countText) => {
  const m = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(String(amountText ?? ''))
  const n = Number(countText)
  if (!m || !unit || !Number.isInteger(n) || n < 2) return null
  const frac = m[2] ?? ''
  const places = Math.max(frac.length, 2)
  // The amount as a whole number of 10^-places, and what ONE hundredth of a share is in that scale.
  const total = BigInt(`${m[1] || '0'}${frac}`) * 10n ** BigInt(places - frac.length)
  const perHundredth = BigInt(n) * 10n ** BigInt(places - 2)
  const each = (2n * total + perHundredth) / (2n * perHundredth)          // hundredths, rounded half-up
  if (each <= 0n) return null
  const about = total % perHundredth === 0n ? '' : 'about '
  return `${n} containers · ${about}${qtyText(`${each / 100n}.${String(each % 100n).padStart(2, '0')}`)} ${unit} each`
}

// DISCARD BY, ON EVERY METHOD, SET BY HAND (amendment D12). The door's three chips in the door's words
// (putItUp.DISCARD_LABELS), each mapped to what the jar PATCH's `discard_by` takes
// (lambda/preservation/jarRoutes.js patchJar): Work it out -> 'clear' (the date is worked out again by the
// whole ladder), From the label -> the date (stored as set by hand), No date -> 'none' (no date, set by hand).
// Cured and cellared produce reads "Use by" here as it does everywhere else (jarWords.USE_BY_METHODS:
// theirs is a quality span); every other method reads "Discard by".
const EDIT_DISCARD_LABEL = 'Discard by'
const EDIT_USE_BY_LABEL = 'Use by'
const EDIT_DISCARD_DATE_LABEL = 'Discard date from the label'
const EDIT_USE_BY_DATE_LABEL = 'Use by date from the label'
const EDIT_DISCARD_MODES = Object.freeze(['auto', 'date', 'none'])
const EDIT_DISCARD_SENDS = Object.freeze({ auto: 'clear', none: 'none' })
// Which chip a stored row opens on, by the server's own rule for what it stores (a date or 'none' from a
// person stores basis `typed`): typed with a date is his date, typed with none is his "no date", and
// anything else (a general figure, the recipe, the house estimate, nothing, an older row) was worked out.
const jarDiscardSeed = (rec) => (rec.use_by_basis === 'typed' ? (rec.use_by_target ? 'date' : 'none') : 'auto')

// WHERE IT'S FROM, corrected in Edit (contract 4): the door's own control under the door's heading for a
// put-up — what went INTO it, not where the jar came from.
const EDIT_SOURCE_HEADING = 'Made with produce from'

// Put-Up surfaces take 48 px targets; the shared Input and Select stop at the app-wide 44 px floor.
const EDIT_FIELD_STYLE = Object.freeze({ minHeight: T.buttonMinHeight })

// Minimal per-row editor — the fields worth changing after the fact. Sends ONE PATCH of what changed.
function RowEditor({ rec, onCancel, onSave, busy, err }) {
  // What the editor OPENED with, taken once. Every field below seeds from it and `dirty` compares
  // against it, one expression per field, so the seed and the comparison cannot drift apart.
  const [seed] = useState(() => ({
    // Put-Up release 1b: a jar may have NO size (the quantity pair is NULL). It opens blank — not as
    // "lbs", which the 1a editor showed for a row that never had a unit.
    qtyValue: String(rec.quantity_value ?? ''),
    qtyUnit: rec.quantity_unit || '',
    name: rec.label || '',
    packageCount: String(rec.package_count ?? 1),
    method: rec.method || 'whole_freeze',
    methodOther: rec.method_other_text || '',
    useByTarget: rec.use_by_target ? ymd(rec.use_by_target) : '',
    discardMode: jarDiscardSeed(rec),
    sourceKind: rec.source_kind ?? null,
    sourceLabel: rec.source_label || '',
    notes: rec.notes || '',
  }))
  const [qtyValue, setQtyValue] = useState(seed.qtyValue)
  const [name, setName] = useState(seed.name)
  const [qtyUnit, setQtyUnit] = useState(seed.qtyUnit)
  const [packageCount, setPackageCount] = useState(seed.packageCount)
  const [method, setMethod] = useState(seed.method)
  // PRE-EXISTING BUG, fixed under V4-PUTUPPROV-001. This editor offered 'other' in the method list
  // but had no method_other_text input, so switching a row TO 'other' sent method:'other' with
  // method_other_text:null (the 1a full echo supplied the row's existing value, which is null for a
  // row that was not already 'other'), tripping validateUpdate's required-text rule. The 400 was
  // then swallowed by put()'s generic catch, so it read as "Couldn't update — try again." forever.
  // THE INVARIANT THIS RESTORES: a field that is CONDITIONALLY REQUIRED BY ANOTHER FIELD must be
  // editable everywhere that other field is editable, or the pair must be create-only. The new
  // source_kind/source_label pair depends on the same invariant holding.
  const [methodOther, setMethodOther] = useState(seed.methodOther)
  // V5-PUTUPCANDY-001. The other half of FOODSAFETY-RULING-V101 §8.2: "let the cook set the real
  // date". use_by_target has always been per-row and user-overridable at CREATE time, but this
  // editor never exposed it, so the provenance line's "tap Edit to set the real date" would have
  // been a dead instruction on an existing row. Seeded through ymd(), so an untouched field is
  // byte-for-byte the stored day and is never sent (release F: only what changed is).
  const [useByTarget, setUseByTarget] = useState(seed.useByTarget)
  // Put-Up R2a (amendment D12): the date is set by one of three chips on EVERY method. The date field
  // above is what "From the label" shows, still seeded with the stored day. What counts as a change is
  // the CHIP, or the date while "From the label" is the chip: tapping "From the label" over a worked-out
  // date and saving it as it stands IS a change (the date is equal; whose date it is becomes his), and a
  // date typed and then abandoned for another chip is not one.
  const [discardMode, setDiscardMode] = useState(seed.discardMode)
  const discardTouched = discardMode !== seed.discardMode || (discardMode === 'date' && useByTarget !== seed.useByTarget)
  // "From the label" saved with no date picked: said in place, in the door's sentence, and nothing is sent.
  const [dateRefused, setDateRefused] = useState(false)
  // Put-Up R2a (contract 4): where the produce came from, corrected here. A put-up tied to a planting
  // or to a pick is from the garden and says so by that tie: the server refuses any other source for it
  // (provenance.js, judged against the STORED planting and harvest link), so such a row has no control.
  const [sourceKind, setSourceKind] = useState(seed.sourceKind)
  const [sourceLabel, setSourceLabel] = useState(seed.sourceLabel)
  const sourceTouched = sourceKind !== seed.sourceKind || sourceLabel !== seed.sourceLabel
  const sourceOffered = !rec.plant_id && !rec.harvest_log_id
  // Other with no name: whereFromError's sentence, in place, and nothing is sent.
  const [sourceRefused, setSourceRefused] = useState(null)
  const [notes, setNotes] = useState(seed.notes)

  // Put-Up release 1a (V4 §6.5 "Reload gate"). A deploy's SW reload landing mid-Edit took the typed
  // values with it: the log form's hold was the only one on this page. Held while anything differs
  // from the seed OR a save is in flight — `busy` covers an untouched Save too, where a reload between
  // the PUT leaving and its answer would leave nobody knowing whether it landed. A refused save keeps
  // the edit on screen (RecordRow), so it keeps the hold.
  //
  // ONE boolean dep, as PutUpForm's hold does it: with [dirty, busy] the effect would re-run when a
  // Save flips busy on an already-dirty editor, and the cleanup's release in between would fire the
  // deferred reload at the exact moment of the save. The key is per instance (useId) so two open
  // editors can never release each other's hold.
  const dirty = qtyValue !== seed.qtyValue || qtyUnit !== seed.qtyUnit || packageCount !== seed.packageCount || name !== seed.name ||
    method !== seed.method || methodOther !== seed.methodOther || discardTouched || sourceTouched || notes !== seed.notes
  const holdReload = dirty || !!busy
  const reloadGateKey = `put-up-row:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, holdReload)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, holdReload])

  // ONLY what changed is sent, in ONE PATCH (RecordRow.saveEdit; release F moved the size and count onto
  // it too). An untouched field is an absent key, which the route reads as "unchanged" (V4 §5.4).
  function save() {
    // ONLY what changed, each key once, all in the one PATCH (see RecordRow.saveEdit).
    const patch = {}
    if (packageCount !== seed.packageCount) patch.package_count = packageCount === '' ? 1 : Number(packageCount)
    // The size always travels as a pair. A blank amount leaves the stored size alone rather than
    // clearing it.
    if ((qtyValue !== seed.qtyValue || qtyUnit !== seed.qtyUnit) && qtyValue.trim() !== '' && Number(qtyValue) > 0) {
      patch.quantity_value = qtyValue.trim()
      patch.quantity_unit = qtyUnit || rec.quantity_unit
    }
    if (name !== seed.name) patch.label = name.trim() || null
    // method_other_text travels WITH method (the PATCH refuses it alone: jarRoutes.js validateJarPatch),
    // so an edit to the 'other' description re-sends the method it describes.
    if (method !== seed.method || (method === 'other' && methodOther !== seed.methodOther)) {
      patch.method = method
      if (method === 'other') patch.method_other_text = methodOther.trim() || null
    }
    if (notes !== seed.notes) patch.notes = notes.trim() || null
    if (discardTouched) patch.discard_by = discardMode === 'date' ? useByTarget : EDIT_DISCARD_SENDS[discardMode]
    // The one thing the date can be refused for here: "From the label" with no date picked.
    const dateMissing = discardTouched && discardMode === 'date' && !useByTarget
    setDateRefused(dateMissing)
    // Where it's from travels as a PAIR, always both (the route refuses one alone); untouched, neither
    // key is sent. The garden and "un-chosen" carry no name: the control empties it on either choice
    // (WhereFromField), and an empty name goes as null, never as a missing key.
    if (sourceTouched) {
      patch.source_kind = sourceKind
      patch.source_label = sourceLabel.trim() || null
    }
    const sourceMissing = sourceTouched ? whereFromError({ kind: sourceKind, label: sourceLabel }) : null
    setSourceRefused(sourceMissing)
    if (!dateMissing && !sourceMissing) onSave(Object.keys(patch).length ? patch : null)
  }

  const useBy = USE_BY_METHODS.has(method)
  const discardLabel = useBy ? EDIT_USE_BY_LABEL : EDIT_DISCARD_LABEL

  // The echo under the amount: live, from what is typed (jarEachWords).
  const eachWords = jarEachWords(qtyValue, qtyUnit, packageCount)

  return (
    <div style={{ padding: '14px 16px', borderTop: `1px solid ${P.cream}`, backgroundColor: P.cream }}>
      <WriteError err={err} style={{ marginBottom: 8 }} />
      <div style={{ marginBottom: T.space.sm }}>
        <Field label="Name" htmlFor={`ed-name-${rec.id}`} optional>
          <Input id={`ed-name-${rec.id}`} type="text" value={name} maxLength={120}
            onChange={e => setName(e.target.value)} aria-label="Name" style={EDIT_FIELD_STYLE} />
        </Field>
      </div>
      {/* The count sits ABOVE the amount (R2a): "How many" alone, beside a row that says "2 left", reads
          as how many are left — the label says what it is, and the amount under it is the total of them. */}
      <div style={{ marginBottom: T.space.sm }}>
        <Field label={EDIT_COUNT_LABEL} htmlFor={`ed-pkg-${rec.id}`}>
          <Input id={`ed-pkg-${rec.id}`} type="number" min={1} value={packageCount}
            onChange={e => setPackageCount(e.target.value)} aria-label={EDIT_COUNT_LABEL} style={EDIT_FIELD_STYLE} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: T.space.sm }}>
        <div style={{ flex: 2 }}>
          <Field label="How much in all" htmlFor={`ed-qty-${rec.id}`}>
            <Input id={`ed-qty-${rec.id}`} type="text" inputMode="decimal" value={qtyValue}
              onChange={e => setQtyValue(e.target.value)} aria-label="Quantity" style={EDIT_FIELD_STYLE} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Unit" htmlFor={`ed-unit-${rec.id}`}>
            <Select id={`ed-unit-${rec.id}`} value={qtyUnit} onChange={e => setQtyUnit(e.target.value)} aria-label="Unit"
              style={EDIT_FIELD_STYLE}>
              {/* A no-size jar opens on the blank; a stored unit outside the list (1b's "fl oz", "cup")
                  is offered as itself rather than displayed as the first option. */}
              {!seed.qtyUnit && <option value="">—</option>}
              {seed.qtyUnit && !UNIT_GROUPS.some(g => g.options.includes(seed.qtyUnit)) && (
                <option value={seed.qtyUnit}>{seed.qtyUnit}</option>
              )}
              {UNIT_GROUPS.map(g => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map(u => <option key={u} value={u}>{u}</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      {/* Always mounted, so a screen reader hears it change; empty when there is nothing to say. */}
      <p role="status" data-testid={`ed-each-${rec.id}`}
        style={{ margin: eachWords ? `${T.space.xs}px 0 0` : 0, color: P.mid, fontSize: T.type.sm }}>{eachWords}</p>
      <div style={{ marginTop: T.space.sm }}>
        <Field label={EDIT_METHOD_LABEL} htmlFor={`ed-method-${rec.id}`}>
          <Select id={`ed-method-${rec.id}`} value={method} onChange={e => setMethod(e.target.value)} aria-label={EDIT_METHOD_LABEL}
            style={EDIT_FIELD_STYLE}>
            {/* The form's groups, the door's words for each method (one method reads one way). */}
            {METHOD_GROUPS.map(g => (
              <optgroup key={g.group} label={g.group}>
                {g.options.filter(o => o.value !== EDIT_BOUGHT_METHOD || seed.method === EDIT_BOUGHT_METHOD).map(o => (
                  <option key={o.value} value={o.value}>{JAR_METHOD_LABELS[o.value] ?? o.label}</option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
      </div>
      {/* Conditionally-required partner of the Method select above. Without this the 'other' option
          is a trap: picking it makes the row un-saveable with an error the UI cannot explain. */}
      {method === 'other' && (
        <div style={{ marginTop: T.space.sm }}>
          <Field label="What method?" htmlFor={`ed-method-other-${rec.id}`}>
            <Input id={`ed-method-other-${rec.id}`} type="text" value={methodOther}
              onChange={e => setMethodOther(e.target.value)} aria-label="Method description"
              placeholder="Describe how you put it up" style={EDIT_FIELD_STYLE} />
          </Field>
        </div>
      )}
      {/* The date, on EVERY method (R2a, amendment D12): a place cannot be re-kinded while its put-ups
          carry dates worked out for the kind it is now, and "set those dates by hand from Edit" has to be
          a thing a person can do for any of them. The label and the note are keyed on the LOCAL method
          state, as the block above is, so a method changed in this edit reads right before the save. */}
      <div style={{ marginTop: T.space.sm }}>
        <span style={labelChrome} aria-hidden="true">{discardLabel}</span>
        <div role="radiogroup" aria-label={discardLabel} data-testid={`ed-discard-${rec.id}`}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {EDIT_DISCARD_MODES.map(m => (
            <SelectChip key={m} touch active={discardMode === m} role="radio" aria-checked={discardMode === m}
              aria-pressed={undefined} data-testid={`ed-discard-${m}-${rec.id}`}
              onClick={() => { setDiscardMode(m); setDateRefused(false) }}>{DISCARD_LABELS[m]}</SelectChip>
          ))}
        </div>
        {discardMode === 'date' && (
          <Input id={`ed-useby-${rec.id}`} type="date" value={useByTarget} aria-invalid={dateRefused || undefined}
            onChange={e => { setUseByTarget(e.target.value); setDateRefused(false) }}
            aria-label={useBy ? EDIT_USE_BY_DATE_LABEL : EDIT_DISCARD_DATE_LABEL}
            style={{ ...EDIT_FIELD_STYLE, maxWidth: 220, marginTop: 8 }} />
        )}
        {dateRefused && (
          <div role="alert" data-testid={`ed-discard-error-${rec.id}`}
            style={{ marginTop: T.space.xs, color: P.terra, fontSize: T.type.sm }}>{DISCARD_DATE_TEXT}</div>
        )}
        {/* The row sheet's sentence, under the same condition the sheet says it: while the date is the
            house's. It says "This date is a house estimate", which stops being true of a date he sets
            himself and of no date at all, so it is said under "Work it out" only. */}
        {HOUSE_SOURCED_SHELF_LIFE.has(method) && discardMode === 'auto' && (
          <p role="note" data-testid={`ed-house-${rec.id}`}
            style={{ margin: `${T.space.xs}px 0 0`, color: P.mid, fontSize: T.type.sm }}>{HOUSE_DETAIL_TEXT}</p>
        )}
      </div>
      {sourceOffered && (
        <div style={{ marginTop: T.space.sm }}>
          <WhereFromField kind={sourceKind} label={sourceLabel} heading={EDIT_SOURCE_HEADING} idPrefix={`ed-${rec.id}`}
            invalid={!!sourceRefused}
            onChange={({ kind, label }) => { setSourceKind(kind); setSourceLabel(label); setSourceRefused(null) }} />
          {sourceRefused && (
            <div role="alert" data-testid={`ed-source-error-${rec.id}`}
              style={{ marginTop: T.space.xs, color: P.terra, fontSize: T.type.sm }}>{sourceRefused}</div>
          )}
        </div>
      )}
      <div style={{ marginTop: T.space.sm }}>
        <Field label="Notes" htmlFor={`ed-notes-${rec.id}`} optional>
          <Textarea id={`ed-notes-${rec.id}`} value={notes} onChange={e => setNotes(e.target.value)}
            aria-label="Notes" style={{ height: 60, resize: 'vertical' }} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: T.space.sm, marginTop: 12 }}>
        <Button type="button" variant="primary" loading={busy} loadingLabel="Saving…" onClick={save}>Save</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}

export { ymd }
