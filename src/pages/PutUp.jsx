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
import { useLocation } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useCropTypes } from '../hooks/useCropTypes.js'
import { P } from '../lib/constants.js'
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
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'

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
    { value: 'can_water_bath', label: 'Water-bath can (high-acid)' },
    { value: 'can_pressure',   label: 'Pressure can (low-acid)' },
    { value: 'jam_preserve',   label: 'Jam / preserve' },
  ] },
  { group: 'Store', options: [
    { value: 'ferment',    label: 'Ferment' },
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
const UNIT_GROUPS = [
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

export default function PutUp() {
  const location = useLocation()
  const prefill = (location.state && typeof location.state.prefill === 'object' && location.state.prefill) || {}
  const hasPrefill = prefillContextKey(prefill) !== BARE_PREFILL_KEY

  // Adaptive default: a harvest-triggered open lands on the form; a bare "Put-Up" tap lands on the
  // inventory ("what have I got?") — the more common intent from the More menu.
  const [view, setView] = useState(hasPrefill ? 'log' : 'stores')

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '24px 18px 80px' }}>
        <h1 style={{ margin: '0 0 4px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Put-Up</h1>
        <p style={{ margin: '0 0 16px', fontSize: '0.84rem', color: P.light }}>
          What you&rsquo;ve preserved — your freezer, pantry and stores.
        </p>

        <div style={{ marginBottom: 18 }}>
          <SegmentedControl
            ariaLabel="Put-Up view"
            value={view}
            onChange={setView}
            options={[
              { value: 'log',    label: 'Log a put-up' },
              { value: 'stores', label: "What's put up" },
            ]}
          />
        </div>

        {view === 'log'
          ? <PutUpForm prefill={prefill} onLogged={() => setView('stores')} />
          : <StoresView />}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Log form
// ─────────────────────────────────────────────────────────────────────────────
function PutUpForm({ prefill, onLogged }) {
  const { fetch } = useApiFetch()
  const { cropTypes } = useCropTypes()

  // Fast-path (2 required)
  const [cropSlug, setCropSlug]   = useState(prefill.crop_type_slug || '')
  const [qtyValue, setQtyValue]   = useState('')
  const [qtyUnit, setQtyUnit]     = useState('lbs')

  // Defaulted (visible, pre-filled)
  const [method, setMethod]       = useState('whole_freeze')
  const [methodOther, setMethodOther] = useState('')
  const [preservedAt, setPreservedAt] = useState(todayYMD())
  const [storageId, setStorageId] = useState('')
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
  const guardDirty = !success && !!(
    qtyValue || notes || photoFile || variety ||
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
      cropSlug, qtyValue, qtyUnit, method, methodOther, preservedAt, storageId,
      useByMode, useByDate, showMore, packageCount, notes,
      variety, plantId, harvestLogId, sourceKind, sourceLabel, stashedPlantId,
      // BUG-PUTUPSTASHHARVLINK-001 — the context this snapshot was taken in. harvestLogId keeps
      // riding along (the same-context resume above needs it); this is what stops it from being
      // handed to a mount that is not that context.
      prefillKey: mountPrefillKey,
    })
  }, [dirty, guardDirty, success, cropSlug, qtyValue, qtyUnit, method, methodOther, preservedAt, storageId,
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
      setSuccess({
        text: `Now in ${storeLabel}: ${Number(qtyValue)} ${qtyUnit} ${cropLabel} (${body.package_count} ${body.package_count === 1 ? 'container' : 'containers'})${fromBit}.`,
        row,
      })
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
          backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: 10,
          padding: '16px 18px', marginBottom: 16,
        }}>
          <div style={{ fontWeight: 700, color: P.green, fontSize: '0.98rem', marginBottom: 4 }}>✓ Put up</div>
          <div style={{ fontSize: '0.9rem', color: P.mid }}>{success.text}</div>
        </div>
        {/* The put-up SAVED; only the photo failed. Says so plainly rather than letting a silently
            photo-less record read as a successful attach. */}
        {photoWarning && (
          <div role="status" style={{ fontSize: '0.82rem', color: P.bannerInk, backgroundColor: P.warn,
            border: `1px solid ${P.warnBorder}`, borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
            {photoWarning}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
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

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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

        {/* Which one? Crop alone ("Peppers") isn't enough to know what's in the jar — jalapeño vs
            habanero matters when you go looking for it later. Promoted out of the "More" reveal to
            sit with the crop (Dave, 2026-07-21). Optional: the attribution CHECK needs crop OR variety. */}
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

        {/* Which planting? The spine link. Optional by design (V101 line 57: a put-up drawn from
            several waves has no single planting), but offered on EVERY entry — not just the
            harvest-triggered one — so "3 waves of zucchini, tracked separately" actually works.
            Selecting a planting derives crop + variety, so this alone is full attribution. */}
        <div style={{ marginTop: 14 }}>
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

        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <div style={{ flex: 2 }}>
            <Field label="How much *" htmlFor="pu-qty">
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
          <div style={{ marginBottom: 16 }}>
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
            <Field label="Describe the method *" htmlFor="pu-method-other">
              <Input id="pu-method-other" value={methodOther} onChange={e => setMethodOther(e.target.value)}
                aria-label="Describe the method" placeholder="e.g. smoked" />
            </Field>
          </div>
        )}
        {CANNING_METHODS.has(method) && (
          <div role="note" style={{
            marginTop: 12, fontSize: '0.8rem', lineHeight: 1.45, color: P.bannerInk,
            backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: 8, padding: '10px 12px',
          }}>
            <strong>Canning safety.</strong> Water-bath canning is safe only for <strong>high-acid</strong> foods
            (tomatoes with added acid, pickles, jam). <strong>Low-acid</strong> foods — beans, most vegetables —
            must be <strong>pressure-canned</strong> to be safe. Check the crop guide before you can.
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <StorageField
            value={storageId}
            onChange={setStorageId}
            locations={storageLocations}
            onCreated={(row) => { setStorageLocations(list => [...list, row]); setStorageId(String(row.id)) }}
            fetch={fetch}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 150 }}>
            <Field label="Put-up date *" htmlFor="pu-date">
              <Input id="pu-date" type="date" value={preservedAt} max={todayYMD()}
                onChange={e => setPreservedAt(e.target.value)} aria-label="Put-up date" />
            </Field>
          </div>
          <div style={{ flex: 1, minWidth: 150 }}>
            <Field label="Use by" htmlFor="pu-useby-mode" help="Auto uses tested shelf-life for the method and storage.">
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
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: P.mid, fontSize: '0.82rem',
            fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0,
            display: 'flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true">{showMore ? '▾' : '▸'}</span>
          <span>More &middot; optional</span>
        </button>
        {showMore && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Number of containers" htmlFor="pu-packages" help="How many bags / jars / boxes.">
              <Input id="pu-packages" type="number" min={1} value={packageCount}
                onChange={e => setPackageCount(e.target.value)} aria-label="Number of containers" />
            </Field>
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

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="submit" variant="primary" loading={saving || isUploading} loadingLabel={isUploading ? "Uploading photo…" : "Saving…"}
          disabled={offline} style={{ minWidth: 160 }}>
          Save put-up
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

// Inline storage-location field with a lightweight "＋ New location" creator (POST /api/storage-locations).
function StorageField({ value, onChange, locations, onCreated, fetch }) {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState('deep_freezer')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

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
        <button type="button" onClick={() => setAdding(true)}
          style={{ background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: '0.82rem',
            fontWeight: 600, padding: '8px 0 0', textDecoration: 'underline' }}>
          ＋ New location
        </button>
      ) : (
        <div style={{ marginTop: 12, border: `1px solid ${P.border}`, borderRadius: 8, padding: '12px 14px', backgroundColor: P.cream }}>
          {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 8 }}>{err}</div>}
          <Field label="Name *" htmlFor="pu-newloc-label">
            <Input id="pu-newloc-label" value={label} onChange={e => setLabel(e.target.value)}
              aria-label="New location name" placeholder="e.g. Garage freezer" />
          </Field>
          <div style={{ marginTop: 10 }}>
            <Field label="Kind" htmlFor="pu-newloc-kind">
              <Select id="pu-newloc-kind" value={kind} onChange={e => setKind(e.target.value)} aria-label="Location kind">
                {STORAGE_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
              </Select>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <Button type="button" variant="primary" loading={busy} loadingLabel="Adding…" onClick={create}>Add</Button>
            <Button type="button" variant="secondary" onClick={() => { setAdding(false); setErr(null) }}>Cancel</Button>
          </div>
        </div>
      )}
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
      <div style={{ marginBottom: 16 }}>
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
          background: P.white, border: `1px solid ${P.border}`, borderRadius: 12 }}>
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
    <div style={{ marginBottom: 16, backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${P.border}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontWeight: 700, color: P.dark, fontSize: '1rem' }}>{group.label}</div>
          {group.use_soon_count > 0 && (
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: P.gold,
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
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
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
        {' · put up '}{prettyDate(rec.preserved_at)}
        {rec.use_by_target ? ` · use by ${prettyDate(rec.use_by_target)}` : ''}
      </div>
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
        color: disabled ? P.light : (tone === 'terra' ? P.terra : P.green), fontSize: '0.82rem', fontWeight: 600,
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
  const [notes, setNotes] = useState(rec.notes || '')

  function save() {
    onSave({
      quantity_value: Number(qtyValue) || rec.quantity_value,
      quantity_unit: qtyUnit,
      package_count: packageCount === '' ? 1 : Number(packageCount),
      method,
      method_other_text: method === 'other' ? (methodOther.trim() || null) : null,
      notes: notes.trim() || null,
    })
  }

  return (
    <div style={{ padding: '14px 16px', borderTop: `1px solid ${P.cream}`, backgroundColor: P.cream }}>
      {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 10 }}>
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
      <div style={{ marginTop: 10 }}>
        <Field label="Containers" htmlFor={`ed-pkg-${rec.id}`}>
          <Input id={`ed-pkg-${rec.id}`} type="number" min={1} value={packageCount}
            onChange={e => setPackageCount(e.target.value)} aria-label="Number of containers" />
        </Field>
      </div>
      <div style={{ marginTop: 10 }}>
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
        <div style={{ marginTop: 10 }}>
          <Field label="What method?" htmlFor={`ed-method-other-${rec.id}`}>
            <Input id={`ed-method-other-${rec.id}`} type="text" value={methodOther}
              onChange={e => setMethodOther(e.target.value)} aria-label="Method description"
              placeholder="Describe how you put it up" />
          </Field>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <Field label="Notes" htmlFor={`ed-notes-${rec.id}`} optional>
          <Textarea id={`ed-notes-${rec.id}`} value={notes} onChange={e => setNotes(e.target.value)}
            aria-label="Notes" style={{ height: 60, resize: 'vertical' }} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <Button type="button" variant="primary" loading={busy} loadingLabel="Saving…" onClick={save}>Save</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}

function Card({ children }) {
  return (
    <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '16px 18px' }}>
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
