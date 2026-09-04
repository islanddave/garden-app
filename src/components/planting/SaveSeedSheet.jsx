// V4-SAVESEEDBTN-001 — "Save seed" from a planting: the CREATE half of the seed-lot flow.
//
// WHY THIS EXISTS. Nothing in this app could create a seed lot. /seeds/saved only attaches a stage
// to an inventory row that already exists, so saving seed off a plant meant hand-building a packet
// at /inventory/add and then finding it again in a 260-row unfiltered picker — and the one door to
// the whole seed surface was the eighth row of a collapsed More sheet.
//
// The structural win of launching from a planting is that the parent is a PARAMETER, not a picker:
// source_plant_id AND variety_id both come off the record this page already loaded, so the sheet
// asks for a name rather than for identity.
//
// V4-SEEDINTAKEAGNOSTIC-001 CORRECTED THE SENTENCE THAT USED TO FOLLOW. It read: "That is also why
// there is no <PlantingSelect> here — a picker on this surface asks a question we already know the
// answer to." True of the planting page, and it quietly became the reason the flow had no other
// entrance: every OTHER surface had to already know the answer too, so /seeds/saved could only point
// at the plant list and say "go and start from there". There IS a PlantingSelect here now, rendered
// only when the caller could not answer — the parameter stays a parameter where it is known.
//
// V4-SEEDSTOREDQTY-001 — AND IT DOES NOT ASK HOW MUCH. It used to offer a packet count defaulting to
// 1, which was a guess dressed as data: at the moment you press "Save seed" the seed is still wet
// and unthreshed and nobody knows the answer. Dave's call, and the shape of the whole flow follows
// from it — the lot is created at 0 and the count is asked at the one moment it is knowable, on the
// move into `stored` (src/pages/SavedSeeds.jsx's advance sheet, and the stage control on
// src/pages/InventoryDetail.jsx). BOTH halves of that last clause have since been corrected:
// BUG-SEEDZEROSOWABLE-001 put an optional count back on this sheet, and V5-SEEDQTY-001 (next
// paragraph) took the opening quantity off quantity_on_hand entirely.
//
// V5-SEEDQTY-001 — AND THE COUNT IS NO LONGER A QUANTITY. `quantity_on_hand` means CONTAINERS
// everywhere now: this create writes 1 (one jar/packet came off this plant) and the measurements —
// seeds counted, grams weighed, or neither — go to inventory_items.seed_count / seed_weight_g
// through PUT /seed-measure, its own narrow route. Dave 2026-09-04: "some packets have count, some
// have grams or mg. We need to account for both aspects", so the sheet asks for both and requires
// neither; the route reads keys by presence, so a field left blank sends nothing. Writing the
// count into quantity_on_hand is what produced prod rows reading "185.000 packet" — one column
// carrying two different facts, and the wide PUT overwriting whichever one it last saw. The three
// measure columns (seed_count, seed_weight_g, seed_count_estimated) are reachable ONLY through that
// route; they are deliberately absent from the wide PUT's SET list, for BUG-INVLOSTUPDATE-001's
// reason (useInventory's adjustQuantity resends an entire stale list row).
//
// WRITE SHAPE (POST /api/inventory-items). Every key is load-bearing; see validateCreate and the
// INSERT column list in lambda/inventory-items/index.js:
//   type 'consumable' + unit 'packet' + quantity_on_hand — validateCreate requires ALL THREE
//     together (quantity_on_hand is the consumable arm's count; `quantity` is the durable one).
//   category 'seeds' — the discriminator both the CHECK and the /source-plant route key off.
//   variety_id — MANDATORY, never sent null. chk_inventory_seed_requires_variety is
//     `category <> 'seeds' OR variety_id IS NOT NULL`, and validateCreate 400s on a seeds row
//     without one before the CHECK ever sees it. Defaulted from the planting, overridable.
//   source_plant_id — the point of the whole feature. BUG-SEEDPOSTDROPSPARENT-001: this key was
//     named in NEITHER the INSERT column list nor its VALUES, so a client that sent one got 201
//     back with the provenance silently dropped. It is persisted and household-authorized now.
//
// THE STAGE IS A SECOND REQUEST, not a field on the create. The INSERT does name seed_stage, but
// writing it there sets the column WITHOUT a seed_lot_stage_log row — and /seeds/saved derives its
// entire queue from stage_entered_at (a lot with no log entry sorts LAST, duration unknown). POST
// /seed-stage writes the column and the log row in one statement, so the lot lands on that page
// with a real clock on it. It also carries its own failure: the lot exists either way, and
// reporting a landed create as failed because an optional stage did not land is the worse error.
//
// V4-SEEDEVENT-001 — AND A THIRD REQUEST: the act itself, on the planting's timeline. Saving seed
// is a two-week ferment→dry→store commitment that paid back nothing — `seed_saved` has been a fully
// declared event type since forever (src/lib/eventTypes.js:71/143/527, mirrored in
// lambda/events/eventTypes.generated.js) and prod has ZERO of them, because nothing ever wrote one.
// The lot alone is invisible from the plant it came off: /inventory/:id shows "Saved from", but the
// planting's own Event log (src/pages/PlantingDetail.jsx §Event log — it renders event_type, date
// and `notes` per row) shows nothing at all. The event is what closes that loop, and it is also the
// only half of this that pays: seed_saved is NOT in NON_REWARD_EVENT_TYPES, so the write grants xp
// and feeds the streak the same as a watering.
//
// THE PATH IS THE APP'S OWN, deliberately and with no shortcut. POST /api/events through the same
// useApiFetch().fetch every other client writer uses — src/pages/EventNew.jsx:1769 and the two
// one-tap loggers, QuickActions.handleWater/handleSprout. That Lambda's POST arm does a household
// ownership gate on plant_id, derives the event's project from the PLANTING rather than the body
// (deriveEventProjectId), stamps `source`, and upserts entity_memory in the same transaction. A
// hand-rolled insert gets none of it.
//
// WHAT IS SENT, AND WHY THAT IS THE WHOLE LIST (checked against validatePostBody + the INSERT):
//   plant_id      — the only anchor needed. validatePostBody wants `project_id OR plant_id`, and
//                   seed_saved is in PLANTING_REQUIRED_TYPES, so this is the required one.
//   project_id    — NOT SENT. With a plant_id present deriveEventProjectId ignores the body's value
//                   entirely and writes the planting's own project, so sending one buys a second
//                   ownership round trip and a new 400 branch in exchange for nothing.
//   event_date    — todayLocalISO(), for BUG-GERMDATEBATCH-001's reason: omitting it falls through
//                   to the Lambda's `new Date()`, which is UTC, so an evening save in Conway files
//                   on tomorrow. normalizeEventDate anchors a bare YYYY-MM-DD at noon UTC.
//   notes         — see seedSavedNote. Every clause is true at the instant it is written.
//   quantity/unit — NEITHER IS SENT, and neither is required: event_log.quantity is nullable free
//                   text (absent and null are the same value to the INSERT) and there is no unit
//                   column on event_log at all — units live on harvest_log, behind event_type
//                   'harvest'. Sending a count here would be the same fabrication the create
//                   refuses at quantity_on_hand.
//   metadata      — NOW SENT as `{ seed_lot_id }`, guarded on the lot id. This note previously said
//                   NOT SENT, on two grounds; one was false and the other was not what it claimed.
//                   * FALSE: "event_log has no inventory FK". It does — `treatment_product_id`
//                     REFERENCES inventory_items(id), verified in prod pg_constraint. There is no
//                     seed-lot-specific column, which is the true statement, and that FK is also a
//                     house precedent for a typed column here if this is ever promoted out of jsonb.
//                   * TRUE BUT NOT DECISIVE: EventDetail does render unlabelled metadata keys as raw
//                     monospace `key value`. But that is not a NEW risk this key would introduce —
//                     it is already shipped behaviour on 27 of the 35 live metadata keys, including
//                     `batch_id`, a bare uuid rendering on 12,920 prod events today. Withholding the
//                     only durable event→lot link to avoid becoming the 28th instance was protecting
//                     the wrong thing.
//                   The raw-uuid half is closed properly instead: `seed_lot_id` is in
//                   METADATA_HIDDEN_KEYS, the same treatment as `water_depth_source` — machine
//                   provenance, stored and queryable, never rendered as a detail row.
//                   GUARDED on `lot?.id` because `JSON.stringify({ seed_lot_id: undefined })` yields
//                   `{}`, which passes isPlainMetadataObject and would persist an empty jsonb object
//                   instead of NULL. No Lambda change was needed: validateEventMetadata has no key
//                   allowlist and seed_lot_id is not in REDUCTION_KEYS.
//
// IT CANNOT FAIL THE SAVE. Same reasoning as the stage above, one step further: the user asked for
// a lot, not for a timeline row, and the stage at least was something they explicitly chose here
// ("Start tracking it?"), which is why ITS failure changes the toast. This one they never asked
// for and could not act on, so its failure is swallowed and the flow finishes exactly as it would
// have — lot created, toast shown, routed to /inventory/:id.
import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sheet, PlantingSelect, Badge } from '../forms'
import VarietyPicker from '../VarietyPicker.jsx'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import { todayLocalISO } from '../../lib/dateLocal.js'
import { P } from '../../lib/constants.js'
import { PUTUP_SOURCE_OPTIONS } from '../../lib/dropdownRegistry.js'


// MIRRORS src/pages/SavedSeeds.jsx's PROCESS_ENTRY, deliberately rather than importing it: that is
// a page, and a component reaching into a page for a constant inverts the dependency. Both copies
// are the live vocabulary of the two DB CHECKs, not UI invention —
// inventory_items_seed_process_check is `wet | dry | fresh` and inventory_items_seed_stage_check is
// `fermenting | drying | stored`. The wet/dry split is BUG-SEEDPROCFORCED-001: beans, peas, lettuce
// and every brassica are threshed from a pod that dried on the plant and never fermented, so a
// hard-coded `fermenting` entry writes a permanent false row into seed_lot_stage_log.
//
// V4-SEEDFRESHPROCESS-001 added the third value for the SAME class of error one step further out.
// Dave 2026-09-03: peppers go "from fresh plant to drying for a few days then saved", and neither
// label covered it — `wet` said "washed or fermented" but routed to `fermenting`, and `dry` said
// "dried on the plant". Full rationale lives beside the SavedSeeds copy; keep the two in step.
const PROCESS_ENTRY = {
  wet: {
    stage: 'fermenting',
    label: 'Wet — ferment first',
    sub: 'Tomato, cucumber, melon: seed sits in its own pulp for a few days first',
  },
  fresh: {
    stage: 'drying',
    label: 'Fresh — rinse and dry',
    sub: 'Pepper, squash: seed scraped from a ripe fruit, no ferment — straight onto a plate or screen',
  },
  dry: {
    stage: 'drying',
    label: 'Dry — threshed from a dried pod',
    sub: 'Beans, peas, lettuce, brassicas: pod dried on the plant before you opened it',
  },
}

/**
 * V4-SAVESEEDBTN-001 — the lot's opening name. Pure, exported for test.
 * Variety first because that is what the seed IS; the planting's own name is the fallback for a
 * planting with no cultivar attached. The year is what separates this lot from next season's, and
 * it is the LOCAL year — a December save in Eastern would file under next year off a UTC clock.
 * Always editable: this is a starting point, not a naming scheme.
 */
export function defaultLotName(planting, today = todayLocalISO()) {
  const base = planting?.variety_ref?.name || planting?.name || ''
  const year = String(today).slice(0, 4)
  return base ? `${base} — saved ${year}` : `Saved seed ${year}`
}

/**
 * V4-SEEDEVENT-001 — the seed_saved note. Pure, exported for test.
 *
 * The Event log row already renders the type ("seed saved") and the date, so the note's whole job
 * is the part the row cannot know: WHICH lot came off this plant, and why it carries no number.
 *
 * Every clause is checkable at the moment it is written, which is the constraint that shapes it:
 *   • the lot NAME is what the create was called with, one statement earlier.
 *   • `stage` is passed ONLY after POST /seed-stage has resolved — never from the user's radio
 *     choice. The stage request has its own independent failure (see save()), and a note claiming
 *     "fermenting" for a stage write that 500'd is a permanent false sentence on the timeline.
 *     No process chosen, or the stage write failed, and the clause is simply absent — never
 *     "unknown", which would assert something about a question that was not asked.
 *   • "No count yet" is the literal state: quantity_on_hand is 0-because-unmeasured, and the count
 *     is asked on the move into `stored` (V4-SEEDSTOREDQTY-001). It is the same sentence the sheet
 *     puts on screen at save-seed-count-note, so the timeline does not contradict the form.
 */
export function seedSavedNote(lotName, stage = null) {
  return `Seed lot "${String(lotName).trim()}"${stage ? `, ${stage}` : ''}.`
    + " No count yet — recorded when it's marked stored."
}

/**
 * BUG-SEEDZEROSOWABLE-001 — the opening count. Pure, exported for test.
 * Blank -> 0, which is the create-time "nobody has counted this yet" placeholder and the only value
 * consumable_requires_quantity_on_hand accepts in place of one. A typed number is taken as given.
 * Rejects negatives and non-numbers rather than coercing: Number('') is 0 and Number('abc') is NaN,
 * so a bare Number() would turn a typo into a silent zero on the one field that decides whether the
 * lot is sowable.
 *
 * WHY THIS FIELD IS BACK. V4-SEEDSTOREDQTY-001 removed a packet count from this sheet and moved the
 * question to the move into `stored`. It removed the right thing for the right reason — that field
 * DEFAULTED TO 1, a guess dressed as data — but it drew too general a conclusion from it, that the
 * count is unknowable until the lot is packeted. Dave 2026-09-02: "I might save 10 seeds and know it
 * from the first moment, or I might have saved dozens/hundreds and not know how many potentially
 * viable ones I'll save in the end. Each step needs to be able to set/update that count."
 *
 * So the field returns BLANK-BY-DEFAULT and optional. Nothing is fabricated, nothing is defaulted to
 * a number no one typed, and the stage sheets on /seeds/saved carry the same field for the same
 * reason (src/pages/SavedSeeds.jsx COUNT_ASK).
 */
export function parseOpeningCount(raw) {
  const typed = String(raw ?? '').trim()
  if (typed === '') return { value: 0, error: null }
  const n = Number(typed)
  if (!Number.isFinite(n)) return { value: null, error: 'That is not a number.' }
  if (n < 0) return { value: null, error: 'A count cannot be negative.' }
  return { value: n, error: null }
}

/**
 * V5-SEEDQTY-001 — the opening WEIGHT, and the other half of Dave's requirement: "some packets have
 * count, some have grams or mg. We need to account for both aspects." Pure, exported for test.
 * Returns { value: grams|null, error }.
 *
 * GRAMS IS THE STORED UNIT and a BARE NUMBER IS GRAMS. That is the one decision in here that could
 * do real damage if it went the other way: reading a bare number as milligrams would be a silent
 * 1000x error on every packet, with nothing downstream able to notice — 28 g of beans and 28 mg of
 * lettuce seed are both plausible rows. So the suffix is what changes the unit, never the magnitude,
 * and the field hint says so on screen rather than leaving it to be inferred.
 *
 * DECIMALS ARE LEGAL HERE, unlike the count beside it: 0.5 g is an ordinary packet and seed_weight_g
 * is numeric(10,3), where the count is an integer column. 3dp is the column's whole resolution, so
 * the value is rounded to it HERE rather than left for Postgres to round on insert — what we send is
 * then exactly what is stored, and a lot's weight never comes back different from what was typed.
 *
 * A POSITIVE WEIGHT THAT ROUNDS TO ZERO IS REFUSED, not stored. 0 on this column means "weighed it,
 * there is nothing there", the same measured fact 0 means on the count; writing it for 0.0004 g
 * would be the one rounding that changes the sentence rather than its precision.
 */
export function parseSeedWeight(raw) {
  const typed = String(raw ?? '').trim()
  if (typed === '') return { value: null, error: null }
  const m = typed.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(g|mg)?$/i)
  if (!m) return { value: null, error: 'That is not a weight — type a number of grams, or add "mg".' }
  const n = Number(m[1])
  if (!Number.isFinite(n)) return { value: null, error: 'That is not a weight — type a number of grams, or add "mg".' }
  if (n < 0) return { value: null, error: 'A weight cannot be negative.' }
  const grams = m[2] && m[2].toLowerCase() === 'mg' ? n / 1000 : n
  const rounded = Math.round(grams * 1000) / 1000
  if (grams > 0 && rounded === 0) {
    return { value: null, error: 'That is finer than a milligram — round it to the nearest mg.' }
  }
  return { value: rounded, error: null }
}

/**
 * V5-SEEDQTY-001 — what PUT /seed-measure should carry, or null for "do not call it at all". Pure,
 * exported for test.
 *
 * BLANK IS NOT ZERO ON THIS ROUTE, which is the whole reason this is a second function rather than
 * a use of the one above. parseOpeningCount maps a blank field to 0 because the CREATE needs a
 * number — consumable_requires_quantity_on_hand refuses NULL, so 0 was the only placeholder that
 * column would accept for "nobody has counted this yet". seed_count carries no such constraint: it
 * is nullable, and NULL is exactly that sentence. Passing the blank field's 0 through would write a
 * MEASURED ZERO — "I counted, there are none" — onto a lot whose owner typed nothing, on the one
 * column the schema notes call out as a fact rather than a placeholder. So a blank field sends no
 * request, and the column stays NULL.
 *
 * seed_count_estimated is FALSE on everything this sheet writes: a number typed while holding the
 * seed is a counted number, not a vendor claim off the back of a packet. It rides with the COUNT and
 * only with the count — it is a statement about that number's provenance, and sending it beside a
 * weight alone would claim something about a count that was never given.
 *
 * KEY-BY-KEY, because the route reads BY PRESENCE: a packet states a count or a weight, rarely both,
 * so each field independently either contributes its key or does not exist in the body. Both blank
 * returns null and no request is made at all.
 */
export function seedMeasurePayload(rawCount, rawWeight = '') {
  const payload = {}
  if (String(rawCount ?? '').trim() !== '') {
    const { value, error } = parseOpeningCount(rawCount)
    if (!error) {
      payload.seed_count = value
      payload.seed_count_estimated = false
    }
  }
  const weighed = parseSeedWeight(rawWeight)
  if (!weighed.error && weighed.value != null) payload.seed_weight_g = weighed.value
  return Object.keys(payload).length ? payload : null
}

/**
 * V5-VARIETYHYBRIDFLAG-001 — the reader half. Design V101 §5: ONE surface, ONE firing arm.
 *
 * Returns null for "say nothing at all", or { tone, badge, line }. `tone: null` means a plain line
 * with no badge.
 *
 * THE EMPTY STATE IS THE IMPORTANT ONE. 404 of 483 live cultivars have never been assessed, and on
 * those this returns null — no badge, no line, no reserved space. A warning that appears on every
 * save is trained away within a week; this one fires on 19 rows and can never cry wolf.
 *
 * OPEN-POLLINATED MUST NOT BE SILENT, and that is not a nicety. If only the F1 arm ever spoke, then
 * silence would mean both "we checked and it is fine" and "nobody ever looked" — and once those two
 * are indistinguishable the warning's absence carries no information, which destroys the value of
 * the warning's presence. The positive line is what makes silence honestly mean "unknown".
 *
 * THE COPY DOES NOT CALL SAVING F1 SEED A MISTAKE. Deliberate F2 growing-out is how dehybridizing
 * starts and is a legitimate thing to do on purpose; the sentence names the consequence and the
 * alternative and then gets out of the way.
 *
 * SHIPPED ENUM, verified against chk_plant_varieties_breeding_system on live prod 2026-09-03:
 * f1 | open_pollinated | landrace | unknown, plus NULL. Note the design text refers to an
 * `f2_or_later` value — it was NOT shipped and does not exist in the CHECK. `landrace` is the
 * mirror case: it IS in the CHECK and the design's state table never mentions it, so it gets its
 * own line here rather than being folded into open_pollinated, which would assert uniformity a
 * landrace does not have. breedingNoticeCoverage.test.js reads the CHECK's own value list out of
 * the migration and fails if any allowed value has no arm here, so widening the enum cannot
 * silently reintroduce the empty case this function exists to make meaningful.
 */
export function breedingNotice(variety) {
  switch (variety?.breeding_system) {
    case 'f1':
      return {
        tone: 'warn',
        badge: 'F1 hybrid',
        line: 'Seed from an F1 will not come true — what grows next year will vary, sometimes a lot. '
            + 'Worth saving if you want to see what it throws; buy fresh seed if you want this exact plant again.',
      }
    case 'open_pollinated':
      // Deliberately hedged on isolation. Breeding status and PURITY are different facts (design
      // V101 §8): an OP variety grown in a shared pool still crosses. Claiming it "comes true" flat
      // would overclaim exactly the thing V5-SEEDLOTPROVENANCE-001 exists to track separately.
      return {
        tone: null,
        badge: null,
        line: 'Open-pollinated — its seed comes true, as long as it did not cross with something flowering nearby.',
      }
    case 'landrace':
      return {
        tone: null,
        badge: null,
        line: 'A landrace — variable by design. Saved seed keeps the population, not one uniform plant.',
      }
    case 'unknown':
      return {
        tone: null,
        badge: null,
        line: 'We looked and could not tell whether this one is a hybrid — the seed packet or catalogue will say.',
      }
    default:
      // NULL (never asked) AND any value a future migration adds that this build predates. Silence
      // is the right answer for both: this component must never assert a breeding claim it does not
      // have. The coverage test above is what stops the second case from going unnoticed.
      return null
  }
}

/** The planting's own cultivar, in the shape VarietyPicker's `value` wants. Null when it has none. */
function plantingVariety(planting) {
  const ref = planting?.variety_ref
  if (ref?.id) return ref
  // A record can carry variety_id without the joined ref (narrow projections do). The id is what
  // the write needs, so keep it and let the picker fill the name in if the user opens it.
  if (planting?.variety_id) return { id: planting.variety_id, name: '' }
  return null
}

// V4-SEEDINTAKEAGNOSTIC-001 — the eight source kinds, straight from the shipped registry rather than
// a fourth hand-typed copy. That vocabulary is synchronised across four homes (this registry,
// lambda/preservation/provenance.js, lambda/inventory-items/source-kinds.js and the DB CHECK
// chk_inventory_source_kind) and is pinned by preservationProvenance.test.js; typing a fifth list
// here is exactly how the fifth home drifts.
const NON_GARDEN_KINDS = PUTUP_SOURCE_OPTIONS.filter((o) => (o.value ?? o) !== 'own_garden')

/**
 * `planting` is OPTIONAL as of V4-SEEDINTAKEAGNOSTIC-001.
 *
 * WHEN IT IS PASSED (the planting page, the event menu) nothing about this sheet changes: the parent
 * is a parameter, the variety is seeded from the record the page already loaded, and the whole happy
 * path is still zero reads.
 *
 * WHEN IT IS ABSENT the sheet asks the one question the caller could not answer — where did this seed
 * come from — and offers both real answers. Dave, 2026-09-03: "I still cannot find an easy way to
 * start a saved seed path anywhere... I need an agnostic intake form which can either select from a
 * planting or create a no-planting parent."
 *
 * He is the THIRD person to walk into this, and the previous two fixes both stopped short at the same
 * wall: the empty-state copy said "open that planting and tap Save seed", and its own comment
 * conceded why — "the Save-seed sheet needs a planting as a parameter, so the honest route is pick
 * the plant, then Save seed on its page". That parameter WAS the defect. A door that only opens from
 * somewhere else is not a door.
 *
 * The no-planting arm writes `source_kind` and no `source_plant_id`, which is the shape the schema
 * already expects: chk_inventory_source_provenance is `source_kind IS NULL OR source_kind =
 * 'own_garden' OR source_plant_id IS NULL`. It writes NO timeline event either — there is no plant to
 * hang one on, and inventing a placeholder planting to carry it would put plants in the garden that
 * were never planted.
 */
export default function SaveSeedSheet({ planting, onClose }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const navigate = useNavigate()

  // The planting this save is FOR: the prop when the caller knew it, otherwise whatever the user
  // picks below. Every downstream read goes through this, never through `planting` directly.
  const [picked, setPicked] = useState(null)
  const parent = planting ?? picked
  // null until answered, and only asked when the caller did not already know. 'plant' | 'other'.
  const [origin, setOrigin] = useState(planting ? 'plant' : null)
  const [sourceKind, setSourceKind] = useState('')


  const seeded = plantingVariety(parent)
  const [name, setName] = useState(() => defaultLotName(planting))
  const [variety, setVariety] = useState(seeded)
  // Open by default ONLY when there is nothing to show. The picker's hook fetches /api/varieties on
  // mount, so keeping it collapsed on the common path (the planting knows its cultivar) keeps the
  // whole happy path to zero reads.
  const [pickerOpen, setPickerOpen] = useState(!seeded)
  const [seedProcess, setSeedProcess] = useState(null)
  // BUG-SEEDZEROSOWABLE-001 — blank means "haven't counted"; see parseOpeningCount.
  const [count, setCount] = useState('')
  // V5-SEEDQTY-001 — the alternative to the count, not a second thing to fill in. See parseSeedWeight.
  const [weight, setWeight] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const varietyId = variety?.id ?? null
  // The missing VARIETY is deliberately NOT in here, and that is the one interesting line in this
  // component. A disabled Save plus an in-writer guard would be two mechanisms enforcing one rule,
  // and a redundant mechanism cannot be tested: neutralise either half and the other keeps the
  // suite green, so neither is ever proven to work. One mechanism, and it is the one that can
  // SPEAK — a dead grey button is not an explanation, an inline sentence naming the missing field
  // is. The name stays here because a disabled control is the conventional answer for a field the
  // user can see is blank; the variety is the one that maps to a DB CHECK.
  const canSave = !!name.trim() && !busy

  async function save() {
    if (busy) return
    // chk_inventory_seed_requires_variety refuses `category='seeds' AND variety_id IS NULL`, and
    // validateCreate 400s on it first. Both would tell us what we already know, so nothing leaves
    // the client — the user gets the answer here instead of after a round trip.
    if (!varietyId) {
      setError('Pick the variety this seed came from — a seed lot has to name one.')
      return
    }
    if (!name.trim()) return
    // BUG-SEEDZEROSOWABLE-001 — same shape as the variety guard above: answered here rather than
    // after a round trip, because a negative or unparseable count is something the client can see.
    const opening = parseOpeningCount(count)
    if (opening.error) {
      setError(opening.error)
      return
    }
    // V5-SEEDQTY-001 — WHOLE SEEDS, and this guard is new because the destination column changed
    // under it. A decimal used to be legal: the count went to quantity_on_hand, numeric(10,3).
    // seed_count is an INTEGER column and PUT /seed-measure refuses a non-integer outright
    // (lambda/inventory-items/index.js — "seed_count must be a whole number of seeds, or null"), so
    // without this the lot is created, the measure 400s, and the number the user typed is dropped
    // with only a toast to show for it. Answered here for the same reason the two guards above are:
    // the client can see it, so the round trip buys nothing.
    if (!Number.isInteger(opening.value)) {
      setError('A seed count is a whole number of seeds.')
      return
    }
    // Same client-first treatment as the two guards above. The weight's own errors are things the
    // user can see and fix — a stray letter, a negative, a value finer than the column records.
    const weighed = parseSeedWeight(weight)
    if (weighed.error) {
      setError(weighed.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const lot = await fetch('/api/inventory-items', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          category: 'seeds',
          type: 'consumable',
          unit: 'packet',
          // V5-SEEDQTY-001 — ONE CONTAINER, and never the seed count. This column means packets on
          // the shelf everywhere now; the count the user typed goes to PUT /seed-measure below.
          // Hard-coded 1 rather than derived from anything: a save-seed act produces one jar, and
          // the number of seeds in it is a different question this row no longer answers.
          //
          // NEVER NULL, whatever the user typed. The live CHECK
          // consumable_requires_quantity_on_hand is `type <> 'consumable' OR quantity_on_hand IS NOT
          // NULL`, so a consumable row with a null count is refused outright — which is why this is
          // 1 and not omitted.
          quantity_on_hand: 1,
          variety_id: varietyId,
          // V4-SEEDINTAKEAGNOSTIC-001 — `parent`, not `planting`: the prop when the caller knew it,
          // the picked planting when the user chose one, and NULL for seed that came from no plant
          // of ours. The two keys below are mutually exclusive by DB CHECK
          // (chk_inventory_source_provenance: source_kind IS NULL OR source_kind = 'own_garden' OR
          // source_plant_id IS NULL), so sending both a parent and a non-garden kind would be a 400.
          // Spread rather than a null, for the same reason the event metadata is spread: the route
          // reads source_kind by PRESENCE, so an explicit null and an absent key are different.
          source_plant_id: parent?.id ?? null,
          ...(!parent && sourceKind ? { source_kind: sourceKind } : {}),
        }),
      })
      // V5-SEEDQTY-001 — the count, as its own request on its own route. Same shape of decision as
      // the stage below: a second write that the lot's existence does not depend on, so it carries
      // its own failure rather than failing the save. The lot is what the user asked for and it
      // landed; the toast says which of the follow-ups did not.
      //
      // SKIPPED ENTIRELY ON A BLANK FIELD — see seedMeasurePayload. A blank count is not a zero, and
      // the request that would write one is the request not made.
      let measureFailed = false
      const measure = seedMeasurePayload(count, weight)
      if (measure && lot?.id) {
        try {
          await fetch(`/api/inventory-items/${lot.id}/seed-measure`, {
            method: 'PUT',
            body: JSON.stringify(measure),
          })
        } catch {
          measureFailed = true
        }
      }
      let stageFailed = false
      // Set only AFTER the stage POST resolves, which is what makes it safe to put in the event's
      // note: it records the stage that LANDED, not the one that was asked for.
      let stageWritten = null
      if (seedProcess && lot?.id) {
        try {
          await fetch(`/api/inventory-items/${lot.id}/seed-stage`, {
            method: 'POST',
            // entered_at omitted on purpose: absent -> now() server-side, and this stage IS being
            // entered now. The column is a timestamptz, so there is no date-only off-by-one to
            // guard against here — unlike the backdated advance on /seeds/saved.
            body: JSON.stringify({ stage: PROCESS_ENTRY[seedProcess].stage, seed_process: seedProcess }),
          })
          stageWritten = PROCESS_ENTRY[seedProcess].stage
        } catch {
          stageFailed = true
        }
      }
      // V4-SEEDEVENT-001 — the trace, on the app's own event path. Full rationale for the payload
      // and for the swallowed failure is in the header note. Reached only from here, after a create
      // that RESOLVED, so it fires exactly once per lot and not at all for a create that threw or a
      // sheet the user closed without saving.
      //
      // V4-SEEDINTAKEAGNOSTIC-001 — GATED ON A PARENT, and this is a real branch rather than a
      // defensive `?.`. `plant_id` is REQUIRED for this event type (seed_saved is in
      // PLANTING_REQUIRED_TYPES and validatePostBody wants project_id OR plant_id), so a no-planting
      // lot has nowhere to put a timeline row: there is no plant whose timeline it would appear on.
      // Skipping the POST is the honest outcome. The alternative — inventing a placeholder planting
      // to carry the event — would put plants in the garden that were never planted, which is a
      // worse lie than a missing row.
      if (parent) try {
        await fetch('/api/events', {
          method: 'POST',
          body: JSON.stringify({
            plant_id: parent.id,
            event_type: 'seed_saved',
            event_date: todayLocalISO(),
            notes: seedSavedNote(name.trim(), stageWritten),
            // Spread, not a bare key: an unguarded `{ seed_lot_id: undefined }` serialises to `{}`,
            // which is a valid plain object to the validator and persists an empty jsonb instead of
            // NULL — a row that looks linked and is not.
            ...(lot?.id ? { metadata: { seed_lot_id: lot.id } } : {}),
          }),
        })
      } catch {
        // Deliberately nothing. The lot is what the user asked for and it exists; a message about a
        // timeline row they never requested is noise they cannot act on, and re-raising here would
        // report a landed create as a failed save.
      }
      // Built from a list rather than nested ternaries because there are now TWO optional writes
      // that can miss independently, and a message naming only one of them would be a false all-
      // clear on the other. The stage-only wording is unchanged from what shipped.
      // Named after what the user actually typed rather than after the route: "couldn't record the
      // count" on a save where they only gave a weight would be a message about something they
      // never entered.
      const has = (k) => !!measure && Object.prototype.hasOwnProperty.call(measure, k)
      const measureNoun = has('seed_count') && has('seed_weight_g') ? 'record the count and weight'
        : has('seed_weight_g') ? 'record the weight'
        : 'record the count'
      const missed = [
        measureFailed && measureNoun,
        stageFailed && 'start tracking it',
      ].filter(Boolean)
      toast.show(missed.length
        ? { message: `Seed lot saved — couldn't ${missed.join(' or ')}`, tone: 'error' }
        : { message: 'Seed lot saved', tone: 'success' })
      if (onClose) onClose()
      // WHERE THE ACTION ENDS — and it now depends on whether the lot joined a QUEUE.
      //
      // Until V5-SEEDSAVEDFILTER-001 this always went to /inventory/:id, with a good reason: that is
      // where "Saved from" renders, so the user lands looking at the provenance they just created.
      // The reason is still good, but it only covers the lot that has no stage. A lot that DID get a
      // process is now sitting in the fermenting or drying queue on /seeds/saved with a clock
      // running on it — and that page had no entry point from anywhere the user had just been. It
      // holds the only overdue-ferment warning in the app (past day 5 the seed sprouts in the jar and
      // the lot is finished), so the queue is exactly what a freshly-tracked lot should be shown, and
      // showing it once here is what teaches the page exists at all.
      //
      // Split rather than switched wholesale: an untracked lot has no row on /seeds/saved, so sending
      // it there would land the user on a page that does not mention the thing they just saved.
      //
      // `stageFailed` deliberately routes to the lot page too. The toast already says tracking did
      // not start; dropping the user into a queue their lot is NOT in would contradict it.
      //
      // A PLAIN navigate, not useOverlayNavigate — neither route is registered `overlayable`, so a
      // background in route state would leave the page tree on this planting and render nothing.
      if (stageWritten && !stageFailed) navigate('/seeds/saved')
      else if (lot?.id) navigate(`/inventory/${lot.id}`)
    } catch (err) {
      setError(err?.message || "Couldn't save the seed lot")
    } finally {
      setBusy(false)
    }
  }

  // BUG-SEEDSHEETBACK-001 (pre-promote MIN-3) — `armsBack` below is a per-render-site decision,
  // exactly as Sheet's own contract requires. The arming defaults OFF because one useDismissable
  // call serves every Sheet, and enrolling them all would orphan a pushed entry on BottomNav's
  // navigate-and-close rows. This sheet is the other category — the close-in-place kind the prop
  // exists for: closing it returns you to the page underneath and navigates nowhere.
  //
  // WHY IT MATTERS MORE HERE THAN ELSEWHERE. Dave is Android-only in an installed PWA, where Back is
  // a system gesture rather than a chrome button. Unarmed, no marker is registered, so Back fell
  // through to a plain history pop — and reached from the /log menu door this sheet sits INSIDE the
  // overlayable /log route, so ONE Back unwound the whole route and took the half-typed lot name,
  // count and process choice with it. Armed, decideBack dismisses the topmost layer only: one Back
  // closes the sheet, a second leaves /log.
  return (
    <Sheet open busy={busy} armsBack onClose={onClose} title="Save seed">
      {/* V4-SEEDINTAKEAGNOSTIC-001 — the origin block. Rendered ONLY when the caller could not
          answer it: from a planting page or the event menu this whole section is absent and the
          sheet is byte-identical to what shipped. */}
      {parent ? (
        <p style={{ margin: '0 0 14px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.5 }}>
          From {parent?.name || 'this planting'} — the lot remembers which plant it came off.
        </p>
      ) : origin === null ? (
        <div style={{ margin: '0 0 14px' }}>
          <p style={{ margin: '0 0 10px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.5 }}>
            Where did this seed come from?
          </p>
          {/* Block targets at the full tap minimum, not inline links. This is the primary action of
              the sheet, on the first screen, reached with seedy hands — the same reason
              BUG-SEEDTAPTARGET-001 raised the card anchors off 15px. */}
          {[
            ['plant', 'One of my plants', 'Pick the planting it came off'],
            ['other', 'Somewhere else', 'Shop, gift, u-pick, foraged…'],
          ].map(([val, label, hint]) => (
            <button
              key={val} type="button" onClick={() => setOrigin(val)}
              data-testid={`seed-origin-${val}`}
              style={{
                display: 'block', width: '100%', textAlign: 'left', marginBottom: 8,
                minHeight: 56, padding: '10px 12px', borderRadius: 10,
                border: `1px solid ${P.border}`, background: '#fff', cursor: 'pointer',
              }}
            >
              <span style={{ display: 'block', fontWeight: 600, color: P.dark, fontSize: '0.92rem' }}>{label}</span>
              <span style={{ display: 'block', color: P.mid, fontSize: '0.78rem', marginTop: 2 }}>{hint}</span>
            </button>
          ))}
        </div>
      ) : origin === 'plant' ? (
        <div style={{ margin: '0 0 14px' }}>
          {/* PlantingSelect, NOT a hand-rolled list. It self-fetches, sorts, formats the label and
              carries the row through onChange so this sheet never needs its own id->row lookup — and
              it is already the picker every other surface uses. The first draft of this block DID
              hand-roll a search box and a capped list, which would have been a third matching
              dialect in a codebase that has spent real effort collapsing them to two. */}
          <label style={fieldLabelStyle}>
            Which plant?
            <PlantingSelect
              value={picked?.id ?? ''}
              onChange={(_id, row) => setPicked(row)}
              labelFormat="qtyVariety"
              data-testid="seed-plant-select"
            />
          </label>
          <button
            type="button" onClick={() => setOrigin(null)}
            style={{ marginTop: 8, background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: '0.82rem', padding: '8px 0' }}
          >
            ← Not from one of my plants
          </button>
        </div>
      ) : (
        <div style={{ margin: '0 0 14px' }}>
          <label style={fieldLabelStyle}>
            Where did it come from?
            <select
              value={sourceKind} onChange={(e) => setSourceKind(e.target.value)}
              data-testid="seed-source-kind" style={inputStyle}
            >
              <option value="">Choose…</option>
              {NON_GARDEN_KINDS.map((o) => {
                const v = o.value ?? o
                return <option key={v} value={v}>{o.label ?? v}</option>
              })}
            </select>
          </label>
          <button
            type="button" onClick={() => setOrigin(null)}
            style={{ marginTop: 8, background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: '0.82rem', padding: '8px 0' }}
          >
            ← It did come off one of my plants
          </button>
        </div>
      )}

      <label style={fieldLabelStyle}>
        Lot name
        <input
          type="text" value={name} onChange={(e) => setName(e.target.value)}
          data-testid="save-seed-name" style={inputStyle}
        />
      </label>

      <div style={fieldLabelStyle}>
        Variety
        {!pickerOpen && (
          <div style={varietyRowStyle}>
            <span data-testid="save-seed-variety-name" style={{ fontWeight: 400, color: P.dark }}>
              {variety?.name || "this planting's variety"}
            </span>
            <button
              type="button" data-testid="save-seed-variety-change"
              onClick={() => setPickerOpen(true)} style={linkBtnStyle}
            >
              Change
            </button>
          </div>
        )}
      </div>
      {pickerOpen && (
        <div data-testid="save-seed-variety-picker" style={{ marginBottom: 14 }}>
          <VarietyPicker
            id="save-seed-variety" value={variety} onChange={setVariety} required
          />
          {!varietyId && (
            // Named, not silent: a planting with no cultivar is the ONE case this flow cannot
            // default its way out of, and the user needs to know why Save is off.
            <p data-testid="save-seed-no-variety" style={hintStyle}>
              This planting has no variety recorded. Pick the variety this seed came from — a seed
              lot has to name one.
            </p>
          )}
        </div>
      )}

      {/* BUG-SEEDZEROSOWABLE-001 — the count, offered at the FIRST step rather than only the last.
          Blank-by-default and never pre-filled with a number: see parseOpeningCount for why that
          distinction is the whole difference between this field and the one V4-SEEDSTOREDQTY-001
          correctly removed. */}
      <label style={fieldLabelStyle}>
        How many? <span style={{ color: P.light, fontWeight: 400 }}>(optional)</span>
        {/* inputMode NUMERIC, not decimal: seed_count is an integer column and a decimal point one
            tap away on Dave's Android keypad is a 400 from the route (see the whole-number guard in
            save()). The weight field below is the one that wants a decimal pad. */}
        <input
          type="number" inputMode="numeric" min="0" step="1" value={count}
          onChange={(e) => setCount(e.target.value)}
          placeholder="e.g. 20"
          aria-describedby="save-seed-count-note"
          data-testid="save-seed-count" style={inputStyle}
        />
      </label>
      <p id="save-seed-count-note" data-testid="save-seed-count-note" style={{ ...hintStyle, margin: '0 0 14px' }}>
        Leave it blank if the seed is still wet and unthreshed. You can set or change the count at
        every step, and you&apos;ll be asked for a final one when you mark the lot stored.
      </p>

      {/* V5-SEEDQTY-001 — the weight, and it is an ALTERNATIVE to the count rather than a second
          thing to fill in: a packet states one or the other and rarely both. Hence "Or", and hence
          both fields optional and blank.

          type="text", NOT type="number", and that is load-bearing: a number input rejects "2.5 g"
          and hands back an EMPTY string for it in every browser, so the suffix this field documents
          would silently erase what the user typed. inputMode decimal for the keypad. */}
      <label style={fieldLabelStyle}>
        Or a weight <span style={{ color: P.light, fontWeight: 400 }}>(optional)</span>
        <input
          type="text" inputMode="decimal" value={weight}
          onChange={(e) => setWeight(e.target.value)}
          placeholder="e.g. 2.5 g"
          aria-describedby="save-seed-weight-note"
          data-testid="save-seed-weight" style={inputStyle}
        />
      </label>
      <p id="save-seed-weight-note" data-testid="save-seed-weight-note" style={{ ...hintStyle, margin: '0 0 14px' }}>
        Whichever the packet tells you &mdash; a count or a weight. A bare number is GRAMS; type
        &ldquo;mg&rdquo; after it for milligrams, e.g. 250 mg.
      </p>

      {/* Optional, and DEFAULTED OFF. Choosing a process writes a permanent seed_lot_stage_log row,
          so the sheet must not pick one on the user's behalf — that is BUG-SEEDPROCFORCED-001 in a
          new place. "Not yet" leaves the lot un-staged, exactly as /inventory/add would. */}
      <div style={fieldLabelStyle} id="save-seed-process-label">Start tracking it?</div>
      <div role="group" aria-labelledby="save-seed-process-label" style={{ marginBottom: 14 }}>
        {[['none', 'Not yet — just save the lot', 'It sits in Inventory until you start the process'],
          ...Object.entries(PROCESS_ENTRY).map(([k, m]) => [k, m.label, m.sub])].map(([key, label, sub]) => {
          const selected = key === 'none' ? seedProcess === null : seedProcess === key
          return (
            <button
              key={key} type="button" data-testid={`save-seed-process-${key}`}
              aria-pressed={selected}
              onClick={() => setSeedProcess(key === 'none' ? null : key)}
              style={processRowStyle(selected)}
            >
              <span style={{ fontWeight: 600 }}>{label}</span>
              <span style={{ display: 'block', color: P.light, fontSize: '0.78rem', marginTop: 2 }}>
                {sub}
              </span>
              {key !== 'none' && (
                <span style={{ display: 'block', color: P.light, fontSize: '0.78rem', marginTop: 4 }}>
                  Starts in {PROCESS_ENTRY[key].stage}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {error && (
        <p role="alert" data-testid="save-seed-error" style={errorStyle}>{error}</p>
      )}

      {/* V5-VARIETYHYBRIDFLAG-001 reader. Keyed on `variety` — the state that will actually be
          WRITTEN — and deliberately not on the `planting` prop. Those differ whenever the user opens
          the picker and chooses a different cultivar, and that case is the one most worth getting
          right: a deliberately-named variety is the most considered save there is, and reading the
          prop would show the warning for the plant they started from rather than the seed they are
          saving. Sits above Save rather than beside the variety row so it is the last thing read
          before the tap it is about. Renders NOTHING (not an empty box) when there is no assessment
          — see breedingNotice. */}
      {(() => {
        const notice = breedingNotice(variety)
        if (!notice) return null
        return (
          <div data-testid="breeding-notice" data-breeding={variety?.breeding_system} style={breedingNoticeStyle}>
            {notice.badge && (
              <Badge tone={notice.tone} style={{ marginRight: 8, verticalAlign: 'middle' }}>
                {notice.badge}
              </Badge>
            )}
            <span>{notice.line}</span>
          </div>
        )
      })()}

      <button
        type="button" onClick={save} disabled={!canSave}
        data-testid="save-seed-submit" style={primaryBtnStyle(!canSave)}
      >
        {busy ? 'Saving…' : 'Save seed'}
      </button>
    </Sheet>
  )
}

const fieldLabelStyle = {
  display: 'block', marginBottom: 14, fontSize: '0.82rem', fontWeight: 600, color: P.mid,
}
const inputStyle = {
  display: 'block', width: '100%', minHeight: 48, marginTop: 6, padding: '0 12px',
  borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '1rem', backgroundColor: P.white,
}
const varietyRowStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  minHeight: 48, marginTop: 6, padding: '0 12px',
  borderRadius: 8, border: `1px solid ${P.border}`, backgroundColor: P.white, fontSize: '1rem',
}
const linkBtnStyle = {
  background: 'none', border: 'none', padding: '4px 2px', cursor: 'pointer',
  fontSize: '0.82rem', fontWeight: 600, color: P.green, textDecoration: 'underline',
}
const processRowStyle = (selected) => ({
  display: 'block', width: '100%', textAlign: 'left', minHeight: 64, padding: 12,
  marginBottom: 10, borderRadius: 8, cursor: 'pointer',
  border: `1px solid ${selected ? P.green : P.border}`,
  backgroundColor: selected ? P.greenPale : P.white, color: P.dark,
})
const hintStyle = { margin: '6px 0 0', color: P.mid, fontSize: '0.78rem', lineHeight: 1.5 }
// V5-VARIETYHYBRIDFLAG-001. No border or fill of its own: the F1 arm carries a warn Badge that is
// already the colour signal, and boxing the other three arms would give an ordinary factual line the
// visual weight of an alert. Bottom margin only, so the block sits against Save.
const breedingNoticeStyle = {
  margin: '0 0 12px', color: P.mid, fontSize: '0.82rem', lineHeight: 1.5,
}
const errorStyle = {
  margin: '0 0 12px', padding: '8px 10px', borderRadius: 8,
  border: `1px solid ${P.alertBorder}`, backgroundColor: P.alert,
  color: P.dark, fontSize: '0.82rem',
}
const primaryBtnStyle = (disabled) => ({
  width: '100%', minHeight: 48, borderRadius: 10, border: 'none',
  backgroundColor: P.green, color: P.white, fontWeight: 700, fontSize: '0.95rem',
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
})
