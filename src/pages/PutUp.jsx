// src/pages/PutUp.jsx
// V4-HARVESTCENTER-001 "Put-Up" — the post-harvest preservation log + "what's put up" read surface.
// Route-backed, overlayable (App.jsx renderRoutes, path /put-up); when the OVERLAY flag is on it opens
// as a Sheet flyover (OverlayHost) and when off it renders full-page — byte-identical route element.
//
// TWO views behind a segmented toggle (design V101 §4):
//   'log'    — the put-up form. PROGRESSIVE DISCLOSURE: crop + quantity are the 2 required fast-path
//              fields; method / storage / use-by are shown pre-defaulted; photo/notes/#packages hide
//              behind a "More" reveal. Prefilled from location.state.prefill when launched off the
//              harvest-log "preserve this?" trigger (L9); else the user picks a crop.
//   'stores' — "what's put up": grouped inventory (default by storage location, one-tap regroup by
//              crop), numbers-first headline per group (package count + the distinct units present,
//              NEVER summed across incompatible units — L5), NULL storage → "Unassigned". Per-row
//              edit + soft-delete + a minimal "mark used / used up" decrement (L4).
//
// Rules honored: Reward-UX (cadence-utility, no streak/celebration/interrupt); Soft-Delete (deleted
// rows vanish from the read surface — the Lambda filters deleted_at IS NULL, we just refetch);
// Cross-Device (all state server-side). Offline = require-online: the save is blocked with a clear
// "can't save offline" state that PRESERVES entered input (no draft queue in V100 — tech-debt).
import React, { useState, useEffect, useCallback, useMemo, useId, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
// V4-PUTUPENGINE-001 slice 2 — harvest -> put-up prefill mapping lives in its own pure module
// because the two tables' unit vocabularies disagree (see the UNIT_GROUPS comment below, which
// named this hazard before anything consumed it).
import { prefillFromHarvestEntry, harvestPickLabel, harvestPickAmount } from '../lib/putUpPrefill.js'
import { useCropTypes } from '../hooks/useCropTypes.js'
import { useCachedFetch } from '../hooks/useCachedFetch.js'
import { P } from '../lib/constants.js'
import { T } from '../lib/tokens.js'
import { Field, Input, Select, Textarea, Button, ErrorBanner, SegmentedControl } from '../components/forms'
import VarietyPicker from '../components/VarietyPicker.jsx'
import PlantingSelect, { plantingWaveLabel } from '../components/forms/PlantingSelect.jsx'
import PutUpPhotoThumb from '../components/PutUpPhotoThumb.jsx'
import { useUploadPhoto } from '../hooks/useUploadPhoto.js'
import { PUTUP_SOURCE_OPTIONS, PUTUP_SOURCE_LABELS } from '../lib/dropdownRegistry.js'
// V4-RELOADGATEWIRE-001 — the same three-part form-guard EventNew/LogMany carry: a versioned
// sessionStorage draft (survives a dismiss/reload), the Sheet backdrop-tap guard, and the SW
// reload deferral. TWO predicates, exactly as EventNew splits them — see `dirty` and `guardDirty`
// below for what each one asks and why one shared predicate could not answer both.
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { setReloadBlocked } from '../lib/reloadGate.js'
import { useReportOverlayDirty, useInOverlaySurface } from '../context/OverlayContext.jsx'
// V4-PUTUPSESSION-001 slice 0 — the freezer walk. A MODE FLAG on this page (?session=putup), not a
// new page, a new endpoint or a new table, copying the weigh-in's shape rather than editing it
// (EventNew.jsx is frozen: OPS-WEIGHINUXFROZEN-001).
import NumberPad from '../components/NumberPad.jsx'
// V5-INFLIGHTBATCH-001 slice "going now" — a THIRD view behind the same segmented toggle. Same
// reason ?session=putup is a mode flag rather than a page: the app has a three-times-repeated
// pattern for "a thing you are in the middle of" and it is never a new destination.
import GoingNowView from '../components/putup/GoingNowView.jsx'
import BatchDetailView from '../components/putup/BatchDetailView.jsx'
import ClosedBatchesView from '../components/putup/ClosedBatchesView.jsx'
import { useSuppressBottomNav } from '../hooks/useSuppressBottomNav.js'
import {
  WALK_PARAM, coarseDate, exactDate, describeDate, describeApprox, solePlanting, unrecordedCrops,
  readWalk, writeWalk, clearWalk, readDismissed, dismissCrop,
} from '../lib/putUpSession.js'

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
const CANNING_METHODS = new Set(['can_water_bath', 'can_pressure'])

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

// The claim itself, in ONE place, because it is the load-bearing sentence rather than decoration:
// it is what makes a use-by nobody can cite honest to the person reading it. Each surface appends
// its own call to action; none of them may reword the claim, and none of them may describe the
// figure as Extension- or USDA-backed — a search of NCHFP, UGA, Penn State, OSU, UMN, USU, MSU and
// NC State found no home guidance on candied-fruit storage at all.
//
// WORDED TO STAY TRUE AFTER AN OVERRIDE, which is why it says "the automatic date" rather than "this
// date". A row carries no flag distinguishing a use_by_target the server defaulted from one the cook
// typed (unlike preserved_at_approx, which does), so a line claiming THIS date came from the guide
// would start lying the moment someone did the thing the line asks them to do.
const HOUSE_ESTIMATE_CLAIM =
  'There’s no published guidance on how long candied fruit keeps, so this use-by is ours rather than ' +
  'a tested one — the automatic date comes from our own candying guide.'

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
// STILL NO DB CHECK ON quantity_unit, and that is now a considered decision rather than an omission.
// The original plan called for adding one. An audit of live data killed it: harvest_log stores
// SINGULAR units ('cup', 'count', 'head', 'bunch' on prod) while this pick-list is PLURAL ('cups',
// 'lbs'), so the two tables already disagree despite the preservation_log DDL claiming to mirror
// harvest_log's convention — it mirrors the shape, not the vocabulary. A CHECK pinned to this list
// would 400 any future harvest-to-put-up prefill that copies harvest_log.unit, and would also break
// 31 integration writes of 'lb'. The column has no free-text path from the app anyway (every write
// comes from this dropdown), so the CHECK would buy little and risk a lot. Reconciling the two
// vocabularies is its own piece of work and must not be smuggled into a units addition.
// EXPORTED for src/__tests__/putUpPrefill.test.js only. V4-PUTUPENGINE-001 slice 2 maps harvest
// units into this vocabulary, and the guard that every mapped value is a REAL option here has to
// read the real list — a hand-copied duplicate in the test would drift silently and certify nothing
// (L-384: don't duplicate a constant to dodge a dependency). Nothing in src/ imports it.
export const UNIT_GROUPS = [
  { group: 'Weight',     options: ['lbs', 'oz'] },
  { group: 'Count',      options: ['count'] },
  { group: 'Volume',     options: ['cups', 'pints', 'quarts'] },
  { group: 'Bulk',       options: ['bushels', 'half-bushels', 'pecks', 'flats'] },
  { group: 'Containers', options: ['jars', 'bags'] },
]

const STORAGE_KINDS = [
  { value: 'deep_freezer',   label: 'Deep freezer' },
  { value: 'fridge_freezer', label: 'Fridge freezer' },
  { value: 'fridge',         label: 'Fridge' },
  { value: 'pantry',         label: 'Pantry' },
  { value: 'cold_storage',   label: 'Cold storage / root cellar' },
  { value: 'other',          label: 'Other' },
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
function todayYMD() { return ymd(new Date()) }

// V4-RELOADGATEWIRE-001 — draftStash route key for the log form. Route-shaped ('put-up', matching
// the /put-up path), NOT the unseparated style LogMany uses ('logmany'); draftStash namespaces per
// key, so the two spellings coexist and neither is canonical. Do not "harmonize" this — renaming
// the key silently orphans every draft already sitting in a user's sessionStorage.
const DRAFT_KEY = 'put-up'

// BUG-PUTUPSTASHHARVLINK-001 — the IDENTITY of the prefill context a mount is in, stamped into every
// snapshot so a later mount can ask "is this the same context?" instead of only "is there a prefill
// at all?". Covers all four fields PutUp() reads off location.state.prefill: arriving from a
// DIFFERENT harvest, or from a crop-only prefill, is a different context and must not resume.
// BARE_PREFILL_KEY (no prefill) is a value, not an absence, so it compares like any other context.
// Falsy fields collapse to '' to keep this exactly as permissive as the truthiness test it replaced.
export function prefillContextKey(prefill) {
  const p = prefill || {}
  return [p.crop_type_slug, p.variety_id, p.plant_id, p.harvest_log_id].map(v => (v ? String(v) : '')).join('|')
}
export const BARE_PREFILL_KEY = prefillContextKey({})

function prettyDate(v) {
  const s = ymd(v)
  if (!s) return ''
  const d = new Date(s + 'T00:00:00')
  return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

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


export default function PutUp() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // V4-PUTUPSESSION-001. ONE derived predicate for the whole walk, so there is no way to ship half
  // of it — the same shape EventNew's `inHarvestSession = param && !inOverlay` uses, and for the
  // same reason: the walk's fixed bottom band and BottomNav suppression cannot survive inside a
  // Sheet, so in an overlay the param degrades to a plain deep link to the ordinary page.
  const inOverlay = useInOverlaySurface()
  const inWalk = searchParams.get('session') === WALK_PARAM && !inOverlay
  const prefill = (location.state && typeof location.state.prefill === 'object' && location.state.prefill) || {}
  const prefillKey = prefillContextKey(prefill)
  const hasPrefill = prefillKey !== BARE_PREFILL_KEY

  // Adaptive default: a harvest-triggered open lands on the form; a bare "Put-Up" tap lands on the
  // inventory ("what have I got?") — the more common intent from the More menu. V5-INFLIGHTBATCH-001
  // promotes a bare open to 'going' the moment there is anything to check; see autoDefaultedRef.
  const [view, setView] = useState(hasPrefill ? 'log' : 'stores')
  // Set the moment the user picks a view themselves. The auto-default below is a DEFAULT, not a
  // preference — it may never move someone off a segment they chose or off a form they are typing in.
  const viewTouchedRef = useRef(false)
  const chooseView = useCallback((v) => { viewTouchedRef.current = true; setView(v) }, [])

  // ── V5-INFLIGHTBATCH-001 — open batches, fetched at the PAGE and passed down ───────────────────
  // The page owns this fetch rather than GoingNowView, because the default-view decision below needs
  // the count on every open regardless of which segment renders. One GET, not two.
  //
  // Three-valued on purpose, and the third value is the load-bearing one: `null` means "not loaded,
  // or the route is unavailable". Until the migration is applied to a database the route 500s, and
  // in that state this page must behave EXACTLY as it does today — no flip, no banner, no change to
  // the bare-open landing. Only an array is an answer.
  const { fetch: pageFetch } = useApiFetch()
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
  // `batch` wins over `state`: opening a batch FROM the closed list must show that batch.
  const batchId = searchParams.get('batch')
  const closedMode = !batchId && searchParams.get('state') === 'closed'
  const modeActive = !!batchId || closedMode

  // ONE instant for the detail surface, collapsed once per opened batch — GoingNowView.jsx:221-225's
  // rule applied at the page. PutUp is a route element and takes no props, so it cannot receive an
  // injected clock; the injection point is BatchDetailView's own `nowMs` prop, which is where a test
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

  // Leaving a mode drops only the mode keys, so ?session= and anything a future door adds survive.
  const leaveMode = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.delete('batch'); next.delete('state')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  // THE BARE-OPEN DEFAULT. A bare Put-Up open landing on "what have I got" is correct today and
  // wrong the moment batches exist, because the answer to "what is going on right now" would then be
  // one tap further away than the answer to a question nobody asked. This one flip takes "what needs
  // me" to ONE tap from app open and is the entire discoverability fix — no Today band, no new tab,
  // no new surface of any kind.
  //
  // Decided ONCE, on the first load that produces an answer, and never revisited: a late-arriving
  // fetch may not yank someone off a form (the prefill path lands on 'log', and clearPrefill leaves
  // them there with hasPrefill false) or off a segment they chose. Hence both guards plus the
  // view === 'stores' check, which is the state this flip is defined to replace.
  const autoDefaultedRef = useRef(false)
  useEffect(() => {
    if (autoDefaultedRef.current || !Array.isArray(going)) return
    autoDefaultedRef.current = true
    if (!going.length || viewTouchedRef.current || view !== 'stores') return
    setView('going')
  }, [going, view])

  // V4-PUTUPENGINE-001 slice 2 — picking a recent harvest navigates IN PLACE with a new prefill.
  // That reuses the one prefill door PreserveOffer / PutUpFromPlanting / PutUpUseSoonBand already
  // use, so BUG-PUTUPSTASHHARVLINK-001's context-identity guard keeps working with no new
  // mechanics. But the useState initialiser above already ran, so it cannot see the new context —
  // this drives the view exactly as a fresh mount would have.
  //
  // Keyed on the CONTEXT KEY, never on the prefill object: every navigation builds a fresh object
  // literal, so an object-identity dep would re-fire on every render and pin the user in 'log'.
  const lastPrefillKeyRef = useRef(prefillKey)
  useEffect(() => {
    if (prefillKey === lastPrefillKeyRef.current) return
    lastPrefillKeyRef.current = prefillKey
    if (prefillKey !== BARE_PREFILL_KEY) setView('log')
  }, [prefillKey])

  const pickHarvest = useCallback((entry) => {
    // `replace` so the back button leaves /put-up rather than walking the user back through each
    // harvest they auditioned.
    navigate(location.pathname, { state: { prefill: prefillFromHarvestEntry(entry) }, replace: true })
  }, [navigate, location.pathname])

  // Back to a BARE context: drops the harvest link, remounts the form, restores the picker. The
  // effect above deliberately does NOT force view='log' for the bare key, so the caller's current
  // view stands — which is what we want, since the user is still mid-log.
  const clearPrefill = useCallback(() => {
    navigate(location.pathname, { state: null, replace: true })
  }, [navigate, location.pathname])

  // Declared AFTER every hook above, so the walk branch cannot reorder them.
  if (inWalk) return <PutUpWalk />

  // The segment bodies stand down while a mode is open. `view` itself is untouched, which is the
  // whole point of the mode flag: leaving the mode restores the segment the user was on instead of
  // remounting the page onto 'stores' behind a network round trip.
  const seg = modeActive ? null : view

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '24px 18px 80px' }}>
        {/* V4-PUTUPSESSION-001 — the walk's door, on the title line and DELIBERATELY NOT a
            full-width filled primary CTA. That shape is what V4-WEIGHINCTA-001 shipped for the
            weigh-in and it was reversed; this copies the reversal, not the original. */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: T.space.sm, margin: '0 0 4px' }}>
          <h1 style={{ margin: 0, flex: 1, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Put-Up</h1>
          {!modeActive && (
            <button type="button" onClick={() => navigate(`/put-up?session=${WALK_PARAM}`)}
              data-testid="putup-walk-door"
              style={{ background: 'none', border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton,
                color: P.green, fontSize: T.type.sm, fontWeight: 700, fontFamily: 'inherit',
                padding: '6px 12px', minHeight: 36, cursor: 'pointer', flexShrink: 0 }}>
              🧊 Freezer walk
            </button>
          )}
        </div>

        {/* THE WAY BACK, in the page rather than in the browser chrome. An installed PWA has no
            address bar and no visible Back control (App.jsx records exactly this hazard for /admin/*),
            so a mode with no in-page exit is a mode a user can be stuck in. History Back also works
            and lands in the same place, because the mode is a search param on this same route. */}
        {modeActive && (
          <button type="button" onClick={leaveMode} data-testid="putup-mode-back"
            style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
              background: 'none', border: 'none', padding: '2px 8px 2px 0', margin: '2px 0 8px',
              cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
            ← Going now
          </button>
        )}

        {!modeActive && (
          <p style={{ margin: '0 0 16px', fontSize: '0.84rem', color: P.light }}>
            What you&rsquo;ve preserved — your freezer, pantry and stores.
          </p>
        )}

        {/* The "start something new" slot every other landing page has and this one did not:
            /harvests carries a full-width filled Weigh-in-session CTA above its view controls
            (V4-WEIGHINCTA-001 — "a doorway you have to already know about cannot buy that"). The
            segmented control below switches VIEWS; this starts the primary ACTION. Only rendered on
            the read view — on the form it would be a button that does nothing. */}
        {seg === 'stores' && (
          <button type="button" onClick={() => chooseView('log')} data-testid="putup-primary-cta"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              width: '100%', minHeight: T.buttonMinHeight, marginBottom: 14, backgroundColor: P.green, color: P.white,
              border: 'none', borderRadius: T.radiusCard, fontSize: T.type.md, fontWeight: 700,
              fontFamily: 'inherit', cursor: 'pointer' }}>
            <span aria-hidden="true">🫙</span><span>Log a put-up</span>
          </button>
        )}

        {/* LIFECYCLE ORDER, left to right: going → logged → stored. That is time order, which is
            the one arrangement a user can predict without reading. The grammar was already
            inconsistent (a VERB beside a QUESTION) and a third label had to join it; "Going now"
            names the OBJECT's state, which is what the other two labels are really doing too.
            Three options is still inside the ≤4 the page holds itself to. */}
        {!modeActive && (
          <div style={{ marginBottom: 18 }}>
            <SegmentedControl
              ariaLabel="Put-Up view"
              value={view}
              onChange={chooseView}
              options={[
                { value: 'going',  label: 'Going now' },
                { value: 'log',    label: 'Log a put-up' },
                { value: 'stores', label: "What's put up" },
              ]}
            />
          </div>
        )}

        {seg === 'log' && !hasPrefill && <RecentHarvestPicker onPick={pickHarvest} />}

        {/* The correction path. harvest_log_id has NO control on the form below — that invisibility
            is the whole substance of BUG-PUTUPSTASHHARVLINK-001 — so before this slice a wrong link
            could neither be seen nor cleared. Now that a mis-tap in the picker can create one, it
            needs an exit. Clearing navigates back to a BARE context, which remounts the form and
            brings the picker back. Also serves the older PreserveOffer path, which never had one. */}
        {seg === 'log' && hasPrefill && (
          <div data-testid="putup-prefill-strip"
            style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, marginBottom: 14, padding: '9px 12px',
              backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: T.type.sm, color: P.green, fontWeight: 600 }}>
              {prefill.harvest_log_id ? 'Linked to a harvest' : 'Prefilled'}
            </span>
            <button type="button" onClick={clearPrefill} data-testid="putup-prefill-clear"
              style={{ background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer',
                color: P.green, fontSize: '0.8rem', fontWeight: 700, fontFamily: 'inherit',
                textDecoration: 'underline', minHeight: 32 }}>
              Change
            </button>
          </div>
        )}

        {seg === 'going' && (
          <GoingNowView batches={going} loading={goingLoading} error={goingError} onReload={loadGoing} />
        )}
        {seg === 'log' && <PutUpForm key={prefillKey} prefill={prefill} onLogged={() => chooseView('stores')} />}
        {seg === 'stores' && <StoresView />}

        {/* The batch's own surface. Controlled — it issues no GET of its own, so `onChanged` is the
            only invalidation path and it re-reads BOTH this row and the list. */}
        {batchId && (
          <div data-testid="putup-batch-mode">
            <BatchDetailView
              batch={detail} inputs={detail?.inputs ?? []} stages={detail?.stages ?? []}
              outputs={detail?.outputs ?? []} loading={detailLoading} error={detailError}
              nowMs={detailNowMs} onChanged={onBatchChanged} />
          </div>
        )}

        {closedMode && (
          <div data-testid="putup-closed-mode">
            <ClosedBatchesView batches={closed} loading={closedLoading} error={closedError}
              onReload={onClosedChanged} now={detailNowMs} />
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// V4-PUTUPSESSION-001 slice 0 — the freezer walk
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM, in Dave's words (2026-08-25): "I still put up a ton (all of the blueberries have
// been put up, but not recorded in the app) — I just don't have a ton of time in the middle of
// harvest season to do it." Capture friction is NOT the complaint; TIMING is. The measured cost:
// 48 blueberry harvests, 37.2 lb, exactly ONE planting, and zero put-up rows.
//
// So this is a RETROSPECTIVE surface. It asks the two questions a freezer walk can answer once —
// which freezer, roughly when — applies both to every save in the sitting, and then asks per item
// only for the thing he can actually observe standing there: HOW MANY BAGS. It never proposes a
// quantity from harvest weight (the app knows 37.2 lb and must not offer it — a number the app
// invented is indistinguishable from one he counted the moment it is stored).
//
// Modelled on the weigh-in and DELIBERATELY NOT EDITING IT. Copied: the mode-flag predicate, the
// BottomNav suppression, the sticky answers across the sitting, one write per item, an exit control
// built in from the start (the weigh-in needed one added retroactively — V4-WEIGHSESSIONCLOSE-001).
// NOT copied: the fixed 3-track 100dvh grid (that geometry was measured for two number pads and a
// ledger, not for this form) and the 56px pad keys (V4-PADTARGETSIZE-001, unshipped, measured to
// push a pad row under a sticky band). Not built at all: a worklist with ticks, a denominator or
// auto-advance — Dave had exactly that deleted from the weigh-in (V4-WEIGHQUEUEKILL-001).
const WALK_BAND_FALLBACK_PX = 96   // jsdom and pre-measure paints only; the live value is measured

function PutUpWalk() {
  const navigate = useNavigate()
  const { fetch } = useApiFetch()
  useSuppressBottomNav(true)

  // The stash is read ONCE, lazily, so a re-render can never resurrect a walk that was just exited.
  const [walk, setWalk] = useState(() => readWalk())
  const [resumed] = useState(() => !!readWalk())
  const [editingSetup, setEditingSetup] = useState(() => !readWalk())
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  const [storageLocations, setStorageLocations] = useState([])
  // { id, text, undone, error } — the LAST item saved in this sitting. Deliberately not restored
  // from the stash: an "Undo" offered for something saved yesterday evening is not what undo means.
  const [lastSaved, setLastSaved] = useState(null)
  const [bandH, setBandH] = useState(WALK_BAND_FALLBACK_PX)
  const bandRef = useRef(null)

  // The offline PRE-FLIGHT (design §5.1.6). Put-Up refuses to save anything offline
  // (handleSubmit's first branch), so without this the worst failure mode is thirty minutes of
  // walking followed by twenty items identified and none saved. Checking BEFORE the walk turns that
  // into a five-second one. navigator.onLine === false means the OS reports no network at all, so
  // it is trustworthy in the blocking direction (its unreliability is the other way — online:true
  // with no real connectivity), which is why this gate is safe to make hard.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  useEffect(() => {
    let live = true
    fetch('/api/storage-locations')
      .then(rows => { if (live) setStorageLocations(Array.isArray(rows) ? rows : []) })
      .catch(() => { /* non-fatal — the walk still runs with Unassigned */ })
    return () => { live = false }
  }, [fetch])

  // The band's height is MEASURED, not assumed. It grows the moment the first item lands (a saved
  // line + Undo appear), and the scroller's bottom padding is what guarantees every control below
  // it — including the number pad's last row — can be scrolled clear of it. Assuming a constant is
  // exactly how the weight pad ended up 15px inside the weigh-in's band (BUG-WEIGHPADSAVEBAND-001).
  useEffect(() => {
    const el = bandRef.current
    if (!el) return undefined
    const measure = () => setBandH(Math.round(el.getBoundingClientRect().height) || WALK_BAND_FALLBACK_PX)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [editingSetup, lastSaved])

  const exitWalk = useCallback(() => {
    clearWalk()
    navigate('/put-up', { replace: true })
  }, [navigate])

  const startWalk = useCallback((answers) => {
    const next = { ...answers, savedCount: walk?.savedCount ?? 0, cropSlug: walk?.cropSlug ?? '' }
    writeWalk(next)
    setWalk(next)
    setEditingSetup(false)
  }, [walk])

  // One item saved. The row is already durable in the database — this only advances the PLACE the
  // stash remembers, so a walk torn down by the launcher comes back on the same freezer, the same
  // date and the same crop.
  const onSaved = useCallback((row, text) => {
    setLastSaved({ id: row?.id ?? null, text, undone: false, error: null })
    setWalk(w => {
      const next = { ...w, savedCount: (w?.savedCount ?? 0) + 1, cropSlug: row?.crop_type_slug ?? w?.cropSlug ?? '' }
      writeWalk(next)
      return next
    })
  }, [])

  // Undo = the sanctioned soft-delete, the same DELETE the inventory's per-row delete uses. An
  // undone item stays on screen struck through rather than vanishing: the band is an honest record
  // of what happened, not a mutable cart.
  const undoLast = useCallback(async () => {
    if (!lastSaved?.id || lastSaved.undone) return
    try {
      await fetch(`/api/preservation/${lastSaved.id}`, { method: 'DELETE' })
      setLastSaved(s => (s ? { ...s, undone: true, error: null } : s))
      setWalk(w => {
        const next = { ...w, savedCount: Math.max(0, (w?.savedCount ?? 1) - 1) }
        writeWalk(next)
        return next
      })
    } catch {
      setLastSaved(s => (s ? { ...s, error: "Couldn't undo — try again." } : s))
    }
  }, [fetch, lastSaved])

  const walkStorageId = walk?.storageId ?? ''
  const walkDate = walk?.date ?? ''
  const walkApprox = !!walk?.dateApprox
  const walkCrop = walk?.cropSlug ?? ''
  const session = useMemo(
    () => (walkDate ? { storageId: walkStorageId, date: walkDate, dateApprox: walkApprox, cropSlug: walkCrop } : null),
    [walkStorageId, walkDate, walkApprox, walkCrop],
  )
  const storageLabel = storageLocations.find(s => String(s.id) === String(walkStorageId))?.label
    || (walkStorageId ? 'this freezer' : 'Unassigned')

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: `16px 18px ${bandH + 28}px` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: T.space.sm, marginBottom: 4 }}>
          <h1 style={{ margin: 0, flex: 1, color: P.green, fontSize: '1.2rem', fontWeight: 700 }}>
            🧊 Freezer walk
          </h1>
          {editingSetup && (
            <button type="button" onClick={exitWalk} data-testid="putup-walk-setup-exit"
              style={{ background: 'none', border: 'none', color: P.mid, fontSize: T.type.sm,
                fontWeight: 600, fontFamily: 'inherit', textDecoration: 'underline',
                padding: '4px 0', minHeight: 32, cursor: 'pointer' }}>
              Not now
            </button>
          )}
        </div>

        {editingSetup ? (
          <WalkSetup
            online={online}
            initial={walk}
            resumed={resumed}
            storageLocations={storageLocations}
            onStart={startWalk}
            fetch={fetch}
            onCreated={(row) => setStorageLocations(list => [...list, row])}
          />
        ) : (
          <>
            {resumed && (
              <div data-testid="putup-walk-resumed" role="status"
                style={{ marginBottom: 14, padding: '9px 12px', fontSize: T.type.sm, color: P.green,
                  backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton }}>
                Picked up where you left off{walk?.savedCount ? ` — ${walk.savedCount} logged so far` : ''}.
              </div>
            )}
            <UnrecordedLine fetch={fetch} />
            <PutUpForm
              prefill={{}}
              session={session}
              onSaved={onSaved}
              onLogged={exitWalk}
            />
          </>
        )}
      </div>

      {/* The band. Fixed to the bottom because BottomNav is suppressed, so `bottom: 0` is the real
          bottom of the device rather than 56px above it. Everything above scrolls past it. */}
      {!editingSetup && (
        <div ref={bandRef} data-testid="putup-walk-band"
          style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30,
            backgroundColor: P.white, borderTop: `1px solid ${P.border}`,
            padding: '10px 18px calc(10px + env(safe-area-inset-bottom))' }}>
          {lastSaved && (
            <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, marginBottom: 6 }}>
              <span data-testid="putup-walk-last"
                style={{ flex: 1, minWidth: 0, fontSize: T.type.sm, color: lastSaved.undone ? P.light : P.dark,
                  textDecoration: lastSaved.undone ? 'line-through' : 'none',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {lastSaved.undone ? 'Undone' : '✓'} {lastSaved.text}
              </span>
              {!lastSaved.undone && lastSaved.id && (
                <button type="button" onClick={undoLast} data-testid="putup-walk-undo"
                  style={{ background: 'none', border: 'none', color: P.terra, fontSize: T.type.sm,
                    fontWeight: 700, fontFamily: 'inherit', textDecoration: 'underline',
                    padding: '4px 2px', minHeight: 36, cursor: 'pointer', flexShrink: 0 }}>
                  Undo
                </button>
              )}
            </div>
          )}
          {lastSaved?.error && (
            <div role="alert" style={{ fontSize: '0.78rem', color: P.terra, marginBottom: 6 }}>{lastSaved.error}</div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: '0.78rem', color: P.light,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {storageLabel} · {describeDate(walkDate, walkApprox)}
            </span>
            <button type="button" onClick={() => setEditingSetup(true)} data-testid="putup-walk-change"
              style={{ background: 'none', border: 'none', color: P.green, fontSize: '0.78rem',
                fontWeight: 700, fontFamily: 'inherit', textDecoration: 'underline',
                padding: '4px 2px', minHeight: 36, cursor: 'pointer', flexShrink: 0 }}>
              Change
            </button>
            <button type="button" onClick={exitWalk} data-testid="putup-walk-exit"
              style={{ background: 'none', border: `1px solid ${P.border}`, borderRadius: T.radiusButton,
                color: P.mid, fontSize: '0.78rem', fontWeight: 700, fontFamily: 'inherit',
                padding: '6px 12px', minHeight: 36, cursor: 'pointer', flexShrink: 0 }}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// The two questions, asked ONCE (design §3.3). A freezer walk has strong locality — that is the
// lever that makes this cheap. The freezer is the field most likely to be right for a whole sitting
// at once, and the date is the field retrospection cannot supply truthfully.
//
// The words "project" and "container" appear nowhere here. Dave has no concept of a Project, and
// "container" is already spent on a package elsewhere in this file: the labels are freezer and bag.
function WalkSetup({ online, initial, resumed, storageLocations, onStart, onCreated, fetch }) {
  const today = todayYMD()
  const [storageId, setStorageId] = useState(initial?.storageId ?? '')
  const [storagePicked, setStoragePicked] = useState(!!initial)
  const [elsewhere, setElsewhere] = useState(false)
  const [dateChoice, setDateChoice] = useState(initial?.dateChoice ?? '')
  const [exactYmd, setExactYmd] = useState(initial && !initial.dateApprox ? initial.date : '')

  const summer = coarseDate('summer', today)
  const earlier = coarseDate('earlier', today)
  const resolved = dateChoice === 'exact'
    ? exactDate(exactYmd)
    : dateChoice === 'summer' ? summer : dateChoice === 'earlier' ? earlier : null

  const canStart = online && storagePicked && !!resolved

  function pickFreezer(id) { setStorageId(id); setStoragePicked(true); setElsewhere(false) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space.md }}>
      {!online && (
        <div role="alert" data-testid="putup-walk-offline"
          style={{ padding: '12px 14px', fontSize: T.type.sm, lineHeight: 1.45, color: P.bannerInk,
            backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: T.radiusButton }}>
          <strong>You&rsquo;re offline — nothing you log here will save.</strong> Put-ups need a
          connection. Better to find out now than after a walk round the freezers. This clears itself
          the moment you&rsquo;re back on.
        </div>
      )}

      <Card>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: P.dark, marginBottom: 10 }}>
          Which freezer are you at?
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: T.space.sm }}>
          {storageLocations.map(l => (
            <WalkChip key={l.id} selected={storagePicked && String(storageId) === String(l.id)}
              testId="putup-walk-freezer" onClick={() => pickFreezer(String(l.id))}>
              {l.label}
            </WalkChip>
          ))}
          <WalkChip selected={elsewhere} testId="putup-walk-freezer-else"
            onClick={() => { setElsewhere(true); setStoragePicked(true); setStorageId('') }}>
            ＋ Somewhere else
          </WalkChip>
        </div>
        {elsewhere && (
          <div style={{ marginTop: 14 }}>
            {/* The shipped storage field, reused whole rather than re-implemented — it already owns
                the "＋ New location" creator and its BUG-PUTUPLOC-001 retry. */}
            <StorageField
              value={storageId}
              onChange={setStorageId}
              locations={storageLocations}
              onCreated={(row) => { onCreated(row); setStorageId(String(row.id)) }}
              fetch={fetch}
            />
          </div>
        )}
      </Card>

      <Card>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: P.dark, marginBottom: 4 }}>
          Roughly when did you put this up?
        </div>
        <div style={{ fontSize: '0.8rem', color: P.light, marginBottom: 10 }}>
          A rough answer is a real answer — you can change it on any single item.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: T.space.sm }}>
          {summer && (
            <WalkChip selected={dateChoice === 'summer'} testId="putup-walk-date"
              onClick={() => setDateChoice('summer')}>This summer</WalkChip>
          )}
          {earlier && (
            <WalkChip selected={dateChoice === 'earlier'} testId="putup-walk-date"
              onClick={() => setDateChoice('earlier')}>Earlier this year</WalkChip>
          )}
          <WalkChip selected={dateChoice === 'exact'} testId="putup-walk-date"
            onClick={() => setDateChoice('exact')}>Pick a date</WalkChip>
        </div>
        {dateChoice === 'exact' && (
          <div style={{ marginTop: 12 }}>
            <Field label="Put-up date" htmlFor="pu-walk-date">
              <Input id="pu-walk-date" type="date" value={exactYmd} max={today}
                onChange={e => setExactYmd(e.target.value)} aria-label="Put-up date" />
            </Field>
          </div>
        )}
        {/* The resolved date is SHOWN, never hidden. A coarse button that silently writes a date
            nobody looked at is the "a wrong default launders a wrong decision" failure; a default
            he is shown before he starts is a fact he can catch. Slice 0 has no column for the
            approximate flag yet, so this sentence is the only thing carrying it — say it plainly. */}
        {resolved && (
          <div data-testid="putup-walk-date-resolved"
            style={{ marginTop: 12, fontSize: T.type.sm, color: P.mid }}>
            Everything in this walk gets recorded as <strong>{describeDate(resolved.date, resolved.approx)}</strong>
            {resolved.approx ? ' — an estimate, not a date you picked.' : '.'}
          </div>
        )}
      </Card>

      <Button type="button" variant="primary" disabled={!canStart}
        data-testid="putup-walk-start"
        onClick={() => onStart({
          storageId,
          date: resolved.date,
          dateApprox: resolved.approx,
          dateChoice,
        })}>
        {resumed ? 'Back to the walk' : 'Start the walk'}
      </Button>
    </div>
  )
}

function WalkChip({ selected, onClick, children, testId }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected} data-testid={testId}
      style={{ minHeight: T.tapMinHeight, padding: '10px 14px', borderRadius: T.radiusButton,
        border: `1px solid ${selected ? P.green : P.border}`,
        backgroundColor: selected ? P.greenPale : P.white,
        color: selected ? P.green : P.dark, fontWeight: selected ? 700 : 600,
        fontSize: '0.9rem', fontFamily: 'inherit', cursor: 'pointer' }}>
      {children}
    </button>
  )
}

// "What haven't I put up?" (design §6 Q4) — ONE collapsed line, no ticks, no denominator, no
// ordering, no auto-advance. Dave asked for it with a constraint in his own words: "it cannot be a
// forever nag — i pick watermelons for example but mostly eat them fresh, not freezing."
//
// Two things answer that constraint:
//   1. COLLAPSED IT MAKES NO ACCUSATION. The line carries no count until he opens it, so the walk
//      never greets him with a number of things he has "failed" to record. It is also why the
//      season-wide aggregates scan is deferred to the tap rather than run on entry.
//   2. EVERY CROP IS DISMISSIBLE, AND THE DISMISSAL STICKS. "Not one I put up" is the label —
//      not "done" — because watermelon is not an outstanding task, it is a crop that will never
//      belong on this list. localStorage, per crop, no schema.
function UnrecordedLine({ fetch }) {
  const [open, setOpen] = useState(false)
  // `wanted` only ever goes false -> true, and that is the whole point. Keying the fetch on `open`
  // (which flips back) or on `state.loading` (which this effect sets itself) makes the effect
  // cancel its OWN in-flight request through its cleanup and then decline to retry — the panel sits
  // on "Checking…" forever. Caught by the test below, which is why it is a monotone latch.
  const [wanted, setWanted] = useState(false)
  const [state, setState] = useState({ loading: false, failed: false, crops: null })
  const [dismissed, setDismissed] = useState(() => readDismissed())

  useEffect(() => {
    if (!wanted) return undefined
    let live = true
    setState({ loading: true, failed: false, crops: null })
    Promise.all([
      fetch('/api/harvests?include=aggregates'),
      fetch('/api/preservation/whats-put-up?group=crop'),
    ])
      .then(([h, p]) => {
        if (!live) return
        const putUp = (p?.groups ?? []).flatMap(g => [
          g.group_key,
          ...(g.records ?? []).map(r => r.crop_type_slug),
        ].filter(Boolean))
        setState({ loading: false, failed: false, crops: h?.aggregates?.crops ?? [], putUp })
      })
      .catch(() => { if (live) setState({ loading: false, failed: true, crops: null }) })
    return () => { live = false }
  }, [wanted, fetch])

  const rows = useMemo(
    () => unrecordedCrops({ harvestCrops: state.crops, putUpSlugs: state.putUp, dismissed }),
    [state.crops, state.putUp, dismissed],
  )

  return (
    <div style={{ marginBottom: 14 }}>
      <button type="button" onClick={() => { setOpen(o => !o); setWanted(true) }} aria-expanded={open}
        data-testid="putup-walk-unrecorded-toggle"
        style={{ background: 'none', border: 'none', padding: '6px 0', cursor: 'pointer',
          color: P.mid, fontSize: T.type.sm, fontWeight: 600, fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', gap: 6, minHeight: 36 }}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>What haven&rsquo;t I put up?</span>
      </button>
      {open && (
        <div data-testid="putup-walk-unrecorded" style={{ paddingLeft: 18 }}>
          {state.loading && <div style={{ fontSize: T.type.sm, color: P.light }}>Checking&hellip;</div>}
          {state.failed && <div style={{ fontSize: T.type.sm, color: P.light }}>Couldn&rsquo;t check just now.</div>}
          {!state.loading && !state.failed && state.crops && rows.length === 0 && (
            <div style={{ fontSize: T.type.sm, color: P.light }}>Nothing outstanding.</div>
          )}
          {rows.map(c => (
            <div key={c.slug} style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, padding: '4px 0' }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: T.type.sm, color: P.dark }}>{c.name}</span>
              <button type="button" onClick={() => setDismissed(dismissCrop(c.slug))}
                data-testid="putup-walk-not-mine"
                style={{ background: 'none', border: 'none', color: P.light, fontSize: '0.76rem',
                  fontWeight: 600, fontFamily: 'inherit', textDecoration: 'underline',
                  padding: '4px 2px', minHeight: 32, cursor: 'pointer', flexShrink: 0 }}>
                Not one I put up
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// V4-PUTUPENGINE-001 slice 2 — "From a recent harvest"
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM THIS SOLVES, in the numbers that justified it: 791 harvests logged in 2026 against 5
// put-up records ever, and 0 of 791 linked. Slice 1 gave Put-Up its own tab, which fixed
// DISCOVERABILITY. What remained is that logging one from the tab means re-entering crop, variety,
// planting, quantity and unit by hand — every one of which the app already knows, because the
// harvest it came from is sitting in the log.
//
// Dave's 0821 ruling made this load-bearing: the put-up page is the ONLY fate capture, and anything
// not put up is assumed eaten fresh. So put-up volume is no longer a nice-to-have — it is the
// signal. Typing friction is the thing suppressing it.
//
// NOT a reward surface (Reward-UX V102): user-initiated, on a surface they navigated to, no
// celebration/nudge/interrupt. It is a picker on a form.
function RecentHarvestPicker({ onPick }) {
  const { fetch } = useApiFetch()
  const [entries, setEntries] = useState(null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let live = true
    // include=entries only — the aggregates half of this endpoint is a full-season scan this
    // picker has no use for.
    fetch('/api/harvests?include=entries')
      .then(d => { if (live) setEntries(Array.isArray(d?.entries) ? d.entries : []) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [fetch])

  // A swallowed fetch error that renders identically to "you have no harvests" is a named defect on
  // the sibling ready-band surface. It gets its own visible state here.
  if (failed) {
    return (
      <div style={{ marginBottom: T.space.md, fontSize: T.type.sm, color: P.mid }}>
        Couldn&rsquo;t load your recent harvests — pick a crop below instead.
      </div>
    )
  }
  if (entries == null) return null           // first paint: no skeleton, the form below is usable
  if (entries.length === 0) return null      // genuinely nothing picked yet — say nothing

  const COLLAPSED = 5
  const shown = expanded ? entries.slice(0, 20) : entries.slice(0, COLLAPSED)
  const hiddenCount = Math.min(entries.length, 20) - shown.length

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: P.mid, marginBottom: 6 }}>
        From a recent harvest
      </div>
      <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusCard, overflow: 'hidden' }}>
        {shown.map((e, i) => {
          const amount = harvestPickAmount(e)
          return (
            <button key={e.event_id ?? i} type="button" onClick={() => onPick(e)}
              data-testid="recent-harvest-pick"
              style={{ display: 'flex', alignItems: 'baseline', gap: T.space.sm, width: '100%', minHeight: T.tapMinHeight,
                padding: '10px 14px', background: 'none', border: 'none',
                borderTop: i === 0 ? 'none' : `1px solid ${P.cream}`, cursor: 'pointer',
                fontFamily: 'inherit', textAlign: 'left' }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: '0.88rem', fontWeight: 600, color: P.dark,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {harvestPickLabel(e)}
              </span>
              {amount && <span style={{ fontSize: T.type.sm, color: P.mid, flexShrink: 0 }}>{amount}</span>}
              <span style={{ fontSize: '0.76rem', color: P.light, flexShrink: 0 }}>{prettyDate(e.day_key)}</span>
            </button>
          )
        })}
      </div>
      {/* A REAL control, never inert "+N more" text — an unreachable count is a named defect on the
          sibling band surface, where 23 of 28 rows sat behind exactly that. */}
      {hiddenCount > 0 && (
        <button type="button" onClick={() => setExpanded(true)}
          style={{ background: 'none', border: 'none', padding: '8px 2px', cursor: 'pointer',
            color: P.green, fontSize: T.type.sm, fontWeight: 600, fontFamily: 'inherit',
            textDecoration: 'underline', minHeight: 32 }}>
          Show {hiddenCount} more
        </button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Log form
// ─────────────────────────────────────────────────────────────────────────────
// `session` (V4-PUTUPSESSION-001) is the freezer walk's answers — { storageId, date, dateApprox,
// cropSlug } — or null on every other entry path, where this form is byte-identical to what shipped
// apart from the promoted bag count. `onSaved` replaces the success screen with the walk's band.
function PutUpForm({ prefill, onLogged, session = null, onSaved = null }) {
  const { fetch } = useApiFetch()
  // V4-PUTUPFOODCATEGORY-001 — the ONE surface that opts into the non-plant food classes. This is
  // the pantry, not the garden: "where's my bread?" is answerable only if bread is offerable here.
  // The hook defaults to scope 'garden' everywhere else, including the VarietyPicker rendered a few
  // fields below, which is why a food class can be picked as a CROP here but never as a variety.
  const { cropTypes } = useCropTypes({ scope: 'all' })

  // Fast-path (2 required). The walk seeds the crop from its stash so a sitting torn down by the
  // launcher — Dave runs this as an installed PWA on Android, over several evenings — comes back on
  // the crop he was standing in front of.
  const [cropSlug, setCropSlug]   = useState(prefill.crop_type_slug || session?.cropSlug || '')
  // V4-PUTUPENGINE-001 slice 2 — quantity/unit now arrive on the prefill from a picked harvest.
  // They come as a PAIR or not at all (putUpPrefill.js drops both when the harvest unit has no
  // lossless mapping), so a seeded value can never be a number sitting against the wrong unit.
  const [qtyValue, setQtyValue]   = useState(prefill.quantity_value != null ? String(prefill.quantity_value) : '')
  const [qtyUnit, setQtyUnit]     = useState(prefill.quantity_unit || 'lbs')

  // Defaulted (visible, pre-filled)
  const [method, setMethod]       = useState('whole_freeze')
  const [methodOther, setMethodOther] = useState('')
  // The walk's two answers seed these and are re-applied below whenever they change, so one tap at
  // the start of a sitting stands in for one tap per item.
  const [preservedAt, setPreservedAt] = useState(session?.date || todayYMD())
  // V4-PUTUPSESSION-001 slice 1 — travels with preservedAt and is written to the column of the same
  // name. TRUE only for a date this form did not obtain from the user: the walk's coarse answer
  // resolved to a window midpoint. Every other entry path starts false, including the plain form's
  // today-default, which is a fact rather than an estimate.
  const [dateApprox, setDateApprox] = useState(!!session?.dateApprox)
  const [storageId, setStorageId] = useState(session?.storageId || '')
  const [useByMode, setUseByMode] = useState('auto') // 'auto' | 'none' | 'custom'
  const [useByDate, setUseByDate] = useState('')

  // Behind "More"
  const [showMore, setShowMore]   = useState(false)
  const [packageCount, setPackageCount] = useState('1')
  const [notes, setNotes]         = useState('')
  const [variety, setVariety]     = useState(null)
  // V4-PUTUPPHOTO-001: the file is STAGED here and uploaded on submit, never before. Uploading on
  // pick would orphan an S3 object + photos row every time someone changes their mind or abandons
  // the form. 'swallow' because the photo is never worth failing a put-up over (the DDL comment
  // says as much: "save succeeds independent of photo upload").
  const [photoFile, setPhotoFile] = useState(null)
  const [photoPreview, setPhotoPreview] = useState(null)
  const [photoWarning, setPhotoWarning] = useState(null)
  const { upload: uploadPhoto, isUploading } = useUploadPhoto({ errorMode: 'swallow' })

  const [storageLocations, setStorageLocations] = useState([])
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState(null)
  const [success, setSuccess]     = useState(null)

  // Which planting this came from (optional). Seeded from the harvest trigger (L9) but now
  // USER-EDITABLE: the direct "More → Put-Up" entry had no way to attach a planting at all, which
  // broke the seed → planting → harvest → put-up spine for anything not logged off a harvest.
  // Successions are the reason this matters — three waves of the same variety are three plantings.
  const [plantId, setPlantId] = useState(prefill.plant_id || null)
  // V4-PUTUPPROV-001: was `const harvestLogId = ...`. Converted to state because D2-c must be able
  // to CLEAR it: the harvest-triggered path arrives with both plant_id and harvest_log_id set, and a
  // non-garden source must shed both or the row still asserts it came from a garden harvest. A
  // version of this change that only cleared plant_id would be half-applied.
  const [harvestLogId, setHarvestLogId] = useState(prefill.harvest_log_id || null)
  const [sourceKind, setSourceKind] = useState('own_garden')
  const [sourceLabel, setSourceLabel] = useState('')
  // Restores the planting on flip-back so a mis-tap costs nothing (see applySourceKind).
  const [stashedPlantId, setStashedPlantId] = useState(null)
  const prefillVarietyId = prefill.variety_id || null
  const effectiveVarietyId = variety?.id ?? prefillVarietyId ?? null

  // V4-RELOADGATEWIRE-001 — same problem EventNew.jsx solved (see its hasUnsavedInput note): a
  // deploy's SW reload (~4.4/active day) or a stray Sheet backdrop tap can silently discard a
  // half-filled put-up. TWO predicates, split the way EventNew splits them, because the stash and
  // the guards ask DIFFERENT questions:
  //
  //   `dirty`      — "is there anything here worth keeping across a dismiss/reload?" Broad, so a
  //                  restore is byte-faithful. Writing a snapshot costs nothing and is invisible.
  //   `guardDirty` — "would a reload or a backdrop tap destroy something the user entered?" Narrow.
  //                  Arming this DEFERS deploys and kills the backdrop, so a false positive is a
  //                  wedged update and a dead dismiss, not a harmless extra write.
  //
  // Mirrors LogMany's dirty OR-chain shape: compare each field to its OWN pristine default, not
  // "any truthy value" — cropSlug/plantId/harvestLogId/variety are empty/null on a bare mount
  // (prefill aside), so a genuine change is what trips this. showMore (disclosure-only, like
  // EventNew's showAddDetails) and stashedPlantId (an applySourceKind implementation detail
  // already implied by the sourceKind term below) are deliberately excluded from `dirty` — both
  // still ride in the snapshot so a restore stays byte-faithful.
  // BUG-PUTUPSTASHHARVLINK-001 — this mount's prefill context, stamped into the snapshot below and
  // re-checked on restore. See prefillContextKey.
  const mountPrefillKey = prefillContextKey(prefill)
  const hasPrefill = mountPrefillKey !== BARE_PREFILL_KEY
  // The put-up date defaults to the day the form OPENED, so that is what "unchanged" means. Calling
  // todayYMD() here instead re-read the wall clock on every render, and a form left open across
  // midnight went dirty with no user action — arming both guards on an untouched form.
  const mountDayRef = useRef(todayYMD())
  const dirty = !!(
    cropSlug || qtyValue || notes || variety || plantId || harvestLogId ||
    method !== 'whole_freeze' || methodOther ||
    sourceKind !== 'own_garden' || sourceLabel ||
    qtyUnit !== 'lbs' || storageId ||
    useByMode !== 'auto' || useByDate ||
    packageCount !== '1' ||
    preservedAt !== mountDayRef.current
  )

  // The GUARD predicate. Counts ONLY entered content that resetForNext() clears, which excludes two
  // whole classes `dirty` includes:
  //   1. Anything the PREFILL seeds — cropSlug/plantId/harvestLogId all initialize from a
  //      harvest-log "preserve this?" navigation, and that path lands straight on this form
  //      (view defaults to 'log' when hasPrefill). Counting them held the reload gate and killed
  //      the backdrop on a pristine mount via the form's PRIMARY entry path, before a keystroke.
  //   2. Anything resetForNext() CARRIES FORWARD — crop, method, storage, unit, use-by, source,
  //      date. Those survive a save by design (the "Log another" loop is one crop, one farm-stand
  //      box, four methods), so counting them pinned both guards on for the life of the mount:
  //      nothing the user could do would ever release them again.
  // Both classes stay in `dirty` above, so nothing stops being RECOVERABLE — a crop pick alone is
  // still stashed and still restored. It just no longer defers deploys.
  //
  // photoFile is counted and is the one term with no stash backing: the File is staged in memory
  // and never enters the snapshot, so the gate is the only thing standing between a deploy and a
  // re-pick. Same reasoning as EventNew's hasUnsavedInput. harvestLogId is absent deliberately —
  // it has no user-entry path (prefill sets it; applySourceKind/resetForNext only clear it), so a
  // "user typed it" term for it would be vacuous.
  //
  // `!success` makes both guards read clean the moment a save lands: the success screen has no
  // typeable field and handleSubmit already cleared the draft, so a hold there wedges updates for
  // nothing.
  // V4-PUTUPENGINE-001 slice 2 — qtyValue joins class 1 above. It is now PREFILL-SEEDABLE (a picked
  // harvest carries its amount), so a bare `qtyValue ||` would hold the reload gate and kill the
  // backdrop on a pristine mount reached through the form's new primary entry path — the exact
  // failure the plant_id term was already shaped to avoid.
  //
  // But the term is "differs from the seed", NOT "no seed present" like the plant_id term above,
  // and that asymmetry is deliberate. Quantity is the field most likely to be CORRECTED after a
  // pick — you picked 4 cups off the harvest and actually put up 3 — and `!prefill.quantity_value
  // && qtyValue` would make that edit invisible to the gate forever, so the one keystroke the user
  // most wants protected would be the one a reload discards. plant_id does not have that shape: it
  // is re-picked from a list, not nudged.
  const seededQty = prefill.quantity_value != null ? String(prefill.quantity_value) : ''
  const guardDirty = !success && !!(
    qtyValue !== seededQty ||
    notes || photoFile || variety ||
    packageCount !== '1' ||
    (!prefill.plant_id && plantId)
  )

  // §4 draft stash — restore a dismissed/abandoned form once, on mount. A harvest-triggered
  // "preserve this?" navigation (line 9-10 above) is an explicit fresh intent and must win over a
  // stale draft from an UNRELATED earlier session — the same rule EventNew and LogMany apply to
  // their own seed/deep-link params.
  //
  // BUG-PUTUPSTASHHARVLINK-001 — that rule used to be spelled `if (hasPrefill) return`, which asks
  // whether a prefill EXISTS rather than whether it is the same one, and got both halves wrong:
  //   - A BARE mount restored `harvestLogId` from a draft a PREFILLED mount had written, so a fresh
  //     put-up logged from the More menu was silently attributed to an old harvest. Invisibly:
  //     unlike plantId, which lands in the labelled "From which planting?" field where it can be
  //     seen and cleared, harvest_log_id has NO control on this form at all. It reaches the wire and
  //     nothing on screen ever said so.
  //   - The SAME prefilled context could not resume at all. location.state survives both a
  //     dismiss/re-open and an SW reload, so an interrupted harvest-triggered put-up came back with
  //     the prefill re-seeded and everything typed since discarded — with the bytes sitting in
  //     sessionStorage the whole time.
  // The question is context IDENTITY, not context presence.
  //
  // LANDMINE CHECK (cf. EventNew's draftRestoredTypeRef fix, ~line 598/695/829 there): this form
  // has two places that derive state FROM other state — applySourceKind (clears
  // plantId/harvestLogId when sourceKind leaves own_garden) and PlantingField's onDerive (forces
  // sourceKind back to own_garden when a planting is picked). Neither is a REACTIVE effect keyed
  // on the fields a restore sets below: applySourceKind only runs from the source control's
  // onChange, and onDerive only runs from PlantingSelect's own select() — itself called only from
  // a listbox click or an Enter keypress (the only two call sites in PlantingSelect.jsx), never
  // from a `value`/prop change. So setting plantId/sourceKind directly here, bypassing both,
  // cannot trip either one — unlike EventNew's type-change effect, which DOES fire reactively off
  // a restored field and needed the skip-ref guard. Checked; no guard needed here.
  useEffect(() => {
    const draft = readDraft(DRAFT_KEY)
    if (!draft) return
    // A pre-stamp draft (written before this fix shipped) has no key and is treated as an UNKNOWN
    // context — never the same one — so it can neither resume a prefill nor hand its harvest link to
    // a bare mount. `sameContext` on a bare mount means "this draft was also written bare".
    const draftPrefillKey = typeof draft.prefillKey === 'string' ? draft.prefillKey : null
    const sameContext = draftPrefillKey === mountPrefillKey
    if (hasPrefill && !sameContext) return
    const resumingPrefill = hasPrefill && sameContext
    if (typeof draft.cropSlug === 'string') setCropSlug(draft.cropSlug)
    if (typeof draft.qtyValue === 'string') setQtyValue(draft.qtyValue)
    if (typeof draft.qtyUnit === 'string') setQtyUnit(draft.qtyUnit)
    if (typeof draft.method === 'string') setMethod(draft.method)
    if (typeof draft.methodOther === 'string') setMethodOther(draft.methodOther)
    if (typeof draft.preservedAt === 'string') setPreservedAt(draft.preservedAt)
    // Restored WITH its date, not separately. A draft that carried the date but not the flag would
    // resume an estimate as a date the user picked — the same defect this slice removes, arriving by
    // a different door. A pre-slice-1 draft has no key and keeps the useState seed.
    if (typeof draft.dateApprox === 'boolean') setDateApprox(draft.dateApprox)
    if (typeof draft.storageId === 'string') setStorageId(draft.storageId)
    if (typeof draft.useByMode === 'string') setUseByMode(draft.useByMode)
    if (typeof draft.useByDate === 'string') setUseByDate(draft.useByDate)
    if (typeof draft.showMore === 'boolean') setShowMore(draft.showMore)
    if (typeof draft.packageCount === 'string') setPackageCount(draft.packageCount)
    if (typeof draft.notes === 'string') setNotes(draft.notes)
    if (draft.variety && typeof draft.variety === 'object') setVariety(draft.variety)
    // The two spine links. When resuming the SAME prefilled context the draft is authoritative
    // INCLUDING its absences: a draft that flipped the source to a vendor cleared both links
    // (applySourceKind), and leaving the prefill's useState seeds in place would resume the form
    // re-asserting a garden harvest the user had already taken back — the "half-applied" shape
    // V4-PUTUPPROV-001 (D2-c) calls out, and a pair the server rejects.
    if (resumingPrefill) setPlantId(draft.plantId ?? null)
    else if (draft.plantId) setPlantId(draft.plantId)
    // The harvest link rehydrates ONLY into the prefilled context that produced it. A bare mount has
    // no harvest to link to, so there is nothing here for it to be the resumption OF. Same invariant
    // resetForNext() enforces one line at a time (see its comment): a harvest link belongs to the
    // single put-up that came from that harvest.
    if (resumingPrefill) setHarvestLogId(draft.harvestLogId ?? null)
    if (typeof draft.sourceKind === 'string') setSourceKind(draft.sourceKind)
    if (typeof draft.sourceLabel === 'string') setSourceLabel(draft.sourceLabel)
    if (draft.stashedPlantId) setStashedPlantId(draft.stashedPlantId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // §4 draft stash — persist while dirty. Declared AFTER the restore effect above so the two can
  // never race: React runs both passive effects in declaration order, in the SAME synchronous pass,
  // before either one's setState calls are applied — so on the very first pass this effect still
  // sees the PRE-restore (pristine) values and correctly no-ops, then re-fires once restore's
  // batched update lands and simply re-writes the snapshot it just read (idempotent). No `ready`
  // gate needed (unlike LogMany's, whose restore is nested inside an async projects/locations
  // fetch): every field here is synchronous local state, so there is no async gap for a pristine
  // write to land in ahead of the restore. Cleared on successful submit inside handleSubmit.
  //
  // …which clearDraft could not actually do on its own. This effect's deps include every field
  // resetForNext() touches, so it re-fires the moment "Log another" is tapped — and `dirty` is
  // STILL true there, because resetForNext carries the crop/method/storage forward. It rewrote the
  // draft clearDraft had just removed, and the user's next mount restored a spent one. Two gates,
  // covering the two halves of that window: `success` covers the confirmation screen, savedOnceRef
  // covers the reset form that follows it, where only guardDirty can tell "the user has entered
  // something new" apart from "the last save's leftovers are still on screen".
  const savedOnceRef = useRef(false)
  useEffect(() => {
    if (success) return
    if (savedOnceRef.current && !guardDirty) return
    if (!dirty) return
    writeDraft(DRAFT_KEY, {
      cropSlug, qtyValue, qtyUnit, method, methodOther, preservedAt, dateApprox, storageId,
      useByMode, useByDate, showMore, packageCount, notes,
      variety, plantId, harvestLogId, sourceKind, sourceLabel, stashedPlantId,
      // BUG-PUTUPSTASHHARVLINK-001 — the context this snapshot was taken in. harvestLogId keeps
      // riding along (the same-context resume above needs it); this is what stops it from being
      // handed to a mount that is not that context.
      prefillKey: mountPrefillKey,
    })
  }, [dirty, guardDirty, success, cropSlug, qtyValue, qtyUnit, method, methodOther, preservedAt, dateApprox, storageId,
      useByMode, useByDate, showMore, packageCount, notes,
      variety, plantId, harvestLogId, sourceKind, sourceLabel, stashedPlantId, mountPrefillKey])

  // The Sheet backdrop-tap guard (§4/§5.2) and the SW reload deferral (OPS-SWRELOADGUARD-001), both
  // fed by `guardDirty` — NOT by the broad stash predicate above. See its comment for what the two
  // ask differently. Key is per-instance (useId), matching EventNew, so an overlay mounted over a
  // full-page instance can never release the other's hold. The cleanup release is required, not
  // defensive: a dismissed form that kept its hold would wedge updates forever (BUG-STALECLIENT-001),
  // and it is safe only because the dep is a BOOLEAN — continued typing compares equal, so the
  // effect never re-runs and cannot release mid-form.
  useReportOverlayDirty(guardDirty)
  const reloadGateKey = `put-up:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, guardDirty)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, guardDirty])

  const loadStorage = useCallback(() => {
    fetch('/api/storage-locations')
      .then(rows => setStorageLocations(Array.isArray(rows) ? rows : []))
      .catch(() => { /* non-fatal — Unassigned is always available */ })
  }, [fetch])
  useEffect(() => { loadStorage() }, [loadStorage])

  // ── V4-PUTUPSESSION-001: the walk's answers, applied to every save ────────────────────────────
  // Re-applied on CHANGE (he tapped "Change" in the band and moved to the next freezer), not only
  // at mount, and deliberately keyed on the two primitives rather than the object — the walk builds
  // a fresh object every render. A per-item override survives until the session answer itself
  // changes, which is the behaviour §3.3 asks for ("both stay visible, small, and overridable").
  const sessionStorageId = session?.storageId ?? null
  const sessionDate = session?.date ?? null
  // Slice 1: the flag is re-applied WITH the date, never independently. Tapping "Change" in the band
  // and switching from "This summer" to a date he picks has to clear it in the same pass that moves
  // the date, or the next item carries the old answer's approximate-ness on the new answer's value.
  const sessionApprox = !!session?.dateApprox
  useEffect(() => {
    if (sessionDate == null) return
    setPreservedAt(sessionDate)
    setDateApprox(sessionApprox)
    setStorageId(sessionStorageId || '')
  }, [sessionDate, sessionApprox, sessionStorageId])

  // ── V4-PUTUPSESSION-001: auto-resolve the planting when the crop has exactly one ──────────────
  // 18 of the 31 crops harvested this year have exactly one planting (measured 2026-08-31), so for
  // most of the freezer the app can name the plant with no input at all — G2 provenance for zero
  // taps. Reads through useCachedFetch on the SAME path PlantingSelect self-fetches, so host and
  // picker share one warm cache entry rather than each holding their own; `null` when not in a walk
  // means the hook does nothing at all on every other entry path.
  const walkPlants = useCachedFetch(session ? '/api/plants?view=picker' : null)
  const soleForCrop = useMemo(
    () => (session ? solePlanting(walkPlants.data, cropSlug) : null),
    [session, walkPlants.data, cropSlug],
  )
  // What this effect set, so it can revise its OWN guess when the crop changes but must never
  // overwrite a planting the user picked by hand.
  const autoPlantRef = useRef(null)
  useEffect(() => {
    if (!session) return
    if (plantId && plantId !== autoPlantRef.current) return   // user's choice — hands off
    if (soleForCrop) {
      if (plantId === soleForCrop.id) return
      autoPlantRef.current = soleForCrop.id
      setPlantId(soleForCrop.id)
    } else if (plantId && plantId === autoPlantRef.current) {
      autoPlantRef.current = null
      setPlantId(null)
    }
  }, [session, soleForCrop, plantId])
  // Stated, never silent. "A default he is shown once per save is a fact he can catch; one he never
  // sees is an assumption" — the same rationale the provenance echo on save already gives. This is
  // the on-screen half of design §4.4 rule 4.
  const autoResolvedPlanting = session && soleForCrop && plantId === soleForCrop.id ? soleForCrop : null

  function validate() {
    // A planting is sufficient attribution on its own — the server derives crop + variety from it.
    if (!cropSlug && !effectiveVarietyId && !plantId) return 'Pick a crop, a variety, or a planting so this put-up is attributed.'
    const q = Number(qtyValue)
    if (qtyValue === '' || !Number.isFinite(q) || q <= 0) return 'Enter how much you put up (greater than zero).'
    if (!qtyUnit) return 'Pick a unit.'
    if (method === 'other' && !methodOther.trim()) return 'Describe the method when you choose "Other".'
    if (!preservedAt) return 'When did you put this up?'
    if (packageCount !== '' && Number(packageCount) < 1) return 'Number of containers must be at least 1.'
    if (sourceKind === 'other' && !sourceLabel.trim()) return 'Name where it came from, or pick a different source.'
    if (useByMode === 'custom' && !useByDate) return 'Pick a use-by date, or switch to Auto / No expiry.'
    return null
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    // Offline = require-online. Block the save, keep every entered value, name the state plainly.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError("You're offline — a put-up can't be saved right now. Your entries are kept; try again once you're back online.")
      return
    }
    const verr = validate()
    if (verr) { setError(verr); return }

    const body = {
      preserved_at: preservedAt,
      // V4-PUTUPSESSION-001 slice 1. In the BASE literal for the same reason source_kind is, and it
      // is the reason the column can be trusted: this form ALWAYS knows whether the date came from
      // the user or from a coarse answer, so sending `false` is a recorded fact rather than a
      // default. Routing it through the `if (x) body.x = ...` chain below would send nothing for the
      // ordinary path and leave it NULL — "nobody was asked" — when we did in fact ask.
      preserved_at_approx: dateApprox,
      method,
      quantity_value: Number(qtyValue),
      quantity_unit: qtyUnit,
      package_count: packageCount === '' ? 1 : Number(packageCount),
      // In the BASE literal, deliberately — source_kind always has a value, and routing it through
      // the `if (x) body.x = ...` chain below would make "not set" and "empty" indistinguishable on
      // the wire for a column whose whole point is recording what is known.
      source_kind: prefillLocksSource ? 'own_garden' : sourceKind,
    }
    if (cropSlug) body.crop_type_slug = cropSlug
    if (effectiveVarietyId) body.variety_id = effectiveVarietyId
    if (plantId) body.plant_id = plantId
    if (harvestLogId) body.harvest_log_id = harvestLogId
    if (method === 'other') body.method_other_text = methodOther.trim()
    if (storageId) body.storage_location_id = storageId
    if (notes.trim()) body.notes = notes.trim()
    // Vendor-only (D2-b): a label never rides along with own_garden.
    if (body.source_kind !== 'own_garden' && sourceLabel.trim()) body.source_label = sourceLabel.trim()
    // use_by_target: OMIT the key for the shelf-life auto-default; null for "no expiry"; a date otherwise.
    if (useByMode === 'none') body.use_by_target = null
    else if (useByMode === 'custom') body.use_by_target = useByDate

    setSaving(true)
    setPhotoWarning(null)
    try {
      // Photo FIRST, then the row. The handoff assumed this needed create -> upload -> re-PUT
      // (because useUploadPhoto wants a parentId), but the 'standalone' key prefix takes no
      // parentId and photos POST only requires storage_path — so the photo can exist before the
      // put-up does, and photo_id rides along on the single create. No second write, no
      // re-PUT against the full-replace contract.
      //
      // Deliberately NOT linked to the planting via photos.plant_id: PlantingDetail's gallery
      // unions plant_id-attached photos, so a shot of jars in a freezer would surface in that
      // planting's Growth timeline. The link belongs on preservation_log.photo_id only.
      if (photoFile) {
        const res = await uploadPhoto(photoFile, { keyPrefix: 'standalone', is_public: false })
        if (res?.photo?.id) body.photo_id = res.photo.id
        else setPhotoWarning("Your put-up was saved, but the photo didn't upload.")
      }
      const row = await fetch('/api/preservation', { method: 'POST', body: JSON.stringify(body) })
      // L10 cold-start competence payoff — reflect it straight back into the inventory, no celebration.
      const storeLabel = storageLocations.find(s => String(s.id) === String(storageId))?.label || 'your stores'
      const cropLabel = cropTypes.find(c => c.slug === cropSlug)?.display_name || variety?.name || 'harvest'
      // V4-PUTUPPROV-001. Echo provenance back on save. This is what makes a below-the-fold default
      // HONEST: a pre-selected control the user never looks at is an assumption, but one they are
      // shown the result of once per save is a fact they can catch and correct. Built from the
      // RETURNED ROW, not from local state — the server owns the label's fate (it nulls it on
      // own_garden), so reporting what we typed could differ from what was actually stored.
      const savedKind = row?.source_kind ?? null
      const fromBit = savedKind && savedKind !== 'own_garden'
        ? ` · from ${row.source_label || PUTUP_SOURCE_LABELS[savedKind] || savedKind}`
        : ''
      clearDraft(DRAFT_KEY)   // saved to the DB — no longer a resumable draft
      savedOnceRef.current = true   // …and keep the persist effect from putting it straight back
      const text = `Now in ${storeLabel}: ${Number(qtyValue)} ${qtyUnit} ${cropLabel} (${body.package_count} ${body.package_count === 1 ? 'container' : 'containers'})${fromBit}.`
      // V4-PUTUPSESSION-001. In a walk the confirmation IS the band — it carries the saved item and
      // its Undo — so the form stays put and clears for the next bag rather than swapping itself
      // for a success screen he then has to tap past sixty times.
      if (session && onSaved) {
        onSaved(row, `${body.package_count} × ${cropLabel}`)
        resetForNext()
      } else {
        setSuccess({ text, row })
      }
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setSaving(false)
    }
  }

  // Own the object-URL lifecycle here (useUploadPhoto only manages the one IT creates at upload
  // time; this preview exists before any upload). Revoke on replace, clear, and unmount.
  function selectPhoto(file) {
    setPhotoPreview(prev => { if (prev) URL.revokeObjectURL(prev); return file ? URL.createObjectURL(file) : null })
    setPhotoFile(file)
    setPhotoWarning(null)
  }
  function clearPhoto() { selectPhoto(null) }
  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview) }, [photoPreview])

  // V4-PUTUPPROV-001 (D2-c). ONE helper owns the source->planting edge; the reverse edge lives in
  // PlantingField's existing onDerive handler. Both directions route through mechanisms that already
  // exist rather than a new useEffect watching sourceKind, which would race the derivation channel.
  //
  // Auto-clear rather than a confirm dialog: a modal fired mid-form at someone with wet hands gets
  // dismissed, not considered. The clear is visible (the planting field empties, its help text says
  // why) and reversible (stashedPlantId restores on flip-back), which is what makes skipping the
  // confirm safe.
  function applySourceKind(next) {
    setSourceKind(next)
    if (next !== 'own_garden') {
      if (plantId) setStashedPlantId(plantId)
      setPlantId(null)
      setHarvestLogId(null)   // the harvest link is the same lie one FK over
    } else {
      setSourceLabel('')      // vendor-only (D2-b): screen state must never disagree with what stores
      if (stashedPlantId) { setPlantId(stashedPlantId); setStashedPlantId(null) }
    }
  }

  function resetForNext() {
    // Crop is kept (you're usually processing one crop in a session); variety and planting are
    // cleared. Clearing the planting is deliberate: it is MORE specific than the variety being
    // cleared alongside it, so carrying it over would silently mis-attribute the next put-up.
    // sourceKind + sourceLabel are DELIBERATELY CARRIED FORWARD, on the same rationale as crop: a
    // farm-stand box is one box, four methods, four rows, and the "Log another" loop IS the
    // bought-produce workflow. Resetting them to own_garden would make rows 2-4 silently wrong in
    // the one direction the user cannot see (the default is below the fold).
    // harvestLogId is CLEARED: a harvest link belongs to the single put-up that came from that
    // harvest, not to the next four rows. (It used to survive resets only because it was a const.)
    setQtyValue(''); setNotes(''); setPackageCount('1'); setVariety(null); setPlantId(null)
    setHarvestLogId(null); setStashedPlantId(null)
    clearPhoto()
    setSuccess(null); setError(null)
  }

  if (success) {
    return (
      <div>
        <div role="status" style={{
          backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: T.radiusCard,
          padding: '16px 18px', marginBottom: T.space.md,
        }}>
          <div style={{ fontWeight: 700, color: P.green, fontSize: '0.98rem', marginBottom: 4 }}>✓ Put up</div>
          <div style={{ fontSize: T.type.base, color: P.mid }}>{success.text}</div>
        </div>
        {/* The put-up SAVED; only the photo failed. Says so plainly rather than letting a silently
            photo-less record read as a successful attach. */}
        {photoWarning && (
          <div role="status" style={{ fontSize: T.type.sm, color: P.bannerInk, backgroundColor: P.warn,
            border: `1px solid ${P.warnBorder}`, borderRadius: T.radiusButton, padding: '10px 12px', marginBottom: T.space.md }}>
            {photoWarning}
          </div>
        )}
        <div style={{ display: 'flex', gap: T.space.sm, flexWrap: 'wrap' }}>
          <Button type="button" variant="primary" onClick={resetForNext}>Log another</Button>
          <Button type="button" variant="secondary" onClick={onLogged}>See what&rsquo;s put up</Button>
        </div>
      </div>
    )
  }

  // V4-PUTUPPROV-001 (D2-c + boss B5). A harvest-triggered put-up is definitionally own-garden — you
  // cannot harvest a store peach — so the source control is suppressed on that path rather than
  // offering a one-tap route into a contradiction for zero benefit.
  // GATED ON THE LIVE plantId, not on the prefill alone: the parent's `hasPrefill` is derived once
  // from location.state and is never cleared, so keying on it alone would leave the control
  // suppressed for EVERY subsequent row in the "Log another" loop — which is precisely the
  // bought-produce workflow. Once the prefilled planting is gone, the lock releases.
  const prefillLocksSource = !!(prefill.plant_id || prefill.harvest_log_id) && !!plantId

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false

  // ── V4-PUTUPSESSION-001: the fast path, as blocks, because the walk orders them differently ──
  // THE INVERSION THAT MATTERS (design §0.3/§3.4). The inventory read surface builds its headline
  // as `g.total_packages += Number(r.package_count)` and never aggregates quantity_value ANYWHERE
  // (lambda/preservation/index.js). So package_count is the number "what's put up" actually
  // reports — and until now it was the one field hidden behind the collapsed "More · optional"
  // reveal at a default of 1, while quantity, which nothing sums, was the required fast-path field.
  // For a freezer walk that is exactly backwards: standing at a chest freezer the countable fact is
  // "there are twelve bags"; the quart-size of each bag is a per-crop constant.
  //
  // Promoted UNCONDITIONALLY, not only in the walk — the read surface reads the same column on
  // every entry path, so hiding it anywhere is the same defect.
  const bagsField = (
    <div style={{ marginTop: 14 }}>
      <Field label="How many bags / jars?" htmlFor="pu-packages"
        help={session ? undefined : 'How many separate bags, jars or boxes this went into.'}>
        <Input id="pu-packages" type="number" min={1} inputMode="numeric" value={packageCount}
          onChange={e => setPackageCount(e.target.value)} aria-label="How many bags or jars" />
      </Field>
      {/* The pad is WALK-ONLY. Its clearance is not inherited from the weigh-in's geometry — that
          pad sits in a fixed 3-track grid over a 48-184px band, this one sits in ordinary document
          flow above a band whose height is MEASURED and paid for as the scroller's bottom padding
          (PutUpWalk). `integer` dims the decimal key: package_count is an integer column, so '1.5
          bags' would be a value the server rejects after he had finished tapping. Six columns, 48px
          keys — deliberately NOT the 56px of V4-PADTARGETSIZE-001, which is unshipped precisely
          because it pushed a pad row under a sticky band. */}
      {session && (
        <div style={{ marginTop: 10 }}>
          <NumberPad
            value={packageCount}
            onChange={setPackageCount}
            idPrefix="pu-bagpad"
            ariaLabel="How many bags or jars"
            keyAriaPrefix="Bags"
            maxLen={3}
            integer
          />
        </div>
      )}
    </div>
  )

  const qtyRow = (
    <div style={{ display: 'flex', gap: T.space.sm, marginTop: 14 }}>
      <div style={{ flex: 2 }}>
        <Field label={session ? 'How big is each? *' : 'How much *'} htmlFor="pu-qty">
          <Input
            id="pu-qty"
            type="text"
            inputMode="decimal"
            value={qtyValue}
            onChange={e => setQtyValue(e.target.value)}
            aria-label="Quantity"
            placeholder="e.g. 14"
          />
        </Field>
      </div>
      <div style={{ flex: 1 }}>
        <Field label="Unit *" htmlFor="pu-unit">
          <Select id="pu-unit" value={qtyUnit} onChange={e => setQtyUnit(e.target.value)} aria-label="Unit">
            {UNIT_GROUPS.map(g => (
              <optgroup key={g.group} label={g.group}>
                {g.options.map(u => <option key={u} value={u}>{u}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  )

  // Which one? Crop alone ("Peppers") isn't enough to know what's in the jar — jalapeño vs
  // habanero matters when you go looking for it later. Promoted out of the "More" reveal to sit
  // with the crop (Dave, 2026-07-21). Optional: the attribution CHECK needs crop OR variety.
  // SUPPRESSED IN THE WALK: retrospectively, at a freezer, the cultivar is not a fact he has — and
  // where a planting auto-resolves the server derives the variety from it anyway.
  const varietyBlock = (
    <div style={{ marginTop: 14 }}>
      <Field label="Which variety?" htmlFor="pu-variety" optional
        help={cropSlug
          ? 'e.g. Jalapeño, Habanero — so you know exactly what you put up.'
          : 'Choose a crop above to narrow this list — or search them all.'}>
        {/* Scoped to the chosen crop so this is a short, relevant list (pepper = 107 of 398)
            rather than every variety in the garden. */}
        <VarietyPicker id="pu-variety" value={variety} onChange={setVariety}
          cropSlugFilter={cropSlug || undefined}
          placeholder={cropSlug ? 'Search this crop’s varieties…' : 'Search varieties…'} />
      </Field>
    </div>
  )

  // Which planting? The spine link. Optional by design (V101 line 57: a put-up drawn from several
  // waves has no single planting), but offered on EVERY entry — not just the harvest-triggered one
  // — so "3 waves of zucchini, tracked separately" actually works. Selecting a planting derives
  // crop + variety, so this alone is full attribution.
  const plantingBlock = (
    <div style={{ marginTop: 14 }}>
      {autoResolvedPlanting && (
        <div data-testid="pu-auto-planting" role="status"
          style={{ marginBottom: 10, padding: '9px 12px', fontSize: T.type.sm, lineHeight: 1.4,
            color: P.green, backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`,
            borderRadius: T.radiusButton }}>
          {/* The PLAIN name, not plantingWaveLabel: the wave format exists to disambiguate
              successions ("— wave 2, sown Apr 20"), and by construction there is nothing here to
              disambiguate. Measured at 390px the wave form cost this box a third line for a fact
              the picker directly below already shows. */}
          ✓ My garden · <strong>{autoResolvedPlanting.name || plantingWaveLabel(autoResolvedPlanting)}</strong>
          <span style={{ color: P.mid }}> — the only planting of this crop. Change it below if
            that&rsquo;s wrong.</span>
        </div>
      )}
      <PlantingField
        value={plantId}
        onChange={setPlantId}
        cropSlug={cropSlug}
        varietyId={effectiveVarietyId}
        onDerive={({ crop_type_slug, variety_id, variety }) => {
          if (crop_type_slug && !cropSlug) setCropSlug(crop_type_slug)
          if (variety_id && !effectiveVarietyId && variety) setVariety(variety)
          // V4-PUTUPPROV-001 (D2-c, reverse edge). Picking a planting can never leave a
          // contradictory source behind — otherwise a user could set 'store', then pick a wave,
          // and ship a row asserting both. The server rejects that pair; this stops them
          // reaching it.
          setSourceKind('own_garden'); setSourceLabel('')
        }}
      />
    </div>
  )

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: T.space.md }}>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {offline && !error && (
        <ErrorBanner>You&rsquo;re offline — you can fill this in, but saving needs a connection.</ErrorBanner>
      )}

      {/* ── Fast path: crop + quantity ── */}
      <Card>
        <Field label="Crop *" htmlFor="pu-crop" help={effectiveVarietyId && !cropSlug ? 'Linked to your harvest — pick a crop to refine, or leave as is.' : undefined}>
          <Select id="pu-crop" value={cropSlug} onChange={e => setCropSlug(e.target.value)} aria-label="Crop">
            <option value="">— Select a crop —</option>
            {[...cropTypes].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')).map(c => (
              <option key={c.slug} value={c.slug}>{c.display_name}</option>
            ))}
          </Select>
        </Field>

        {/* Order. WALK: crop → how many bags → how big is each → which planting. The countable
            fact first, then the per-crop constant, then the provenance the app usually fills in
            itself. ORDINARY FORM: its shipped order, unchanged, with the bag count inserted above
            quantity exactly where the read surface's arithmetic says it belongs. */}
        {session ? (
          <>
            {bagsField}
            {qtyRow}
            {plantingBlock}
          </>
        ) : (
          <>
            {varietyBlock}
            {plantingBlock}
            {bagsField}
            {qtyRow}
          </>
        )}
      </Card>

      {/* ── Defaulted: source / method / storage / date / use-by ── */}
      <Card>
        {/* V4-PUTUPPROV-001 (D2-a). Source lives HERE, not in the fast-path Card above, and not
            behind "More".
            - Not Card 1: that card is the crop+quantity fast path and already carries five controls.
              A sixth costs a fixation on every one of the ~95% of saves that are own-garden.
              Defaulting a value removes DECISION load; it does not remove ATTENTION load.
            - Not "More": the field is defaulted-WRONG for the bought case rather than
              defaulted-empty, and hiding that behind a disclosure the user must remember to open
              makes prospective memory load-bearing.
            - Not inferred from "no planting": a put-up drawn from several waves legitimately has no
              planting (see the PlantingField comment above), so inferring would fabricate provenance
              into a column the UI shows as fact.
            Card 2's contract is exactly "correct by default, visible, occasionally changed" — which
            is what method, storage, date and use-by all are. Source belongs here on that rule.
            The two-state gate is what makes the zero-friction claim honest: the common path is one
            glance at a preselected chip, no picker wheel, 44px target, wet hands. */}
        {!prefillLocksSource && (
          <div style={{ marginBottom: T.space.md }}>
            <Field label="Where did it come from?" htmlFor="pu-source-gate">
              <SegmentedControl
                ariaLabel="Where did it come from?"
                value={sourceKind === 'own_garden' ? 'own_garden' : 'bought'}
                onChange={v => applySourceKind(v === 'own_garden' ? 'own_garden' : 'farm_stand')}
                options={[
                  { value: 'own_garden', label: 'My garden' },
                  { value: 'bought', label: 'Somewhere else' },
                ]}
              />
            </Field>
            {sourceKind !== 'own_garden' && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="Where from?" htmlFor="pu-source-kind">
                  {/* Plain Select, NOT EnumSelect: that primitive defaults to sort=true and would
                      alphabetize the list, burying the frequency ordering the vocab is built on. */}
                  <Select id="pu-source-kind" value={sourceKind}
                    onChange={e => applySourceKind(e.target.value)} aria-label="Source">
                    {PUTUP_SOURCE_OPTIONS.filter(o => o.value !== 'own_garden').map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={sourceKind === 'other' ? 'Where exactly? *' : 'Which one?'}
                  htmlFor="pu-source-label"
                  optional={sourceKind !== 'other'}
                  help="e.g. Warner Farms, Clarkdale Fruit Farm.">
                  <Input id="pu-source-label" type="text" value={sourceLabel}
                    onChange={e => setSourceLabel(e.target.value)} aria-label="Source name"
                    maxLength={120} placeholder="Name the place" />
                </Field>
              </div>
            )}
          </div>
        )}

        <Field label="How did you put it up?" htmlFor="pu-method">
          <Select id="pu-method" value={method} onChange={e => setMethod(e.target.value)} aria-label="Method">
            {METHOD_GROUPS.map(g => (
              <optgroup key={g.group} label={g.group}>
                {g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
        {method === 'other' && (
          <div style={{ marginTop: 12 }}>
            {/* V4-PUTUPTAXONOMY-001. The placeholder used to read "e.g. smoked" — the form was
                SUGGESTING a method it does not offer, and 'other' is not a free ride: no method
                outside SHELF_LIFE_MONTHS gets a use-by date, so the row drops out of "use soon"
                entirely. That already happened to the one 'other' row in prod, and it is why the
                cost is now stated instead of hidden. The example is deliberately something the
                18-value list genuinely cannot express, so it does not steer anyone here by habit. */}
            <Field label="Describe the method *" htmlFor="pu-method-other"
              help="Heads up: we can’t work out a use-by date for “Other”, so this one won’t show up in “use soon”.">
              <Input id="pu-method-other" value={methodOther} onChange={e => setMethodOther(e.target.value)}
                aria-label="Describe the method" placeholder="e.g. salt-packed in oil" />
            </Field>
          </div>
        )}
        {CANNING_METHODS.has(method) && (
          <div role="note" style={{
            marginTop: 12, fontSize: '0.8rem', lineHeight: 1.45, color: P.bannerInk,
            backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: T.radiusButton, padding: '10px 12px',
          }}>
            <strong>Canning safety.</strong> Water-bath canning is safe only for <strong>high-acid</strong> foods
            (tomatoes with added acid, pickles, jam). <strong>Low-acid</strong> foods — beans, most vegetables —
            must be <strong>pressure-canned</strong> to be safe. Check the crop guide before you can.
          </div>
        )}
        {/* V5-PUTUPCANDY-001 / FOODSAFETY-RULING-V101 §8.2 — the visible half of the ruling, and the
            condition on which `candy` ships at all. Placed HERE, under the method select, for the
            same reason the canning note is: the consequence of a choice belongs at the moment of
            making it. Deliberately NOT the warn palette the canning note uses — this is a provenance
            statement, not a safety warning, and dressing it as an alarm would teach the user to read
            past both. It names "Use by" below rather than moving that control, because the shape the
            research supports is a prompt, not an assessment. */}
        {HOUSE_SOURCED_SHELF_LIFE.has(method) && (
          <div role="note" style={{
            marginTop: 12, fontSize: '0.8rem', lineHeight: 1.45, color: P.mid,
            backgroundColor: P.cream, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, padding: '10px 12px',
          }}>
            <strong>No published shelf life for this one.</strong> {HOUSE_ESTIMATE_CLAIM}{' '}
            Set <strong>Use by</strong> below to <strong>Pick a date</strong> if you know the real one.
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          {/* OPS-STORAGELOCNODOOR-001 — `manageable` only here, not in the walk's copy of this same
              field. Renaming vocabulary is a deliberate, desk-posture act; the walk is a hands-wet
              sitting whose job is one item at a time. */}
          <StorageField
            value={storageId}
            onChange={setStorageId}
            locations={storageLocations}
            manageable
            onCreated={(row) => { setStorageLocations(list => [...list, row]); setStorageId(String(row.id)) }}
            onUpdated={(row) => setStorageLocations(list => list.map(l => (String(l.id) === String(row.id) ? { ...l, ...row } : l)))}
            onDeleted={(id) => setStorageLocations(list => list.filter(l => String(l.id) !== String(id)))}
            fetch={fetch}
          />
        </div>

        <div style={{ display: 'flex', gap: T.space.sm, marginTop: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 150 }}>
            {/* V4-PUTUPSESSION-001 slice 1 closed slice 0's knowing limitation: the estimate now
                rides to the database in preserved_at_approx, so the help text is no longer the only
                place the distinction survives. The help still keys on the SESSION answer (what the
                walk proposed); the flag below keys on local state, which is what he has done to it
                since. Typing a date is the one act that turns an estimate into a fact — it is the
                only place in the form where a date is obtained FROM him — so it clears the flag
                here rather than anywhere further downstream. */}
            <Field label="Put-up date *" htmlFor="pu-date"
              help={session?.dateApprox ? 'An estimate from the start of this walk — change it for any item you know exactly.' : undefined}>
              <Input id="pu-date" type="date" value={preservedAt} max={todayYMD()}
                onChange={e => { setPreservedAt(e.target.value); setDateApprox(false) }} aria-label="Put-up date" />
            </Field>
            {dateApprox && (
              <div style={{ fontSize: '0.74rem', color: P.mid, marginTop: 4 }}>
                Saved as <strong>{describeDate(preservedAt, true)}</strong> — an estimate, not a date you picked.
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 150 }}>
            {/* The help text is METHOD-CONDITIONAL because the unconditional one was a claim, not a
                hint: "tested shelf-life" is true of every method here except the house-sourced ones,
                and leaving it in place over a candy row would attribute an uncitable number to a
                tested source in the very control that sets it. */}
            <Field label="Use by" htmlFor="pu-useby-mode"
              help={HOUSE_SOURCED_SHELF_LIFE.has(method)
                ? 'Auto uses our own house estimate for this one — see the note above.'
                : 'Auto uses tested shelf-life for the method and storage.'}>
              <Select id="pu-useby-mode" value={useByMode} onChange={e => setUseByMode(e.target.value)} aria-label="Use by">
                <option value="auto">Auto (recommended)</option>
                <option value="none">No expiry</option>
                <option value="custom">Pick a date</option>
              </Select>
            </Field>
          </div>
        </div>
        {useByMode === 'custom' && (
          <div style={{ marginTop: 12 }}>
            <Field label="Use-by date" htmlFor="pu-useby-date">
              <Input id="pu-useby-date" type="date" value={useByDate}
                onChange={e => setUseByDate(e.target.value)} aria-label="Use-by date" />
            </Field>
          </div>
        )}
      </Card>

      {/* ── More: packages / notes / variety ── */}
      <Card>
        <button type="button" onClick={() => setShowMore(s => !s)} aria-expanded={showMore}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: T.type.sm,
            fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0,
            display: 'flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true">{showMore ? '▾' : '▸'}</span>
          <span>More &middot; optional</span>
        </button>
        {showMore && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* "Number of containers" USED TO LIVE HERE, behind this reveal, at a default of 1.
                It is now `bagsField` in the fast path above — see its comment for the arithmetic
                that moved it. Nothing replaced it here; the reveal is one field shorter. */}
            <Field label="Notes" htmlFor="pu-notes" optional>
              <Textarea id="pu-notes" value={notes} onChange={e => setNotes(e.target.value)}
                aria-label="Notes" style={{ height: 72, resize: 'vertical' }} placeholder="Anything worth remembering" />
            </Field>
            {/* Photo. `capture` is intentionally absent: on mobile it would force the camera and
                block picking an existing shot, and most put-ups get photographed while you're
                labelling jars, not at the moment you open the form. */}
            <Field label="Photo" htmlFor="pu-photo" optional help="A shot of the jars or bags — helps you spot it later.">
              {photoPreview ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <img src={photoPreview} alt="Selected put-up photo" width={64} height={64}
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, border: `1px solid ${P.border}` }} />
                  <Button type="button" variant="secondary" onClick={clearPhoto}>Remove photo</Button>
                </div>
              ) : (
                <input id="pu-photo" type="file" accept="image/*" aria-label="Photo"
                  onChange={e => selectPhoto(e.target.files?.[0] ?? null)}
                  style={{ fontSize: '0.85rem' }} />
              )}
            </Field>
          </div>
        )}
      </Card>

      <div style={{ display: 'flex', justifyContent: session ? 'stretch' : 'flex-end' }}>
        <Button type="submit" variant="primary" loading={saving || isUploading} loadingLabel={isUploading ? "Uploading photo…" : "Saving…"}
          disabled={offline} style={session ? { width: '100%' } : { minWidth: 160 }}>
          {session ? 'Save & next' : 'Save put-up'}
        </Button>
      </div>
    </form>
  )
}

// Which-planting field — V4-PLANTPICKER-001: now the shared PlantingSelect combobox (its listbox
// opens on focus in browse mode, so the waves still read side by side). This wrapper owns only
// the PutUp framing: the Field label + the progressive-scope help copy. plantingOptionLabel moved
// to PlantingSelect as plantingWaveLabel (dependency points page→component); re-exported here for
// the provenance display below and any historical importers.
export const plantingOptionLabel = plantingWaveLabel

function PlantingField({ value, onChange, cropSlug, varietyId, onDerive }) {
  const [failed, setFailed] = useState(false)

  const help = failed
    ? "Couldn't load your plantings — you can still save without one."
    : varietyId ? 'Plantings of this variety — pick the wave this came from.'
      : cropSlug ? 'Plantings of this crop. Pick a variety above to narrow further.'
        : 'Ties this put-up back to what you actually grew.'

  return (
    <Field label="From which planting?" htmlFor="pu-planting" optional help={help}>
      <PlantingSelect
        id="pu-planting"
        value={value || ''}
        onChange={(id) => onChange(id || null)}
        cropSlug={cropSlug}
        varietyId={varietyId}
        retainOutOfScopeValue
        sort="sown"
        labelFormat="wave"
        emptyMeaning="none"
        onDerive={onDerive}
        onLoadError={() => setFailed(true)}
        aria-label="From which planting"
        data-testid="pu-planting-select"
      />
    </Field>
  )
}

// Inline storage-location field with a lightweight "＋ New location" creator (POST /api/storage-locations)
// and — OPS-STORAGELOCNODOOR-001 — the rename/delete door that was missing.
//
// THE DEFECT. lambda/storage-location/index.js has shipped PUT :id (:88-104) and DELETE :id
// (:106-121) since V4-HARVESTCENTER-001, and a repo-wide grep found NO frontend caller for either:
// the client only ever GETs and POSTs. So a mistyped or obsolete freezer label was PERMANENT, in a
// vocabulary that is per-user, free text, and appears on every put-up row that references it.
//
// KIND IS SETTABLE, and that half is not cosmetic. Live prod carries exactly 3 rows, all
// kind='deep_freezer', all owned by Dave and none by Jen — while chk_storage_location_kind already
// permits fridge / pantry / cold_storage. A ferment moving counter → fridge → pantry is therefore a
// DATA gap, not a schema gap, and the only thing standing between the data and the schema was a
// missing form control.
//
// `manageable` gates the door to the log form deliberately. The freezer walk mounts this same
// component (under "＋ Somewhere else") and the walk is a hands-wet, one-item-at-a-time sitting;
// renaming and deleting vocabulary belongs on the deliberate surface, not in the middle of a walk.
function StorageField({ value, onChange, locations, onCreated, onUpdated, onDeleted, manageable, fetch }) {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState('deep_freezer')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [managing, setManaging] = useState(false)

  // BUG-PUTUPLOC-001 — the first "add location" failed and the retry succeeded, with CloudWatch
  // proving NO POST ever reached garden-storage-location. Falsified already: fetch prop not passed,
  // CORS, Button swallowing type, stale bundle. Remaining theory: a cold-start / token-refresh race
  // that throws client-side before the request leaves the browser.
  //
  // The old catch collapsed every cause into one string, which is why the bug is still open — the
  // one occurrence carried no evidence. This does two things instead:
  //   1. SELF-HEALS: one automatic retry for the failure classes that are plausibly transient
  //      (request never reached the server, or auth). If the race theory is right, Dave stops
  //      seeing the bug at all.
  //   2. SELF-REPORTS: classifies the failure and puts a short code in the message, and logs the
  //      full error. A recurrence now arrives with its own diagnosis instead of "it failed once".
  // A retry is only safe because this POST is a create the user explicitly re-triggered; a
  // duplicate would be a visible extra location, not silent data damage.
  function classify(e) {
    const status = e?.status
    if (typeof status === 'number') {
      if (status === 401 || status === 403) return { code: 'AUTH', retry: true }
      if (status >= 500) return { code: 'SRV', retry: true }
      return { code: `HTTP${status}`, retry: false }
    }
    // No status at all = the request threw before it got a response: network drop, CORS preflight
    // rejection, or an auth-token fetch that failed. This is the class BUG-PUTUPLOC-001 lives in.
    return { code: 'NET', retry: true }
  }

  async function post() {
    return fetch('/api/storage-locations', {
      method: 'POST', body: JSON.stringify({ label: label.trim(), kind }),
    })
  }

  async function create() {
    if (!label.trim()) { setErr('Give the location a name.'); return }
    setBusy(true); setErr(null)
    try {
      let row
      try {
        row = await post()
      } catch (e1) {
        const c = classify(e1)
        console.error('BUG-PUTUPLOC-001 add-location attempt 1 failed', { code: c.code, status: e1?.status, message: e1?.message })
        if (!c.retry) throw e1
        await new Promise(r => setTimeout(r, 400))
        try {
          row = await post()
          console.warn('BUG-PUTUPLOC-001 recovered on retry', { firstFailure: c.code })
        } catch (e2) {
          const c2 = classify(e2)
          console.error('BUG-PUTUPLOC-001 retry ALSO failed', { code: c2.code, status: e2?.status, message: e2?.message })
          const err = new Error(e2?.message ?? 'retry failed'); err.code = c2.code
          throw err
        }
      }
      onCreated(row)
      setAdding(false); setLabel(''); setKind('deep_freezer')
    } catch (e) {
      const code = e?.code ?? classify(e).code
      setErr(`Couldn't add that location — try again. (${code})`)
    } finally { setBusy(false) }
  }

  return (
    <div>
      <Field label="Where is it stored?" htmlFor="pu-storage">
        <Select id="pu-storage" value={value} onChange={e => onChange(e.target.value)} aria-label="Storage location">
          <option value="">— Unassigned —</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </Select>
      </Field>
      {!adding ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: T.space.md }}>
          <button type="button" onClick={() => setAdding(true)}
            style={{ background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: T.type.sm,
              fontWeight: 600, padding: '8px 0 0', textDecoration: 'underline' }}>
            ＋ New location
          </button>
          {/* Only when there is something to edit. A door onto an empty list is furniture. */}
          {manageable && locations.length > 0 && (
            <button type="button" data-testid="pu-manage-locations" onClick={() => setManaging(m => !m)}
              style={{ background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: T.type.sm,
                fontWeight: 600, padding: '8px 0 0', textDecoration: 'underline' }}>
              {managing ? 'Done editing' : 'Edit locations'}
            </button>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 12, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, padding: '12px 14px', backgroundColor: P.cream }}>
          {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 8 }}>{err}</div>}
          <Field label="Name *" htmlFor="pu-newloc-label">
            <Input id="pu-newloc-label" value={label} onChange={e => setLabel(e.target.value)}
              aria-label="New location name" placeholder="e.g. Garage freezer" />
          </Field>
          <div style={{ marginTop: T.space.sm }}>
            <Field label="Kind" htmlFor="pu-newloc-kind">
              <Select id="pu-newloc-kind" value={kind} onChange={e => setKind(e.target.value)} aria-label="Location kind">
                {STORAGE_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
              </Select>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: T.space.sm, marginTop: 12 }}>
            <Button type="button" variant="primary" loading={busy} loadingLabel="Adding…" onClick={create}>Add</Button>
            <Button type="button" variant="secondary" onClick={() => { setAdding(false); setErr(null) }}>Cancel</Button>
          </div>
        </div>
      )}
      {managing && !adding && (
        <StorageLocationEditor
          locations={locations} fetch={fetch} classify={classify}
          selectedId={value} onClearSelected={() => onChange('')}
          onUpdated={onUpdated} onDeleted={onDeleted}
        />
      )}
    </div>
  )
}

// OPS-STORAGELOCNODOOR-001 — the rename/delete list. One row per location, expanded in place.
//
// WHAT DELETE ACTUALLY DOES, checked in the handler before writing a guard rather than after:
// lambda/storage-location/index.js:111-118 is a SOFT delete (`SET deleted_at = NOW()`), so a
// location still referenced by a preservation_log row cannot raise a foreign-key violation — there
// is nothing to violate. And the four read surfaces LEFT JOIN storage_location with NO deleted_at
// predicate (e.g. lambda/preservation/index.js:415), so rows already stored there KEEP RENDERING
// their label; only the GET list filters deleted_at IS NULL, so the term merely stops being offered.
// A client-side "is it in use?" pre-check would therefore be guarding against a hazard that does not
// exist, and would need a count this component has never fetched. The honest guard is the one below:
// a two-step confirm that STATES the consequence, with no invented number in it.
function StorageLocationEditor({ locations, fetch, classify, selectedId, onClearSelected, onUpdated, onDeleted }) {
  const [editingId, setEditingId] = useState(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftKind, setDraftKind] = useState('deep_freezer')
  const [confirmingId, setConfirmingId] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [err, setErr] = useState(null)

  function startEdit(loc) {
    setErr(null); setConfirmingId(null)
    setEditingId(loc.id); setDraftLabel(loc.label ?? '')
    // A row whose kind is not in the pick-list keeps its own value as the initial selection rather
    // than silently becoming a deep_freezer on the next save — the Select renders it as an extra
    // option below. VALID_KINDS and STORAGE_KINDS agree today; this is what stops a future drift in
    // either list from rewriting data through a form the user only opened to fix a typo.
    setDraftKind(loc.kind ?? 'deep_freezer')
  }

  async function save(loc) {
    const trimmed = draftLabel.trim()
    if (!trimmed) { setErr('Give the location a name.'); return }
    setBusyId(loc.id); setErr(null)
    try {
      // PUT is COALESCE-per-column on the handler (:92-101), so this is a merge and not the
      // full-replace shape preservation's PUT uses. Both fields are sent because both are on screen.
      const row = await fetch(`/api/storage-locations/${loc.id}`, {
        method: 'PUT', body: JSON.stringify({ label: trimmed, kind: draftKind }),
      })
      setEditingId(null)
      onUpdated?.(row ?? { ...loc, label: trimmed, kind: draftKind })
    } catch (e) {
      setErr(`Couldn't save that change — try again. (${classify(e).code})`)
    } finally { setBusyId(null) }
  }

  async function remove(loc) {
    setBusyId(loc.id); setErr(null)
    try {
      await fetch(`/api/storage-locations/${loc.id}`, { method: 'DELETE' })
      setConfirmingId(null)
      // The picker above may be sitting on the row that just went away. Clearing to Unassigned is
      // the only honest resolution: leaving the id selected would submit a location the user can no
      // longer see, and the create-form Select would render a blank value with no explanation.
      if (String(selectedId) === String(loc.id)) onClearSelected?.()
      onDeleted?.(loc.id)
    } catch (e) {
      setErr(`Couldn't delete that location — try again. (${classify(e).code})`)
    } finally { setBusyId(null) }
  }

  return (
    <div data-testid="pu-location-editor"
      style={{ marginTop: 12, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, padding: '10px 12px', backgroundColor: P.cream }}>
      {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 8 }}>{err}</div>}
      {locations.map(loc => {
        const editing = editingId === loc.id
        const confirming = confirmingId === loc.id
        const kindLabel = STORAGE_KINDS.find(k => k.value === loc.kind)?.label ?? loc.kind ?? ''
        return (
          <div key={loc.id} data-testid="pu-location-row" data-loc-id={loc.id}
            style={{ padding: '8px 0', borderTop: `1px solid ${P.border}` }}>
            {!editing ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: T.type.sm, fontWeight: 600, color: P.dark }}>{loc.label}</div>
                  <div style={{ fontSize: '0.75rem', color: P.light }}>{kindLabel}</div>
                </div>
                <button type="button" data-testid="pu-location-rename" onClick={() => startEdit(loc)}
                  style={{ minHeight: T.tapMinHeight, padding: '4px 8px', background: 'none', border: 'none',
                    cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.78rem', fontWeight: 700, color: P.green }}>
                  Edit
                </button>
                <button type="button" data-testid="pu-location-delete" disabled={busyId === loc.id}
                  onClick={() => { setErr(null); setConfirmingId(confirming ? null : loc.id) }}
                  style={{ minHeight: T.tapMinHeight, padding: '4px 8px', background: 'none', border: 'none',
                    cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.78rem', fontWeight: 700, color: P.terra }}>
                  Delete
                </button>
              </div>
            ) : (
              <div>
                <Field label="Name *" htmlFor={`pu-editloc-label-${loc.id}`}>
                  <Input id={`pu-editloc-label-${loc.id}`} value={draftLabel}
                    onChange={e => setDraftLabel(e.target.value)} aria-label="Location name" />
                </Field>
                <div style={{ marginTop: T.space.sm }}>
                  <Field label="Kind" htmlFor={`pu-editloc-kind-${loc.id}`}>
                    <Select id={`pu-editloc-kind-${loc.id}`} value={draftKind}
                      onChange={e => setDraftKind(e.target.value)} aria-label="Location kind">
                      {STORAGE_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                      {!STORAGE_KINDS.some(k => k.value === draftKind) && (
                        <option value={draftKind}>{draftKind}</option>
                      )}
                    </Select>
                  </Field>
                </div>
                <div style={{ display: 'flex', gap: T.space.sm, marginTop: 10 }}>
                  <Button type="button" variant="primary" loading={busyId === loc.id} loadingLabel="Saving…"
                    data-testid="pu-location-save" onClick={() => save(loc)}>Save</Button>
                  <Button type="button" variant="secondary"
                    onClick={() => { setEditingId(null); setErr(null) }}>Cancel</Button>
                </div>
              </div>
            )}
            {confirming && !editing && (
              <div data-testid="pu-location-confirm-delete"
                style={{ marginTop: 8, padding: '8px 10px', background: P.white,
                  border: `1px solid ${P.border}`, borderRadius: T.radiusButton }}>
                <div data-testid="pu-location-delete-consequence" style={{ fontSize: '0.78rem', color: P.mid }}>
                  Delete &ldquo;{loc.label}&rdquo;? Anything already stored there keeps this label &mdash;
                  it just stops being offered for new put-ups.
                </div>
                <div style={{ display: 'flex', gap: T.space.sm, marginTop: 8 }}>
                  <button type="button" data-testid="pu-location-delete-confirm" disabled={busyId === loc.id}
                    onClick={() => remove(loc)}
                    style={{ minHeight: T.tapMinHeight, padding: '6px 12px', background: 'none',
                      border: `1px solid ${P.terra}`, borderRadius: T.radiusButton, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: '0.78rem', fontWeight: 700, color: P.terra }}>
                    Yes, delete
                  </button>
                  <button type="button" onClick={() => setConfirmingId(null)}
                    style={{ minHeight: T.tapMinHeight, padding: '6px 12px', background: 'none', border: 'none',
                      cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.78rem', color: P.light }}>
                    Keep it
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// "What's put up" read surface
// ─────────────────────────────────────────────────────────────────────────────
function StoresView() {
  const { fetch } = useApiFetch()
  const [group, setGroup] = useState('storage') // 'storage' | 'crop'
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback((g) => {
    setLoading(true); setError(null)
    fetch(`/api/preservation/whats-put-up?group=${g}`)
      .then(d => setData(d ?? { groups: [] }))
      .catch(() => setError("Couldn't load your stores — try again."))
      .finally(() => setLoading(false))
  }, [fetch])

  useEffect(() => { load(group) }, [load, group])

  const groups = data?.groups ?? []

  return (
    <div>
      <div style={{ marginBottom: T.space.md }}>
        <SegmentedControl
          ariaLabel="Group by"
          small
          value={group}
          onChange={setGroup}
          options={[
            { value: 'storage',  label: 'By storage' },
            { value: 'crop',     label: 'By crop' },
            { value: 'planting', label: 'By planting' },
          ]}
        />
      </div>

      {loading && <div style={{ padding: 24, textAlign: 'center', color: P.light }}>Loading&hellip;</div>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!loading && !error && groups.length === 0 && (
        <div style={{ padding: '28px 18px', textAlign: 'center', color: P.mid,
          background: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusBadge }}>
          <div style={{ fontWeight: 700, color: P.dark, marginBottom: 6 }}>Nothing put up yet.</div>
          <div style={{ fontSize: '0.85rem', color: P.light }}>
            Log your first put-up and it&rsquo;ll show up here, grouped by where it&rsquo;s stored.
          </div>
        </div>
      )}

      {!loading && !error && groups.map(g => (
        <GroupCard key={g.group_key} group={g} onChanged={() => load(group)} fetch={fetch} />
      ))}
    </div>
  )
}

function GroupCard({ group, onChanged, fetch }) {
  const units = (group.units ?? []).join(', ')
  return (
    <div style={{ marginBottom: T.space.md, backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusBadge, overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${P.border}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: T.space.sm }}>
          <div style={{ fontWeight: 700, color: P.dark, fontSize: '1rem' }}>{group.label}</div>
          {group.use_soon_count > 0 && (
            <span style={{ fontSize: T.type.xs, fontWeight: 700, color: P.gold,
              backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: 999, padding: '2px 8px' }}>
              {group.use_soon_count} use soon
            </span>
          )}
        </div>
        {/* Numbers-first headline — package COUNT + the distinct units present. Never a cross-unit sum (L5). */}
        <div style={{ fontSize: '0.85rem', color: P.mid, marginTop: 4 }}>
          {group.total_packages} {group.total_packages === 1 ? 'container' : 'containers'}
          {units ? ` · ${units}` : ''}
        </div>
      </div>
      <div>
        {group.records.map(rec => <RecordRow key={rec.id} rec={rec} onChanged={onChanged} fetch={fetch} />)}
      </div>
    </div>
  )
}

// Build the FULL replace payload the PUT contract expects, applying overrides (decrement / edit).
function buildFullPayload(rec, overrides = {}) {
  return {
    crop_type_slug: rec.crop_type_slug ?? null,
    variety_id: rec.variety_id ?? null,
    plant_id: rec.plant_id ?? null,
    harvest_log_id: rec.harvest_log_id ?? null,
    preserved_at: ymd(rec.preserved_at),
    // V4-PUTUPSESSION-001 slice 1. `?? null` and never `?? false`: null is what the Lambda's
    // COALESCE reads as "unchanged", so a row whose flag was never recorded keeps its NULL instead
    // of being rewritten as "the user chose this date" by a Mark-used tap that knows nothing about
    // it. The same reasoning as source_kind below, one line up because it belongs beside its date.
    preserved_at_approx: rec.preserved_at_approx ?? null,
    method: rec.method,
    method_other_text: rec.method_other_text ?? null,
    quantity_value: rec.quantity_value,
    quantity_unit: rec.quantity_unit,
    package_count: rec.package_count ?? 1,
    storage_location_id: rec.storage_location_id ?? null,
    use_by_target: rec.use_by_target ? ymd(rec.use_by_target) : null,
    remaining_count: rec.remaining_count ?? null,
    consumed_at: rec.consumed_at ?? null,
    notes: rec.notes ?? null,
    photo_id: rec.photo_id ?? null,
    // V4-PUTUPPROV-001 — THE HIGHEST-RISK LINE IN THIS CHANGE. This function is the single choke
    // point for the one-tap "Mark used" decrement AND, via the overrides spread below, for
    // RowEditor. Omitting a
    // column here means every decrement tap sends a payload without it. Before the Lambda's
    // COALESCE-preserve fix that silently rewrote a farm-stand put-up as own-garden with the vendor
    // erased, returned 200, and looked like a render glitch. Both guards ship; keep both.
    // src/__tests__/preservationColumnParity.test.js asserts this object's key set against
    // PRESERVATION_EDITABLE_COLUMNS so the NEXT column cannot be half-added either.
    source_kind: rec.source_kind ?? null,
    source_label: rec.source_label ?? null,
    ...overrides,
  }
}

function RecordRow({ rec, onChanged, fetch }) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [err, setErr] = useState(null)

  const remaining = rec.remaining_count ?? rec.package_count ?? 0

  async function put(overrides) {
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/preservation/${rec.id}`, { method: 'PUT', body: JSON.stringify(buildFullPayload(rec, overrides)) })
      onChanged()
    } catch (e) { setErr("Couldn't update — try again."); setBusy(false) }
  }

  async function markUsed() {
    const next = Math.max(0, Number(remaining) - 1)
    await put({ remaining_count: next })
  }
  async function usedUp() { await put({ remaining_count: 0 }) }

  async function doDelete() {
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/preservation/${rec.id}`, { method: 'DELETE' })
      onChanged()
    } catch (e) { setErr("Couldn't remove — try again."); setBusy(false) }
  }

  if (editing) {
    return <RowEditor rec={rec} onCancel={() => setEditing(false)}
      onSave={async (overrides) => { await put(overrides); setEditing(false) }} busy={busy} err={err} />
  }

  const status = rec.use_by_status
  const statusChip = status === 'past_use_by'
    ? { text: 'Past use-by', bg: P.warn, border: P.warnBorder, color: P.bannerInk }
    : status === 'use_soon'
      ? { text: 'Use soon', bg: P.warn, border: P.warnBorder, color: P.gold }
      : null

  return (
    <div style={{ padding: '12px 16px', borderTop: `1px solid ${P.cream}`, display: 'flex', gap: 12 }}>
      {/* V4-PUTUPPHOTO-001 — renders nothing when there is no photo (or it fails to resolve), so
          rows without one keep their original full-width layout. */}
      <PutUpPhotoThumb photoId={rec.photo_id} fetch={fetch} alt={`Photo of ${rec.quantity_unit} put up`} />
      <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: T.space.sm, alignItems: 'baseline' }}>
        <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.92rem' }}>
          {rec.quantity_value} {rec.quantity_unit}
          <span style={{ color: P.mid, fontWeight: 400 }}> · {METHOD_LABELS[rec.method] || rec.method}{rec.method === 'other' && rec.method_other_text ? ` (${rec.method_other_text})` : ''}</span>
        </div>
        {statusChip && (
          <span style={{ fontSize: '0.68rem', fontWeight: 700, color: statusChip.color,
            backgroundColor: statusChip.bg, border: `1px solid ${statusChip.border}`, borderRadius: 999, padding: '2px 8px', flexShrink: 0 }}>
            {statusChip.text}
          </span>
        )}
      </div>
      <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 3 }}>
        {rec.package_count} {rec.package_count === 1 ? 'container' : 'containers'}
        {remaining !== rec.package_count ? ` · ${remaining} left` : ''}
        {/* V4-PUTUPSESSION-001 slice 1 — THE LINE THE SLICE EXISTS FOR. Through describeApprox, not
            a local "around " prefix, so the walk's band and the saved record are guaranteed to say
            the same words about the same date. `=== true` and not truthiness: the column is
            three-valued and NULL (nobody was asked) must render exactly as it does today, plain. */}
        {' · put up '}{describeApprox(prettyDate(rec.preserved_at), rec.preserved_at_approx === true)}
        {rec.use_by_target ? ` · use by ${prettyDate(rec.use_by_target)}` : ''}
      </div>
      {/* V5-PUTUPCANDY-001 / FOODSAFETY-RULING-V101 §8.2 — THE LINE THE RULING IS ABOUT. The date one
          line up and the chip above it are computed server-side and shipped to every viewer, and for
          a house-sourced method that is an assessment nothing published backs. The ruling's terms are
          exact: distinguishable on the surface, or `default: null`. A migration header is read by
          nobody using the app, and the second person in the household has no way to learn one exists.
          Gated on use_by_target because with no date on screen there is no claim to attribute; gated
          on the method set rather than on 'candy' so the next house-sourced entry inherits it. */}
      {HOUSE_SOURCED_SHELF_LIFE.has(rec.method) && rec.use_by_target && (
        <div role="note" style={{ fontSize: '0.76rem', color: P.mid, marginTop: 3, lineHeight: 1.4 }}>
          {HOUSE_ESTIMATE_CLAIM} Tap <strong>Edit</strong> to set the real date.
        </div>
      )}
      {/* Planting provenance — which wave this jar actually came from. Only rendered when the link
          exists; a put-up spanning several plantings legitimately has none. */}
      {rec.planting_name && (
        <div style={{ fontSize: '0.76rem', color: P.mid, marginTop: 3 }}>
          from {rec.planting_name}
          {rec.planting_succession_order != null ? ` · wave ${rec.planting_succession_order}` : ''}
          {rec.planting_sown_at ? ` · sown ${prettyDate(rec.planting_sown_at)}` : ''}
        </div>
      )}
      {/* V4-PUTUPPROV-001. Gated exactly like the planting-provenance block above: own_garden and
          NULL render NOTHING, so every row that exists today looks identical to today. Reuses that
          block's style object rather than minting a new one. */}
      {rec.source_kind && rec.source_kind !== 'own_garden' && (
        <div style={{ fontSize: '0.76rem', color: P.mid, marginTop: 3 }}>
          from {rec.source_label || PUTUP_SOURCE_LABELS[rec.source_kind] || rec.source_kind}
        </div>
      )}
      {rec.notes && <div style={{ fontSize: '0.8rem', color: P.mid, marginTop: 4 }}>{rec.notes}</div>}
      {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginTop: 6 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
        <RowAction onClick={markUsed} disabled={busy || remaining <= 0}>Mark used</RowAction>
        <RowAction onClick={usedUp} disabled={busy || remaining <= 0}>Used up</RowAction>
        <RowAction onClick={() => setEditing(true)} disabled={busy}>Edit</RowAction>
        {!confirmDelete ? (
          <RowAction onClick={() => setConfirmDelete(true)} disabled={busy} tone="terra">Remove</RowAction>
        ) : (
          <>
            <RowAction onClick={doDelete} disabled={busy} tone="terra">Confirm remove</RowAction>
            <RowAction onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</RowAction>
          </>
        )}
      </div>
      </div>
    </div>
  )
}

function RowAction({ onClick, disabled, tone, children }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ background: 'none', border: 'none', padding: '4px 0', cursor: disabled ? 'default' : 'pointer',
        color: disabled ? P.light : (tone === 'terra' ? P.terra : P.green), fontSize: T.type.sm, fontWeight: 600,
        fontFamily: 'inherit', textDecoration: 'underline', opacity: disabled ? 0.5 : 1, minHeight: 32 }}>
      {children}
    </button>
  )
}

// Minimal per-row editor — the fields worth changing after the fact. Sends a FULL replace payload.
function RowEditor({ rec, onCancel, onSave, busy, err }) {
  const [qtyValue, setQtyValue] = useState(String(rec.quantity_value ?? ''))
  const [qtyUnit, setQtyUnit] = useState(rec.quantity_unit || 'lbs')
  const [packageCount, setPackageCount] = useState(String(rec.package_count ?? 1))
  const [method, setMethod] = useState(rec.method || 'whole_freeze')
  // PRE-EXISTING BUG, fixed under V4-PUTUPPROV-001. This editor offered 'other' in the method list
  // but had no method_other_text input, so switching a row TO 'other' sent method:'other' with
  // method_other_text:null (buildFullPayload supplies the row's existing value, which is null for a
  // row that was not already 'other'), tripping validateUpdate's required-text rule. The 400 was
  // then swallowed by put()'s generic catch, so it read as "Couldn't update — try again." forever.
  // THE INVARIANT THIS RESTORES: a field that is CONDITIONALLY REQUIRED BY ANOTHER FIELD must be
  // editable everywhere that other field is editable, or the pair must be create-only. The new
  // source_kind/source_label pair depends on the same invariant holding.
  const [methodOther, setMethodOther] = useState(rec.method_other_text || '')
  // V5-PUTUPCANDY-001. The other half of FOODSAFETY-RULING-V101 §8.2: "let the cook set the real
  // date". use_by_target has always been per-row and user-overridable at CREATE time, but this
  // editor never exposed it, so the provenance line's "tap Edit to set the real date" would have
  // been a dead instruction on an existing row. Seeded exactly as buildFullPayload seeds it, so an
  // untouched save round-trips the stored value byte-for-byte.
  const [useByTarget, setUseByTarget] = useState(rec.use_by_target ? ymd(rec.use_by_target) : '')
  const [notes, setNotes] = useState(rec.notes || '')

  function save() {
    onSave({
      quantity_value: Number(qtyValue) || rec.quantity_value,
      quantity_unit: qtyUnit,
      package_count: packageCount === '' ? 1 : Number(packageCount),
      method,
      method_other_text: method === 'other' ? (methodOther.trim() || null) : null,
      // Sent on EVERY save, not only when the control is rendered: the value is seeded from the same
      // expression buildFullPayload uses, so for a row whose control never appeared this key is
      // byte-identical to the one the payload already carried. Making it conditional would buy
      // nothing and add a second code path to the column the ruling turns on.
      use_by_target: useByTarget || null,
      notes: notes.trim() || null,
    })
  }

  return (
    <div style={{ padding: '14px 16px', borderTop: `1px solid ${P.cream}`, backgroundColor: P.cream }}>
      {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: T.space.sm }}>
        <div style={{ flex: 2 }}>
          <Field label="How much" htmlFor={`ed-qty-${rec.id}`}>
            <Input id={`ed-qty-${rec.id}`} type="text" inputMode="decimal" value={qtyValue}
              onChange={e => setQtyValue(e.target.value)} aria-label="Quantity" />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Unit" htmlFor={`ed-unit-${rec.id}`}>
            <Select id={`ed-unit-${rec.id}`} value={qtyUnit} onChange={e => setQtyUnit(e.target.value)} aria-label="Unit">
              {UNIT_GROUPS.map(g => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map(u => <option key={u} value={u}>{u}</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <div style={{ marginTop: T.space.sm }}>
        <Field label="Containers" htmlFor={`ed-pkg-${rec.id}`}>
          <Input id={`ed-pkg-${rec.id}`} type="number" min={1} value={packageCount}
            onChange={e => setPackageCount(e.target.value)} aria-label="Number of containers" />
        </Field>
      </div>
      <div style={{ marginTop: T.space.sm }}>
        <Field label="Method" htmlFor={`ed-method-${rec.id}`}>
          <Select id={`ed-method-${rec.id}`} value={method} onChange={e => setMethod(e.target.value)} aria-label="Method">
            {METHOD_GROUPS.map(g => (
              <optgroup key={g.group} label={g.group}>
                {g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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
              placeholder="Describe how you put it up" />
          </Field>
        </div>
      )}
      {/* Keyed on the LOCAL method state, exactly as the block above is, so switching a row to a
          house-sourced method reveals the control in the same edit rather than after a save. Shown
          only for those methods: every other use-by here rests on a tested figure, and offering a
          hand-override everywhere would be a UX change to all nineteen that nothing asked for. */}
      {HOUSE_SOURCED_SHELF_LIFE.has(method) && (
        <div style={{ marginTop: T.space.sm }}>
          <Field label="Use-by date" htmlFor={`ed-useby-${rec.id}`} optional help={HOUSE_ESTIMATE_CLAIM}>
            <Input id={`ed-useby-${rec.id}`} type="date" value={useByTarget}
              onChange={e => setUseByTarget(e.target.value)} aria-label="Use-by date" />
          </Field>
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

function Card({ children }) {
  return (
    <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusCard, padding: '16px 18px' }}>
      {children}
    </div>
  )
}

function friendlyError(err) {
  const status = err && err.status
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return err?.message ? `Couldn't save — ${err.message}` : "Something didn't look right — check the form and try again."
  }
  return "Couldn't save — try again."
}
