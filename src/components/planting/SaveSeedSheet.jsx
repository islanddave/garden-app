// "Save seed" from a planting: the CREATE half of the seed-lot flow. /seeds/saved only attaches a stage to an
// inventory row that already exists, so this is the one place a lot is created off a plant.
//
// The parent is a PARAMETER where the caller knows it: source_plant_id and variety_id come off the planting record
// the page already loaded, so the sheet asks for a name, not for identity. `planting` is optional: a caller that
// could not answer (the Seeds door) gets a PlantingSelect or the no-planting arm.
//
// QUANTITY. quantity_on_hand means CONTAINERS everywhere: this create writes 1 (one jar came off this plant). The
// measurements (seeds counted, grams weighed, or neither) go to inventory_items.seed_count / seed_weight_g through
// PUT /seed-measure, its own narrow route, which reads keys by presence, so a blank field sends nothing. Writing the
// count into quantity_on_hand once produced rows reading "185.000 packet": one column carrying two facts, and the wide
// PUT overwriting whichever it last saw. The measure columns (seed_count, seed_weight_g, seed_count_estimated) are
// reachable ONLY through that route and are deliberately absent from the wide PUT's SET list, for
// BUG-INVLOSTUPDATE-001's reason (useInventory's adjustQuantity resends a whole stale list row). Neither field is
// required and nothing is defaulted: a count defaulting to 1 would be a guess dressed as data.
//
// WRITE SHAPE (POST /api/inventory-items). Every key is load-bearing; see validateCreate and the INSERT column list
// in lambda/inventory-items/index.js:
//   type 'consumable' + unit 'packet' + quantity_on_hand: validateCreate requires all three together.
//   category 'seeds': the discriminator the CHECK and the /source-plant route key off.
//   variety_id: MANDATORY, never null. chk_inventory_seed_requires_variety is `category <> 'seeds' OR variety_id IS
//     NOT NULL`, and validateCreate 400s first. Defaulted from the planting, overridable.
//   source_plant_id: the point of the feature. It is persisted and household-authorized (BUG-SEEDPOSTDROPSPARENT-001:
//     it was once named in neither the INSERT column list nor its VALUES, so a 201 came back with it dropped).
//
// THE STAGE IS A SECOND REQUEST, not a field on the create. The INSERT does not name seed_stage and the create
// ignores the key (BUG-SEEDSTAGEHEADSHIP-001): written there, the column is set WITHOUT a seed_lot_stage_log row, and
// /seeds/saved derives its queue from stage_entered_at. POST /seed-stage is the stage's only writer and writes the
// column and the log row in one statement. It carries its own failure: the lot exists either way, and reporting a
// landed create as failed because an optional stage did not land is the worse error.
//
// A THIRD REQUEST is the act itself, a `seed_saved` event on the planting's timeline (the lot alone is invisible from
// the plant it came off). It goes through the app's own path, POST /api/events via useApiFetch().fetch, like
// src/pages/EventNew.jsx and the one-tap loggers QuickActions.handleWater/handleSprout: that Lambda's POST arm does
// the household ownership gate on plant_id, derives the event's project from the PLANTING rather than the body
// (deriveEventProjectId), stamps `source`, and upserts entity_memory in the same transaction. What is sent:
//   plant_id: the only anchor needed (validatePostBody wants project_id OR plant_id; seed_saved is in
//     PLANTING_REQUIRED_TYPES).
//   project_id: NOT sent. With a plant_id, deriveEventProjectId ignores the body's value, so sending one buys a
//     second ownership round trip and a new 400 branch for nothing.
//   event_date: todayLocalISO(), for BUG-GERMDATEBATCH-001's reason: omitted, it falls through to the Lambda's UTC
//     `new Date()`, so an evening save files on tomorrow.
//   notes: see seedSavedNote.
//   quantity/unit: NOT sent. event_log.quantity is nullable free text and event_log has no unit column; a count here
//     would be the same fabrication the create refuses at quantity_on_hand.
//   metadata: `{ seed_lot_id }`, guarded on `lot?.id` because JSON.stringify({ seed_lot_id: undefined }) is `{}`,
//     which passes isPlainMetadataObject and would persist an empty jsonb object instead of NULL. It is the only
//     durable event->lot link; `seed_lot_id` is in METADATA_HIDDEN_KEYS (src/pages/EventDetail.jsx), so the raw uuid
//     is never rendered as a detail row.
// IT CANNOT FAIL THE SAVE. The user asked for a lot, not a timeline row, and never chose this write, so its failure
// is swallowed and the flow finishes as it would have (lot created, toast shown, routed on).
//
// SEED_MULTI_PARENT: ONE JAR, SEVERAL PLANTINGS. The sheet keeps a SET of plantings (the "From" block), and what used
// to be seeded once at mount is DERIVED from that set on every change: the variety, the default lot name, the
// adder's crop and the legacy source_plant_id. Seeding once was already wrong at the Seeds door (picking a plant
// changed neither name nor variety) and is wrong everywhere once a row can be removed. The writes, each awaited
// before the next:
//   0. POST /api/varieties/blend { create: true }, ONLY when the plantings span two or more varieties. The mix is
//      made at Save, for the set actually being saved, never while picking: the variety list is global, so a mix made
//      on the way to another one would sit in every picker. Until then the Variety row shows previewMixName.
//   1. POST /api/inventory-items with source_plant_ids, source_plant_id (the first row) and the filed variety. A 409
//      parents_changed is sent once more, silently.
//   2. PUT /seed-measure, also carrying seed_parent_plant_count (and sent for that key alone).
//   3. POST /seed-stage.
//   4. One seed_saved event PER PARENT through the same single POST, one after another, never retried: a reply lost
//      on the way back would otherwise leave two entries on one plant.
// Anything that fails before the lot exists is answered in the client's own words (see saveRefusalSentence) with
// every field left as typed. FLAG OFF is the forward undo: no "From" block, no adder, no plant count, no mix, and
// every request body byte-equal to the one before the flag.
//
// SEED_ADD_TO_LOT ("put it in a seed lot I already started", and only while SEED_MULTI_PARENT is on too;
// seedAdditions.addToLotAvailable is the one reader): the From block carries one more row, a link, while the sheet
// holds its own planting and nothing else. It opens the lot list or, when the plant has exactly one lot that can
// still take seed, the add form on that lot; both are AddToLot.jsx, drawn in this sheet in the form's place. FLAG
// OFF: no link, list or form, and no request to either new route.
//
// THE CREATE CARRIES A KEY, ONE PER DRAFT (BUG-NEWLOTNOIDEMPOTENCYKEY-001): `idempotency_key`. seedLotKey.js says
// which saves share one and when a key is let go. Without it, a create whose answer was lost and was saved again, or
// a draft closed mid-save and saved again before the first landed, is two lots. The route keeps the key behind
// uq_inventory_items_idempotency_key and answers a second request with the first one's lot (`replayed: true`), so
// both saves hold that lot and it is finished once (requests 2 to 4 and the toast, by the save that heard of it
// first); the other save writes nothing and, if its sheet is open, ends where the first one led.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
// Field and SourcePicker are InventoryAdd's own two imports for this block; reusing both keeps the two intake doors
// onto `inventory_items` saying one thing.
import { Sheet, PlantingSelect, Badge, Field, SourcePicker } from '../forms'
// T.tapMinHeight in basisRowStyle: read from the token so the control cannot fall under a floor the layout gate raises.
import { T } from '../forms/formStyles.js'
import VarietyPicker from '../VarietyPicker.jsx'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import { todayLocalISO } from '../../lib/dateLocal.js'
import { P } from '../../lib/constants.js'
import { PUTUP_SOURCE_OPTIONS } from '../../lib/dropdownRegistry.js'
import { readMarker } from '../../lib/backNav.js'
import { seedsHref } from '../../lib/seedsRoutes.js'
import { SEED_MULTI_PARENT } from '../../lib/featureFlags.js'
import { sourcePlantFromPlanting, parentSetFacts, lotNotice, previewMixName } from '../seed/seedParents.js'
import { addToLotAvailable, isOpenLot, lotFactsLine, UNSURE_CLOSE } from '../seed/seedAdditions.js'
import { sheetOpened, keyForDraft } from '../seed/seedLotKey.js'
import AddToLot from './AddToLot.jsx'


// MIRRORS src/pages/SavedSeeds.jsx's PROCESS_ENTRY, deliberately rather than importing it (a component should not
// reach into a page for a constant). Both copies are the live vocabulary of the two DB CHECKs:
// inventory_items_seed_process_check is `wet | dry | fresh` and inventory_items_seed_stage_check is
// `fermenting | drying | stored`. Beans, peas, lettuce and brassicas are threshed from a pod that dried on the plant,
// and peppers and squash come from a fresh fruit; neither ferments, and a hard-coded `fermenting` entry would write a
// permanent false row into seed_lot_stage_log (BUG-SEEDPROCFORCED-001). Keep the two copies in step.
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
 * The lot's opening name. Pure, exported for test.
 * Variety first because that is what the seed IS; the planting's own name is the fallback for a planting with no
 * cultivar attached. The year is the LOCAL year (a December save in Eastern would file under next year off a UTC
 * clock). Always editable: a starting point, not a naming scheme.
 */
export function defaultLotName(planting, today = todayLocalISO()) {
  const base = planting?.variety_ref?.name || planting?.name || ''
  const year = String(today).slice(0, 4)
  return base ? `${base} — saved ${year}` : `Saved seed ${year}`
}

/**
 * The seed_saved note. Pure, exported for test.
 *
 * The Event log row already renders the type and the date, so the note says what the row cannot know: WHICH lot came
 * off this plant, and why it carries no number. Every clause is checkable at the moment it is written:
 *   - the lot NAME is what the create was called with.
 *   - `stage` is passed ONLY after POST /seed-stage has resolved, never from the user's radio choice: a note
 *     claiming "fermenting" for a stage write that 500'd is a permanent false sentence on the timeline. With no
 *     process chosen, or a failed stage write, the clause is absent, never "unknown".
 *   - "No count yet" is the sentence the sheet puts on screen at save-seed-count-note, so the timeline does not
 *     contradict the form.
 */
export function seedSavedNote(lotName, stage = null) {
  return `Seed lot "${String(lotName).trim()}"${stage ? `, ${stage}` : ''}.`
    + " No count yet — recorded when it's marked stored."
}

/**
 * The opening count. Pure, exported for test.
 * Blank -> 0, the "nobody has counted this yet" placeholder; a typed number is taken as given. Rejects negatives and
 * non-numbers rather than coercing: Number('') is 0 and Number('abc') is NaN, so a bare Number() would turn a typo
 * into a silent zero.
 *
 * The field is blank-by-default and optional: nothing is fabricated or defaulted to a number no one typed, and a
 * packet count known from the first moment (or not known until the end) can be set at any step. The stage sheets on
 * /seeds/saved carry the same field (src/pages/SavedSeeds.jsx COUNT_ASK).
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
 * The opening WEIGHT. Pure, exported for test. Returns { value: grams|null, error }. A packet states a count or a
 * weight, rarely both, so neither is required.
 *
 * GRAMS IS THE STORED UNIT and a BARE NUMBER IS GRAMS. Reading a bare number as milligrams would be a silent 1000x
 * error on every packet, with nothing downstream able to notice, so the suffix changes the unit, never the
 * magnitude, and the field hint says so on screen.
 *
 * DECIMALS ARE LEGAL HERE, unlike the count: 0.5 g is an ordinary packet and seed_weight_g is numeric(10,3), where
 * the count is an integer column. The value is rounded to 3dp HERE rather than left for Postgres to round, so what we
 * send is exactly what is stored.
 *
 * A POSITIVE WEIGHT THAT ROUNDS TO ZERO IS REFUSED, not stored. 0 on this column means "weighed it, there is nothing
 * there"; writing it for 0.0004 g would change the sentence rather than its precision.
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
 * What PUT /seed-measure should carry, or null for "do not call it at all". Pure, exported for test.
 *
 * BLANK IS NOT ZERO ON THIS ROUTE, which is why this is a second function rather than a use of parseOpeningCount
 * (that maps a blank field to 0). seed_count is nullable and NULL is exactly "nobody has counted"; passing the blank
 * field's 0 through would write a MEASURED ZERO ("I counted, there are none") onto a lot whose owner typed nothing.
 * So a blank field sends no request, and the column stays NULL.
 *
 * seed_count_estimated is the caller's answer (see SeedCountBasis); the default is `false`. It rides with the COUNT
 * and only the count: it is a statement about that number's provenance, and sending it beside a weight alone would
 * claim something about a count never given. That is also the PAIRING rule the database enforces
 * (chk_inventory_seed_count_basis_pairing: `(seed_count IS NULL) = (seed_count_estimated IS NULL)`), and the route
 * refuses a half-pair with a 400. Both keys are written inside the one branch so no edit can add one without the
 * other.
 *
 * KEY-BY-KEY, because the route reads BY PRESENCE: each field independently contributes its key or does not exist in
 * the body. Both blank returns null.
 *
 * The optional fourth argument is the plant count (see parsePlantCount), a key of its own on the same route, so a
 * plant count beside a blank seed count and a blank weight still returns a payload.
 */
export function seedMeasurePayload(rawCount, rawWeight = '', estimated = false, rawPlantCount = '') {
  const payload = {}
  if (String(rawCount ?? '').trim() !== '') {
    const { value, error } = parseOpeningCount(rawCount)
    if (!error) {
      payload.seed_count = value
      payload.seed_count_estimated = !!estimated
    }
  }
  const weighed = parseSeedWeight(rawWeight)
  if (!weighed.error && weighed.value != null) payload.seed_weight_g = weighed.value
  const plants = parsePlantCount(rawPlantCount)
  if (!plants.error && plants.value != null) payload.seed_parent_plant_count = plants.value
  return Object.keys(payload).length ? payload : null
}

/**
 * How many separate PLANTS the seed was gathered from. Pure, exported for test.
 * Returns { value: whole number 1-9999 | null, error }.
 *
 * Blank is null ("can't say") and writes nothing. It is a different number from the rows in the "From" block: two
 * plantings can hold 2 and 7 plants. inventory_items.seed_parent_plant_count takes a whole number from 1 to 9999 and
 * the route refuses anything else with a sentence that has no code, so a 0, a decimal and a five-figure number are
 * answered here.
 */
export const PLANT_COUNT_MAX = 9999
export function parsePlantCount(raw) {
  const typed = String(raw ?? '').trim()
  if (typed === '') return { value: null, error: null }
  const n = Number(typed)
  if (!Number.isInteger(n) || n < 1) return { value: null, error: 'A plant count is a whole number, 1 or more.' }
  if (n > PLANT_COUNT_MAX) return { value: null, error: `A plant count can be ${PLANT_COUNT_MAX} at most.` }
  return { value: n, error: null }
}

/**
 * WHERE THE NUMBER CAME FROM, and the control that lets someone say. seedCountLabel renders `approx. 200 seeds` off
 * inventory_items.seed_count_estimated; both writers once hardcoded `false`, so that arm was unreachable from inside
 * the app.
 *
 * ONE COMPONENT, TWO SURFACES: both writers of these columns render THIS, the sheet below and the advance sheet on
 * src/pages/SavedSeeds.jsx (which already imports this module, so sharing adds no import direction and cannot go
 * circular). seedCountLabel is shared on the READ side for the same reason: two hand-spelled labels drift.
 *
 * OFF BY DEFAULT, a data decision: `false` is what every existing row holds and what both writers have always sent,
 * so defaulting to "estimated" would silently re-interpret counts already recorded. It is an opt-in statement;
 * nothing asks the question and nothing blocks on it.
 *
 * A BUTTON RATHER THAN <input type="checkbox">: scripts/layout-gate/seeds-saved-clearance.mjs censuses every visible
 * `button, input, select, textarea` in the advance sheet against T.tapMinHeight, and a 14px checkbox would fail that
 * floor. role="switch" rather than the aria-pressed the process rows use: those are a one-of-N choice wearing a
 * toggle, this is a genuine binary setting, and the distinct role keeps a test's getByRole('switch') from matching
 * them.
 */
export const SEED_BASIS_LABEL = 'Approximate — not hand-counted'

export function SeedCountBasis({ estimated, onChange, testId }) {
  return (
    <button
      type="button" role="switch" aria-checked={!!estimated} data-testid={testId}
      onClick={() => onChange(!estimated)} style={basisRowStyle(!!estimated)}
    >
      <span aria-hidden="true" style={basisMarkStyle(!!estimated)}>{estimated ? '✓' : ''}</span>
      {SEED_BASIS_LABEL}
    </button>
  )
}

/**
 * The reader half of the hybrid flag. ONE surface, ONE firing arm. Returns null for "say nothing at all", or
 * { tone, badge, line }; `tone: null` means a plain line with no badge.
 *
 * THE EMPTY STATE IS THE IMPORTANT ONE. Most live cultivars have never been assessed, and those return null: no
 * badge, no line, no reserved space. A warning that appears on every save is trained away; this one fires rarely.
 *
 * OPEN-POLLINATED MUST NOT BE SILENT. If only the F1 arm ever spoke, silence would mean both "we checked and it is
 * fine" and "nobody ever looked", and the warning's absence would carry no information. The positive line is what
 * makes silence honestly mean "unknown".
 *
 * THE COPY DOES NOT CALL SAVING F1 SEED A MISTAKE. Deliberate F2 growing-out is how dehybridizing starts; the
 * sentence names the consequence and the alternative and gets out of the way.
 *
 * The cases are the values of chk_plant_varieties_breeding_system (f1 | open_pollinated | landrace | unknown) plus
 * NULL; there is no `f2_or_later` value. `landrace` gets its own line rather than being folded into open_pollinated,
 * which would assert uniformity a landrace does not have. breedingNoticeCoverage.test.jsx reads the CHECK's value list
 * out of the migration and fails if any allowed value has no arm here.
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
      // would overclaim exactly the thing lot provenance exists to track separately.
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

// The ONE cultivar a set of plantings shares, or null. Read only when the set is not a mix. A planting whose variety
// was soft-deleted arrives with variety_id set and variety_ref null (both plant reads join on `deleted_at IS NULL`);
// it counts as having no variety, so the sheet asks for one instead of filing a jar under a variety that shows
// nowhere. Unlike plantingVariety above, which keeps the bare id and is what the flag-off sheet seeds from.
function sharedCultivar(rows) {
  return rows.find((r) => r?.variety_ref?.id)?.variety_ref ?? null
}

// lambda/inventory-items refuses a thirteenth parent with a sentence that has no code. The adder
// stops offering at the cap rather than let a save end in a refusal no tap can clear.
const MAX_SEED_PARENTS = 12

// "sweet_pepper" -> "sweet pepper", for the adder's label and its empty text.
const cropWords = (slug) => String(slug ?? '').replace(/[-_]+/g, ' ').trim().toLowerCase()

const listWords = (words) => (words.length <= 1 ? words.join('')
  : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`)

// What the sheet says when a save did not happen. The server's string is never printed for these: one of its
// sentences ("Reload and try again") names a step that would throw away everything typed here.
const SAVE_FAILED = "Couldn't save just now. Nothing was saved. Your entries are still here. Tap Save seed to try again."
const SAVE_OFFLINE = "You're offline. Nothing was saved. Your entries stay here until you're back in range."
const SAVE_NEEDS_UPDATE = 'This lot needs the latest version of the app. Nothing was saved.'
// The lot POST that never answered (a timeout, or a connection that dropped with the request already out). The jar
// may have landed with only its reply lost, so "nothing was saved" would be a guess that invites a second jar. The
// mix call in front of it is idempotent and writes no jar, so it keeps the plain sentence.
const SAVE_UNCONFIRMED = "That didn't finish, so the lot may or may not have saved. Look in Seeds before you tap Save seed again."
// The throw AFTER the lot landed. Reached only by a host callback that throws, where "nothing was saved" would be
// false.
const SAVED_BUT_UNFINISHED = 'The seed lot was saved, but something went wrong after that. Look for it in Seeds before you save again.'
const PLANTING_FALLBACK = 'One of these plantings'

// api.js rethrows the browser's own error when there is no connection: a TypeError with no `status`.
// A timeout carries status 0 and is not this.
const isOffline = (err) => err?.status == null && !err?.timeout
  && ((typeof navigator !== 'undefined' && navigator.onLine === false) || err instanceof TypeError)

/**
 * The sentence for a save that stopped before the lot existed. `plants` is the set as the client holds it
 * (sourcePlantFromPlanting rows), because the two coded refusals are about ONE row and that row is off screen by the
 * time Save is tapped.
 *   parent_without_variety carries plant_id.
 *   mixed_crop_parents (and the mix route's mixed_crop_components) carry nothing, so the row is found here: the first
 *     whose crop differs from the first row's.
 * Both are unreachable while the adder is crop-filtered; they cover a planting that changed after the picker listed
 * it. A code with no row to name falls through to the general sentence rather than naming the wrong plant.
 */
function saveRefusalSentence(err, { atMix = false, plants = [] } = {}) {
  if (atMix && err?.status === 405) return SAVE_NEEDS_UPDATE
  const code = err?.status === 400 ? err?.body?.code : null
  if (code === 'parent_without_variety') {
    const row = plants.find((p) => String(p.id) === String(err.body?.plant_id))
    if (row) return `${row.name || PLANTING_FALLBACK} has no variety recorded, so it can't share a lot. Remove it, or save it as its own lot.`
  }
  if (code === 'mixed_crop_parents' || code === 'mixed_crop_components') {
    const first = plants[0]?.crop_slug ?? null
    const row = plants.find((p) => (p.crop_slug ?? null) !== first)
    if (row) return `${row.name || PLANTING_FALLBACK} is a different crop, so it can't share this lot. Remove it and save again.`
  }
  const online = typeof navigator === 'undefined' || navigator.onLine !== false
  if (!atMix && (err?.timeout || (err?.status == null && err instanceof TypeError && online))) return SAVE_UNCONFIRMED
  return isOffline(err) ? SAVE_OFFLINE : SAVE_FAILED
}

// "These 2 plantings hold 9 plants today." Said only when the plantings hold more plants than there are plantings
// (otherwise the rows already say it). Every planting has to state a whole quantity: a sum over the ones that do
// would simply be wrong. Words under the field, never a value in it, and never a cap on what can be typed.
function plantsHeldHint(rows) {
  const held = rows.map((r) => Number(r?.quantity))
  if (!held.every((q) => Number.isInteger(q) && q >= 1)) return null
  const total = held.reduce((a, b) => a + b, 0)
  if (total <= rows.length) return null
  return rows.length === 1
    ? `This planting holds ${total} plants today.`
    : `These ${rows.length} plantings hold ${total} plants today.`
}

// The eight source kinds, straight from the shipped registry rather than a fourth hand-typed copy. The vocabulary is
// synchronised across four homes (this registry, lambda/preservation/provenance.js,
// lambda/inventory-items/source-kinds.js and the DB CHECK chk_inventory_source_kind) and pinned by
// preservationProvenance.test.js.
const NON_GARDEN_KINDS = PUTUP_SOURCE_OPTIONS.filter((o) => (o.value ?? o) !== 'own_garden')

/**
 * `planting` is OPTIONAL.
 *
 * WHEN IT IS PASSED (the planting page, the event menu) the parent is a parameter: the variety is seeded from the
 * record the page already loaded and the happy path is zero reads. With SEED_MULTI_PARENT it is the FIRST ROW of a
 * parent set, fixed in place, and the variety, name and adder crop are derived from the set on every change.
 *
 * WHEN IT IS ABSENT the sheet asks the one question the caller could not answer, where the seed came from, and offers
 * both answers: one of my plants (a PlantingSelect) or somewhere else. The no-planting arm writes `source_kind` and
 * no `source_plant_id`, the shape chk_inventory_source_provenance expects (`source_kind IS NULL OR source_kind =
 * 'own_garden' OR source_plant_id IS NULL`). It writes NO timeline event either: there is no plant to hang one on,
 * and a placeholder planting would put plants in the garden that were never planted.
 *
 * That arm also writes WHICH source, with the same two refs /inventory/add writes: source_id (origin) and
 * acquired_from_source_id (venue). Origin is the primary field, because the schema (migrations/v5-sourceentity-001
 * README §3) sets acquired_from only when the shop differs from the originator, and for the large majority of rows
 * only source_id is ever set. Filing a farm stand as acquired_from alone would record venue-known/origin-unknown,
 * the minority shape, which /inventory/:id would render with an empty Origin.
 */
// `onSaved(lot, { stageWritten })`, optional. A host that passes it takes over the ending: the sheet closes and
// navigates NOWHERE, and the host confirms the save in place. The Seeds page is that host: a push from inside it would
// remount the page it is already on, refetch the whole seed list, drop the filters and stack a duplicate history
// entry. Without it the sheet keeps its navigating ending for the planting page and the event menu.
//
// A save that lands AFTER the sheet was closed (the labelled Close is live while "Saving…" stands) says "Seed lot
// saved" and nothing else of the sheet's: no second close, no navigation. The host is still told:
// `onSaved(lot, { stageWritten, closed: true })` where it takes the ending over (it must then stay where it is), and
// `onSavedAfterClose(lot, { stageWritten })`, optional, where it does not.
//
// `ownLots`, `onSeedAdded(reply, { replace, closed })` and `onSeedMaybeAdded()`, all optional (SEED_ADD_TO_LOT).
// `ownLots` is the planting's own seed lots as its page read them (GET /api/plants/:id/seed-lots); a host that has
// none passes nothing and gets the general link. `onSeedAdded` is called after seed went into an existing lot, before
// the sheet closes (`closed` is true when it had been closed already, and a host that leaves the page must then
// stay): the host refreshes what it shows, or goes to the planting. `replace` is true while this sheet's Back marker
// is the current history entry (see the navigate note at the end of save()). `onSeedMaybeAdded` is called when the
// sheet is closed while an add has no definite answer (the seed may or may not be in the lot), before it closes: a
// host that draws the plant's lots reads them again.
export default function SaveSeedSheet({ planting, onClose, onSaved, onSavedAfterClose, ownLots, onSeedAdded, onSeedMaybeAdded }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const navigate = useNavigate()
  // False once the sheet is gone (AddToLot's ref, for the same reason). Set on mount as well as cleared on unmount, so
  // a development build's second mount does not leave it false for a sheet that is open.
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])
  // This sheet's place among the openings and late endings seedLotKey.js keeps count of: a save that
  // finished after its sheet was closed shares its key with a sheet opened before that, not after.
  const [openedAt] = useState(sheetOpened)

  // The plantings this save is FOR: the prop when the caller knew it, then whatever the user picks below, in pick
  // order. `rows` is the whole parent set and every downstream read goes through it, never through `planting`
  // directly. `parent` is its first row: the legacy source_plant_id, and the only row there is while SEED_MULTI_PARENT
  // is off (the picker then replaces its one pick, and nothing can add a second).
  //
  // The prop is NOT copied into state. From a planting page or the log menu the first row is that page's planting and
  // stays fixed; at a planting-less door every row is one the user chose here, so every row can be taken back.
  const multi = SEED_MULTI_PARENT
  const [picked, setPicked] = useState([])
  const rows = useMemo(() => (planting ? [planting, ...picked] : picked), [planting, picked])
  const parent = rows[0] ?? null
  // The same rows in the contract's shape, and what they add up to: how many varieties, which crop.
  const sourcePlants = useMemo(() => rows.map(sourcePlantFromPlanting), [rows])
  const facts = useMemo(() => parentSetFacts(sourcePlants), [sourcePlants])
  // A mix needs two varieties the mix route can be given. A row with no variety is not one of them.
  const isMix = multi && facts.varietyIds.length >= 2
  // null until answered, and only asked when the caller did not already know. 'plant' | 'other'.
  const [origin, setOrigin] = useState(planting ? 'plant' : null)
  const [sourceKind, setSourceKind] = useState('')
  // WHICH one, beside the kind's WHAT KIND OF PLACE. `inventory_items.source_kind` is the eight-value CHECK above
  // (farm_stand, csa, store...); these are FKs into `public.source`, the registry where "Bardwell's" and "Long River
  // Produce Market" are separate rows. `source.kind`, the row's OWN kind, is a third, extensible vocabulary and is not
  // this column.
  const [sourceId, setSourceId] = useState('')
  const [acquiredFromId, setAcquiredFromId] = useState('')


  // DERIVE, DO NOT SEED. The two things the user can override are kept apart from the two things the set decides, so a
  // later change to the set never has to guess whether a value on screen was typed or defaulted:
  //   typedName + nameTouched: the lot name follows the set until the field is typed in, then it is the user's.
  //   handVariety: a variety chosen through the picker. It is kept while the plantings are a mix (when the mix is
  //     shown instead) and comes back when the set is one variety again, so removing a mis-tapped plant does not
  //     silently undo a deliberate choice.
  // Flag off, both hold exactly what `name` and `variety` held: seeded once from the prop at mount.
  const seeded = plantingVariety(planting)
  const [typedName, setTypedName] = useState(() => defaultLotName(planting))
  const [nameTouched, setNameTouched] = useState(false)
  const [handVariety, setHandVariety] = useState(multi ? null : seeded)
  const variety = !multi ? handVariety : isMix ? null : (handVariety ?? sharedCultivar(rows))
  // The client's reading of the mix's name, shown at once and with no request. The server names a
  // mix from its leaves, so where a parent's variety is itself a mix the name it returns at Save can
  // differ; that one replaces this wherever the lot name is still untouched.
  const mixName = isMix ? previewMixName(facts.varieties) : ''
  const name = multi && !nameTouched
    ? defaultLotName(isMix ? { variety_ref: { name: mixName } } : parent)
    : typedName
  // Open by default ONLY when there is nothing to show. The picker's hook fetches /api/varieties on mount, so keeping
  // it collapsed on the common path (the planting knows its cultivar) keeps the happy path at zero reads. "Nothing to
  // show" is read on every render, so picking a plant at the Seeds door closes the picker it made unnecessary;
  // `pickerOpen` records only that the user asked for it. Never shown for a mix: a variety offered there would be
  // refused at Save.
  const [pickerOpen, setPickerOpen] = useState(multi ? false : !seeded)
  const pickerShown = multi ? (!isMix && (pickerOpen || !variety)) : pickerOpen
  // The adder. Its crop is the set's shared crop, so every planting it lists can share the jar. With no crop to filter
  // by it would list every planting in the garden and the server would refuse nearly all of them, so it is not
  // offered. That ONE test covers each case that has no crop: a first plant with no variety, one whose variety was
  // deleted (the crop is read off the joined variety, and there is none), and a variety that names no crop.
  const [adderOpen, setAdderOpen] = useState(false)
  // A pick closes the picker, and its field unmounts while focused (the picker sits inside a <label>, so the click
  // focuses the label's field). Focus then falls to <body>, and the sheet's Tab trap only wraps at its first and last
  // control, so the next Tab could land on the page behind the sheet. So a pick asks for focus to go to the adder, the
  // control that opened the picker and is still here, and the effect does it once the picker is gone: any sooner and
  // the click's own focus on the field comes after it and wins.
  const adderButtonRef = useRef(null)
  const focusAdderRef = useRef(false)
  useEffect(() => {
    if (adderOpen || !focusAdderRef.current) return
    focusAdderRef.current = false
    adderButtonRef.current?.focus()
  }, [adderOpen])
  const adderCrop = typeof facts.cropSlug === 'string' && facts.cropSlug ? facts.cropSlug : null
  const canAdd = multi && !!adderCrop && rows.length < MAX_SEED_PARENTS
  // A STABLE array: PlantingSelect reads it as a memo dep.
  const excludeIds = useMemo(() => rows.map((r) => String(r.id)), [rows])
  // Asked only when the rows do not already answer it: two or more plantings, or one planting that holds some number
  // of plants other than exactly 1. Never prefilled; the hint is words, not a value.
  const [plantCount, setPlantCount] = useState('')
  const showPlantCount = multi && rows.length > 0 && (rows.length >= 2 || Number(parent?.quantity) !== 1)
  const plantHint = showPlantCount ? plantsHeldHint(rows) : null
  const [seedProcess, setSeedProcess] = useState(null)
  // Blank means "haven't counted"; see parseOpeningCount.
  const [count, setCount] = useState('')
  // How that count was arrived at. `false` is the historical write and stays the default; see SeedCountBasis. Kept
  // even while the count field is blank, so retyping a number does not silently drop the answer already given.
  const [countEstimated, setCountEstimated] = useState(false)
  // The alternative to the count, not a second thing to fill in. See parseSeedWeight.
  const [weight, setWeight] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // The link's words and target are FIXED WHEN THE SHEET OPENS. The host's list is empty while it loads and after a
  // failed read, and a link that turned from the general words into a lot's name under the thumb would be tapped as the
  // wrong one. So the lots are read once, here: exactly one open lot of this plant's is named, anything else is the
  // general link.
  const addOn = addToLotAvailable()
  const [openOwnLots] = useState(() => (addOn && planting && Array.isArray(ownLots)
    ? ownLots.filter((l) => isOpenLot(l)) : []))
  const namedLot = openOwnLots.length === 1 ? openOwnLots[0] : null
  // 'new' is the form below. 'add' puts AddToLot in its place: the list, or the form on `namedLot`.
  const [mode, setMode] = useState('new')
  const [addState, setAddState] = useState({ dirty: false, busy: false, unsure: false })
  // One row in From, and it is the page's own planting with a variety: the read behind the list is
  // by that planting, and a second plant is a different question (a new lot off both).
  const showPutIn = addOn && !!planting && rows.length === 1 && !!planting.variety_ref?.id
  // Coming back from the list ("Start a new seed lot instead") the list's controls are gone, so
  // focus returns to the link that opened it rather than falling to <body>, outside the Tab trap.
  const putInRef = useRef(null)
  const wasAddingRef = useRef(false)
  useEffect(() => {
    if (mode === 'add') { wasAddingRef.current = true; return }
    if (!wasAddingRef.current) return
    wasAddingRef.current = false
    putInRef.current?.focus()
  }, [mode])

  const varietyId = variety?.id ?? null
  // The missing VARIETY is deliberately NOT in here. A disabled Save plus an in-writer guard would be two mechanisms
  // enforcing one rule, and a redundant mechanism cannot be tested: neutralise either half and the other keeps the
  // suite green. One mechanism, and it is the one that can SPEAK: an inline sentence naming the missing field, not a
  // dead grey button. The name stays here because a blank field is visible to the user; the variety is the one that
  // maps to a DB CHECK.
  const canSave = !!name.trim() && !busy
  // `busy` is React state, so a second call in the same frame reads the old closure and goes through. This ref is set
  // before the first await and cleared in the finally: one save of THIS sheet at a time. A save from another sheet of
  // the same draft is a different question, and seedLotKey.js answers it.
  const saveInFlight = useRef(false)

  async function save() {
    if (busy || saveInFlight.current) return
    // chk_inventory_seed_requires_variety refuses `category='seeds' AND variety_id IS NULL`, and validateCreate 400s on
    // it first, so nothing leaves the client: the user gets the answer here instead of after a round trip. A mix has no
    // id yet and is not this case: its variety is made by the first request below.
    if (!isMix && !varietyId) {
      setError('Pick the variety this seed came from — a seed lot has to name one.')
      return
    }
    if (!name.trim()) return
    // Same shape as the variety guard: a negative or unparseable count is something the client can see.
    const opening = parseOpeningCount(count)
    if (opening.error) {
      setError(opening.error)
      return
    }
    // WHOLE SEEDS: seed_count is an INTEGER column and PUT /seed-measure refuses a non-integer outright
    // (lambda/inventory-items/index.js, "seed_count must be a whole number of seeds, or null"). Without this guard the
    // lot is created, the measure 400s, and the number the user typed is dropped with only a toast to show for it.
    if (!Number.isInteger(opening.value)) {
      setError('A seed count is a whole number of seeds.')
      return
    }
    // Same client-first rule: the weight's own errors (a stray letter, a negative, a value finer than the column
    // records) are things the user can see and fix.
    const weighed = parseSeedWeight(weight)
    if (weighed.error) {
      setError(weighed.error)
      return
    }
    // The plant count, on the same client-first rule. Read only while its field is on screen: a number typed for two
    // plantings and then hidden by removing one must not ride along on a save that no longer shows it.
    const plantsTyped = showPlantCount ? plantCount : ''
    const plantsParsed = parsePlantCount(plantsTyped)
    if (plantsParsed.error) {
      setError(plantsParsed.error)
      return
    }
    // Same client-first rule, against the pair the server refuses (sourceRefsCollide -> SOURCE_DISTINCT_ERROR, and the
    // CHECK chk_inventory_source_distinct behind it). NULL on acquired_from means "not recorded, or not distinct" and
    // never "same as the origin", so naming one source twice is a sentence with no meaning. Reachable: both pickers
    // offer the whole registry, so the same row can be chosen in each.
    if (sourceId && sourceId === acquiredFromId) {
      setError('Acquired from is the same as the origin — leave it blank when they match.')
      return
    }
    saveInFlight.current = true
    setBusy(true)
    setError(null)
    // Both are read by the catch: which request stopped the save decides one sentence (a 405 means "the server is older
    // than this app" only when the mix route answered it), and whether the lot already landed decides whether "nothing
    // was saved" is true.
    let lot = null
    let lotLanded = false
    let atMix = false
    // This draft's key (seedLotKey.js). Out here so the `finally` can say the save is over however it ended: a save of
    // the same draft that is waiting on this one must never be left waiting.
    let intent = null
    try {
      // STEP 0, only for a mix: find or make the variety this jar is filed under. The route is idempotent (the same
      // varieties always answer with the same row), so a save that fails further down and is tapped again reuses the
      // mix rather than minting a second.
      let filedVarietyId = varietyId
      let lotName = name.trim()
      if (isMix) {
        atMix = true
        const mix = await fetch('/api/varieties/blend', {
          method: 'POST',
          body: JSON.stringify({ component_variety_ids: facts.varietyIds, create: true }),
        })
        if (!mix?.id) throw new Error('the mix route answered without a variety id')
        filedVarietyId = mix.id
        // The RETURNED name, not the preview: a mix renamed earlier, a name the server had to suffix, or a parent that
        // is itself a mix all answer with something the client could not have built. Only while the field is untouched;
        // a typed name is the user's.
        if (!nameTouched && mix.name) lotName = defaultLotName({ variety_ref: { name: mix.name } })
        atMix = false
      }
      // ONE array feeds both parent keys, so the legacy source_plant_id can never name a planting
      // that is not in source_plant_ids (the route refuses that pair).
      const parentIds = rows.map((r) => r.id)
      const lotRequest = (key) => ({
        method: 'POST',
        body: JSON.stringify({
          name: lotName,
          category: 'seeds',
          type: 'consumable',
          unit: 'packet',
          // ONE CONTAINER, and never the seed count: this column means packets on the shelf everywhere, and the count
          // the user typed goes to PUT /seed-measure below. NEVER NULL, whatever the user typed: the live CHECK
          // consumable_requires_quantity_on_hand (`type <> 'consumable' OR quantity_on_hand IS NOT NULL`) refuses a
          // consumable row without one.
          quantity_on_hand: 1,
          variety_id: filedVarietyId,
          // `parent`, not `planting`: the prop when the caller knew it, the picked planting when the user chose one, and
          // NULL for seed that came from no plant of ours. This and source_kind are mutually exclusive by DB CHECK
          // (chk_inventory_source_provenance), so sending both a parent and a non-garden kind would be a 400. Spread
          // rather than a null, because the route reads source_kind by PRESENCE: an explicit null and an absent key
          // are different.
          source_plant_id: parentIds[0] ?? null,
          // The whole set. Sent for one planting as well as for several, and NOT sent with none: the route reads a
          // present key as "this is the set".
          ...(multi && parentIds.length ? { source_plant_ids: parentIds } : {}),
          ...(!parent && sourceKind ? { source_kind: sourceKind } : {}),
          // The named source, on the SAME `!parent` gate as the kind above: seed off one of our own plants has its
          // provenance in source_plant_id, and a registry row would be asserting a second, different origin for it. The
          // create arm validates both refs (sourceRefsCollide, findDeadSourceRef) and names both in its INSERT.
          //
          // Spread-by-presence like the kind, even though the create arm treats absent and explicit-null identically.
          // The PUT does not, and a key written one way here and read another way there is how the two drift.
          //
          // Only ONE mechanism keeps a stale venue out of this body: the origin picker's onChange clears acquiredFromId
          // when the origin is cleared. Re-deriving that here as `sourceId && acquiredFromId` would be a second copy of
          // the same rule, and a redundant guard cannot be tested.
          ...(!parent && sourceId ? { source_id: sourceId } : {}),
          ...(!parent && acquiredFromId ? { acquired_from_source_id: acquiredFromId } : {}),
          // Last, and absent from the body the key is derived from (lotRequest(null) below).
          ...(key ? { idempotency_key: key } : {}),
        }),
      })
      // The draft is everything this save sends: the body above, the measures and the process. The day on the timeline
      // entries is the clock's and not the user's, so it is not in it. Both sends below (the first, and the one after a
      // parents_changed) carry the one key.
      const measure = seedMeasurePayload(count, weight, countEstimated, plantsTyped)
      intent = keyForDraft([lotRequest(null).body, measure, seedProcess], openedAt)
      const createLot = () => fetch('/api/inventory-items', lotRequest(intent.key))
      // 409 parents_changed: a named planting stopped being usable between the route's check and its write, and nothing
      // was written. The server's sentence says "Reload and try again", which here would throw away everything typed, so
      // the same request goes once more and only a second refusal is reported.
      try {
        lot = await createLot()
      } catch (err) {
        if (!(multi && err?.status === 409 && err?.body?.code === 'parents_changed')) throw err
        lot = await createLot()
      }
      lotLanded = true
      // ANOTHER SAVE OF THIS DRAFT MAY HOLD THIS LOT ALREADY (the answer to a second request under one key is the first
      // one's lot). The save that heard of the lot first finishes it; this one waits for that ending and sends nothing
      // below: no measure, no stage, no timeline entry, no toast (each is guarded on `twin`). Two answers that name two
      // lots are two lots, and each save finishes its own.
      const twin = intent.otherSaveOf(lot?.id)
      const first = twin ? await twin : null
      // The count, as its own request on its own route: a second write the lot's existence does not depend on, so it
      // carries its own failure rather than failing the save; the toast says which follow-up did not land. Skipped
      // entirely on a blank field (see seedMeasurePayload): a blank count is not a zero.
      //
      // The plant count rides this request, and its echo is READ: the route always answers with
      // seed_parent_plant_count, so a 200 without that key came from a Lambda that predates the column, and the seed
      // count and the weight landed but the plant count did not.
      let measureFailed = false
      let plantCountFailed = false
      const has = (k) => !!measure && Object.prototype.hasOwnProperty.call(measure, k)
      if (measure && lot?.id && !twin) {
        try {
          const echo = await fetch(`/api/inventory-items/${lot.id}/seed-measure`, {
            method: 'PUT',
            body: JSON.stringify(measure),
          })
          if (has('seed_parent_plant_count')
            && !(echo && Object.prototype.hasOwnProperty.call(echo, 'seed_parent_plant_count'))) {
            plantCountFailed = true
          }
        } catch {
          measureFailed = true
        }
      }
      let stageFailed = false
      // Set only AFTER the stage POST resolves, which is what makes it safe to put in the event's note: it records the
      // stage that LANDED, not the one asked for. For a save that is not finishing its lot, it is the stage the save
      // that did finish it landed.
      let stageWritten = first?.stageWritten ?? null
      if (seedProcess && lot?.id && !twin) {
        try {
          await fetch(`/api/inventory-items/${lot.id}/seed-stage`, {
            method: 'POST',
            // entered_at omitted on purpose: absent -> now() server-side, and this stage IS being entered now. The column
            // is a timestamptz, so there is no date-only off-by-one to guard against here, unlike the backdated advance
            // on /seeds/saved.
            body: JSON.stringify({ stage: PROCESS_ENTRY[seedProcess].stage, seed_process: seedProcess }),
          })
          stageWritten = PROCESS_ENTRY[seedProcess].stage
        } catch {
          stageFailed = true
        }
      }
      // The timeline trace, on the app's own event path (rationale for the payload and the swallowed failure is in the
      // header note). Reached only after a create that RESOLVED, so it fires once per lot and not at all for a create
      // that threw or a sheet closed without saving.
      //
      // GATED ON A PARENT, a real branch and not a defensive `?.`: plant_id is REQUIRED for this event type
      // (seed_saved is in PLANTING_REQUIRED_TYPES and validatePostBody wants project_id OR plant_id), so a no-planting
      // lot has no plant whose timeline it would appear on. Skipping the POST is the honest outcome; a placeholder
      // planting would put plants in the garden that were never planted.
      //
      // ONE EVENT PER PARENT, so the jar shows on every plant it came off. The same single POST once per row, each
      // awaited before the next: never Promise.all (N writes racing one reward grant) and never retried (a first call
      // that landed with its reply lost would leave two entries on one plant). The note names only the jar, never the
      // other plants: it is permanent, and taking a mis-tapped plant off the jar later would leave a clause about it
      // false on the others' timelines.
      //
      // A write that TIMED OUT ends the loop. The jar is saved already, and on a connection that hangs every further
      // row would hold "Saving…" for another timeout before the toast and the way out. The plants after it get no
      // entry; each one's page lists the jar either way. Any other failure is over at once, so the rest still go.
      for (const row of twin ? [] : rows) {
        try {
          await fetch('/api/events', {
            method: 'POST',
            body: JSON.stringify({
              plant_id: row.id,
              event_type: 'seed_saved',
              event_date: todayLocalISO(),
              notes: seedSavedNote(lotName, stageWritten),
              // Spread, not a bare key: an unguarded `{ seed_lot_id: undefined }` serialises to `{}`, which is a valid
              // plain object to the validator and persists an empty jsonb instead of NULL, a row that looks linked and
              // is not.
              ...(lot?.id ? { metadata: { seed_lot_id: lot.id } } : {}),
            }),
          })
        } catch (err) {
          // Deliberately nothing said. The lot is what the user asked for and it exists; a message about a timeline row
          // they never requested is noise they cannot act on, and re-raising here would report a landed create as a
          // failed save.
          if (err?.timeout) break
        }
      }
      // Built from a list rather than nested ternaries because TWO optional writes can miss independently, and a
      // message naming only one of them would be a false all-clear on the other. Named after what the user actually
      // typed rather than after the route: "couldn't record the count" on a save where they only gave a weight would be
      // about something they never entered. With two counts on the sheet "the count" no longer says which, so each is
      // named: seed count, weight, plant count. A request that threw lost all it carried; a 200 without the plant
      // count's echo lost that one alone.
      const sentMeasures = [
        has('seed_count') && 'seed count',
        has('seed_weight_g') && 'weight',
        has('seed_parent_plant_count') && 'plant count',
      ].filter(Boolean)
      const measureNoun = multi
        ? `record the ${listWords(measureFailed ? sentMeasures : ['plant count'])}`
        : has('seed_count') && has('seed_weight_g') ? 'record the count and weight'
        : has('seed_weight_g') ? 'record the weight'
        : 'record the count'
      const missed = [
        (measureFailed || plantCountFailed) && measureNoun,
        stageFailed && 'start tracking it',
      ].filter(Boolean)
      if (!twin) toast.show(missed.length
        ? { message: `Seed lot saved — couldn't ${missed.join(' or ')}`, tone: 'error' }
        : { message: 'Seed lot saved', tone: 'success' })
      // The save is over and has said so. An open sheet saw it, and that ends the draft's key; a closed one did not
      // (seedLotKey.js, "when a key is let go").
      intent.ended({ stageWritten }, aliveRef.current)
      // The sheet may have been closed while this was out; what is said above is true either way. Whether it is still
      // there is read NOW, not when the user tapped: a closed sheet is not closed again and goes nowhere, and the host
      // is told so it can read again what it shows.
      if (!aliveRef.current) {
        // The save that finished this lot has said it and told the host; a second word would be about nothing new.
        if (twin) return
        if (onSaved) onSaved(lot, { stageWritten, closed: true })
        else if (onSavedAfterClose) onSavedAfterClose(lot, { stageWritten })
        return
      }
      // Read BEFORE onClose(): closing unmounts the sheet, whose disarm pops the Back marker asynchronously, so this is
      // the last moment the stack still shows the sheet's own entry.
      const markerCurrent = typeof window !== 'undefined' && !!window.history && !!readMarker(window.history.state)
      if (onClose) onClose()
      if (onSaved) {
        // stageWritten is only ever set after the stage POST resolved, so it is null on a failure.
        onSaved(lot, { stageWritten })
        return
      }
      // WHERE THE ACTION ENDS (hosts without onSaved) depends on whether the lot joined a QUEUE. A lot that got a process
      // sits in the fermenting or drying queue (Seeds › Saved seeds) with a clock running on it, and that view holds the
      // app's only overdue-ferment warning (past day 5 the seed sprouts in the jar and the lot is finished), so a freshly
      // tracked lot is shown there. An untracked lot has no card in Saved seeds, so it goes to /inventory/:id, where
      // "Saved from" renders. `stageFailed` routes to the lot page too: the toast already says tracking did not start,
      // and a queue the lot is NOT in would contradict it.
      //
      // A PLAIN navigate, not useOverlayNavigate: neither route is registered `overlayable`, so a background in route
      // state would leave the page tree on this planting and render nothing.
      //
      // The navigation REPLACES while this sheet's Back marker is the current entry. A push from an armed sheet strands
      // that marker mid-stack ([planting, planting+marker, dest]): the first Back from the queue landed on the marker,
      // which is the planting page again at the same URL, a Back press that visibly did nothing. Replacing collapses the
      // marker into the destination, so one Back returns to the planting (SheetRowLink's rule). With no marker current
      // (flags off, no provider) it is the plain push.
      const opts = markerCurrent ? { replace: true } : undefined
      const go = (to) => (opts ? navigate(to, opts) : navigate(to))
      if (stageWritten && !stageFailed) go(seedsHref('saved', { lot: lot?.id }))
      else if (lot?.id) go(`/inventory/${lot.id}`)
    } catch (err) {
      // Flag off, the error as it always was. Flag on, the client's own sentence and never the server's: see
      // saveRefusalSentence. The sheet stays open on every field as typed, so the retry is one tap; there is no Reload
      // button, because a reload is the one step that would lose them.
      setError(!multi ? (err?.message || "Couldn't save the seed lot")
        : lotLanded ? SAVED_BUT_UNFINISHED
        : saveRefusalSentence(err, { atMix, plants: sourcePlants }))
    } finally {
      // A no-op after the ending above. Reached first only by a save that stopped short of it.
      intent?.ended(null, false)
      saveInFlight.current = false
      setBusy(false)
    }
  }

  // Taking a row back. Nothing has been written before Save, so there is nothing to undo and no confirmation: the row
  // goes, and the variety, the name and the adder's crop follow the set.
  const removeRow = (id) => {
    setPicked((cur) => cur.filter((r) => String(r.id) !== String(id)))
    setAdderOpen(false)
  }
  const addRow = (row) => {
    if (!row) return
    setPicked((cur) => (rows.some((r) => String(r.id) === String(row.id)) ? cur : [...cur, row]))
    focusAdderRef.current = true
    setAdderOpen(false)
  }

  // Seed went into an existing lot. The host hears first (it refreshes the plant's lots, or leaves for the plant's
  // page), then the sheet closes; the plant's page is where this ends. The marker is read BEFORE onClose for the
  // reason given at the end of save(). `closed`: the add landed after the sheet was closed (AddToLot). The host still
  // hears, so its copy of the plant's lots is read again, and is told, so it does not leave the page; and the sheet,
  // closed once already, is not closed again.
  const seedAdded = (reply, { closed = false } = {}) => {
    const markerCurrent = typeof window !== 'undefined' && !!window.history && !!readMarker(window.history.state)
    if (onSeedAdded) onSeedAdded(reply, { replace: markerCurrent, closed })
    if (!closed && onClose) onClose()
  }

  // The discard question is this sheet's only while a lot is picked (AddToLot reports `dirty`). The three props are
  // constants so the sheet registers once: changing any of them would unregister and re-register it, and re-arm its
  // Back entry, in the middle of a save.
  const discardProps = addOn
    ? { confirmOnDirty: true, confirmTitle: 'Close without adding?', confirmBody: 'What you typed here will not be kept.' }
    : null
  // Once a request has left with no definite answer (AddToLot reports `unsure`), that question would be untrue: the
  // seed may already be in the lot, and "Keep editing" names something the locked form cannot do. So in that state, and
  // only then, it says what is known and what a second add risks. These words ride in `confirmCopy`, which the
  // registry reads when the question is raised: the three constants above do not move, so nothing re-registers.
  const unsureCopy = addState.unsure ? UNSURE_CLOSE : null
  // Closing from that state: the host reads this plant's lots again, so the row on the page under the
  // sheet says what the lot holds whichever way the add went. Then the sheet closes, as after a save.
  const closeAdd = () => {
    if (addState.unsure && onSeedMaybeAdded) onSeedMaybeAdded()
    if (onClose) onClose()
  }
  if (addOn && mode === 'add' && planting) {
    return (
      <Sheet open busy={addState.busy} dirty={addState.dirty} armsBack onClose={closeAdd} title="Save seed" {...discardProps} confirmCopy={unsureCopy}>
        <AddToLot
          planting={planting} ownLots={openOwnLots} startLot={namedLot} Basis={SeedCountBasis}
          onState={setAddState}
          onBack={() => { setAddState({ dirty: false, busy: false, unsure: false }); setMode('new') }}
          onAdded={seedAdded}
        />
      </Sheet>
    )
  }

  // `armsBack` below is a per-render-site decision, as Sheet's own contract requires. The arming defaults OFF because
  // one useDismissable call serves every Sheet, and enrolling them all would orphan a pushed entry on BottomNav's
  // navigate-and-close rows. This sheet is the close-in-place kind the prop exists for: closing it returns to the page
  // underneath and navigates nowhere. It matters more here: in an installed Android PWA Back is a
  // system gesture, and unarmed, reached from the /log menu door (inside the overlayable /log route), ONE Back unwound
  // the whole route and took the half-typed lot name, count and process choice with it. Armed, decideBack dismisses
  // the topmost layer only: one Back closes the sheet, a second leaves /log.
  return (
    <Sheet open busy={busy} armsBack onClose={onClose} title="Save seed" {...discardProps}>
      {/* The origin block renders only when the caller could not answer it; from a planting page or the event */}
      {/* menu this whole section is absent. */}
      {parent && multi ? (
        // The "From" block: the parent set, one row per planting. It takes the place of the one-line "From <planting>"
        // below, and the plant count sits in it, under the rows it is about and away from the seed count further down,
        // so a number of plants is not typed into the seed field.
        <div data-testid="save-seed-from" style={{ margin: '0 0 14px' }}>
          <div id="save-seed-from-label" style={fromHeadingStyle}>From</div>
          <ul aria-labelledby="save-seed-from-label" style={fromListStyle}>
            {rows.map((row, i) => {
              const label = row?.name || 'this planting'
              return (
                <li key={String(row.id)} data-testid="save-seed-from-row" style={fromRowStyle}>
                  <span style={fromNameStyle}>{label}</span>
                  {/* The page's own planting is not removable: the sheet was opened FOR it. At a planting-less */}
                  {/* door every row was chosen here, the first included, and removing the last returns to "Which plant?" */}
                  {/* with everything typed still in place. */}
                  {!(planting && i === 0) && (
                    <button
                      type="button" data-testid="save-seed-from-remove" aria-label={`Remove ${label}`}
                      disabled={busy} onClick={() => removeRow(row.id)} style={fromRemoveStyle}
                    >
                      <span aria-hidden="true">✕</span>
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
          {canAdd && (
            <button
              ref={adderButtonRef}
              type="button" data-testid="save-seed-add-plant" aria-expanded={adderOpen}
              disabled={busy} onClick={() => setAdderOpen((open) => !open)} style={fromAddStyle}
            >
              + Add seed from another plant
            </button>
          )}
          {canAdd && adderOpen && (
            // The same PlantingSelect as "Which plant?", narrowed to the set's crop and without the plantings already
            // chosen. autoOpen because the tap that asked for it is the gesture: from a planting page the second plant
            // is then two taps, with no typing.
            <label style={{ ...fieldLabelStyle, marginTop: 6 }}>
              Your other {cropWords(adderCrop)} plantings
              <PlantingSelect
                value=""
                onChange={(_id, row) => addRow(row)}
                cropSlug={adderCrop}
                excludeIds={excludeIds}
                emptyText={`No other ${cropWords(adderCrop)} plantings to add.`}
                footerNote="A plant with no variety recorded is not listed here. Give it a variety first."
                labelFormat="qtyVariety"
                autoOpen
                data-testid="save-seed-add-select"
              />
            </label>
          )}
          {showPutIn && (
            // The other answer to "where does this seed go". Same style as the adder above it, and under the adder's
            // picker while that is open. Named for the one lot it can only mean, with that lot's facts under the name;
            // otherwise the general words, and the list.
            <button
              ref={putInRef}
              type="button" data-testid="save-seed-put-in-lot"
              disabled={busy} onClick={() => setMode('add')} style={fromPutInStyle}
            >
              {namedLot ? `Put it in ${namedLot.name || 'the seed lot I started'}` : 'Put it in a seed lot I already started'}
              {namedLot && lotFactsLine(namedLot) && (
                <span style={fromPutInLineStyle}>{lotFactsLine(namedLot)}</span>
              )}
            </button>
          )}
          {showPlantCount && (
            <>
              <label style={{ ...fieldLabelStyle, marginTop: 10, marginBottom: 0 }}>
                About how many separate plants did you gather this seed from?
                {/* No placeholder digit: a grey "e.g. 9" reads as a value already there. */}
                <input
                  type="number" inputMode="numeric" min="1" max={PLANT_COUNT_MAX} step="1" value={plantCount}
                  onChange={(e) => setPlantCount(e.target.value)}
                  aria-describedby="save-seed-plant-count-note"
                  data-testid="save-seed-plant-count" style={inputStyle}
                />
              </label>
              <p id="save-seed-plant-count-note" data-testid="save-seed-plant-count-note" style={hintStyle}>
                Single plants, not the plantings listed above. Count each plant once, however often
                you picked from it. Leave it blank if you can&apos;t say.
                {plantHint && <span data-testid="save-seed-plant-count-hint" style={{ display: 'block' }}>{plantHint}</span>}
              </p>
            </>
          )}
        </div>
      ) : parent ? (
        <p style={{ margin: '0 0 14px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.5 }}>
          From {parent?.name || 'this planting'} — the lot remembers which plant it came off.
        </p>
      ) : origin === null ? (
        <div style={{ margin: '0 0 14px' }}>
          <p style={{ margin: '0 0 10px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.5 }}>
            Where did this seed come from?
          </p>
          {/* Block targets at the full tap minimum, not inline links: the primary action of the sheet, on the first */}
          {/* screen, reached with seedy hands (BUG-SEEDTAPTARGET-001). */}
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
          {/* PlantingSelect, NOT a hand-rolled list: it self-fetches, sorts, formats the label and carries the row */}
          {/* through onChange, so this sheet needs no id->row lookup of its own, and it is the picker every other */}
          {/* surface uses. */}
          <label style={fieldLabelStyle}>
            Which plant?
            {/* This picker is on screen only while no planting is chosen, so its value is always
                unset. The pick becomes the first row of the set (and, flag off, the only one). */}
            <PlantingSelect
              value=""
              onChange={(_id, row) => setPicked(row ? [row] : [])}
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
          {/* WHICH farm stand. Labels, help text and the disclosure rule are InventoryAdd's, verbatim: these are the */}
          {/* two intake doors onto the same two columns, and two spellings of one question is how they diverge. */}
          {/* NOT gated on the kind select above: the kind is optional (the create only sends it when truthy), so */}
          {/* hiding the name behind it would leave no way to say which source for anyone who skips it. */}
          <Field label="Origin" help="Who grew, bred, packed or gave it." style={{ marginBottom: 14 }}>
            <SourcePicker
              label="Origin"
              value={sourceId}
              onChange={(sid) => {
                // Clearing the origin clears the venue with it: acquired_from means "the shop WHEN IT DIFFERS from the
                // grower", so it is meaningless alone and a stale id left in state would still be submitted. THE one
                // mechanism; see the payload note in save().
                setSourceId(sid)
                if (!sid) setAcquiredFromId('')
              }}
              placeholder="Search sources…"
              data-testid="seed-source"
            />
          </Field>
          {/* Only once an origin exists: before that "does it differ?" has nothing to differ from. Inline rather */}
          {/* than behind a disclosure, because a control appears when it can change the answer. */}
          {sourceId !== '' && (
            <Field label="Acquired from" help="The shop or venue, only if it differs from the origin."
              style={{ marginBottom: 14 }}>
              <SourcePicker
                label="Acquired from"
                value={acquiredFromId}
                onChange={(sid) => setAcquiredFromId(sid)}
                placeholder="Search sources…"
                data-testid="seed-acquired-from"
              />
            </Field>
          )}
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
        {/* Typing here is what makes the name the user's: from then on the set no longer renames it. */}
        <input
          type="text" value={name}
          onChange={(e) => { setTypedName(e.target.value); setNameTouched(true) }}
          data-testid="save-seed-name" style={inputStyle}
        />
      </label>

      <div style={fieldLabelStyle}>
        Variety
        {!pickerShown && (
          <div style={isMix ? mixRowStyle : varietyRowStyle}>
            <span data-testid="save-seed-variety-name" style={{ fontWeight: 400, color: P.dark }}>
              {isMix ? mixName : (variety?.name || "this planting's variety")}
            </span>
            {/* NO "Change" while the plantings are different varieties. The jar has to be filed under the mix of */}
            {/* exactly those plants, so any variety picked here would be refused at Save: a choice offered and then */}
            {/* refused is a trap. The way to a different variety is to take a plant off the jar, on its row above. */}
            {!isMix && (
              <button
                type="button" data-testid="save-seed-variety-change"
                onClick={() => setPickerOpen(true)} style={linkBtnStyle}
              >
                Change
              </button>
            )}
          </div>
        )}
        {/* The explanation at the point of change. The notice block above Save does not repeat it. */}
        {isMix && (
          <p data-testid="save-seed-mix-reason" style={{ ...hintStyle, fontWeight: 400 }}>
            These plants are recorded under different varieties, so this lot is filed as a mix.
          </p>
        )}
      </div>
      {pickerShown && (
        <div data-testid="save-seed-variety-picker" style={{ marginBottom: 14 }}>
          {/* A pick made here is a hand choice, and it keeps the picker open: the picker closing under the finger */}
          {/* that just used it would read as the choice being lost. */}
          <VarietyPicker
            id="save-seed-variety" value={variety}
            onChange={(v) => { setHandVariety(v); setPickerOpen(true) }} required
          />
          {!varietyId && (
            // Named, not silent: a planting with no cultivar is the ONE case this flow cannot default its way out of,
            // and the user needs to be told why Save will refuse.
            <p data-testid="save-seed-no-variety" style={hintStyle}>
              This planting has no variety recorded. Pick the variety this seed came from — a seed
              lot has to name one.
            </p>
          )}
        </div>
      )}

      {/* The count, offered at the FIRST step rather than only the last. Blank by default and never pre-filled; see */}
      {/* parseOpeningCount. */}
      {/* marginBottom 0 so the basis switch below sits against this field rather than a field-gap away from it. */}
      {/* With a plant count in the "From" block above, this one says what it counts. */}
      <label style={{ ...fieldLabelStyle, marginBottom: 0 }}>
        {multi ? 'How many seeds?' : 'How many?'} <span style={{ color: P.light, fontWeight: 400 }}>(optional)</span>
        {/* inputMode NUMERIC, not decimal: seed_count is an integer column and a decimal point one tap away on an */}
        {/* Android keypad is a 400 from the route (see the whole-number guard in save()). The weight field below */}
        {/* is the one that wants a decimal pad. */}
        <input
          type="number" inputMode="numeric" min="0" step="1" value={count}
          onChange={(e) => setCount(e.target.value)}
          placeholder="e.g. 20"
          aria-describedby="save-seed-count-note"
          data-testid="save-seed-count" style={inputStyle}
        />
      </label>
      {/* Outside the <label> on purpose: a <button> nested in one is interactive content whose click the label is */}
      {/* supposed to ignore, and "supposed to" is not something to bet a toggle on across a browser and jsdom. */}
      <SeedCountBasis
        estimated={countEstimated} onChange={setCountEstimated}
        testId="save-seed-count-estimated"
      />
      <p id="save-seed-count-note" data-testid="save-seed-count-note" style={{ ...hintStyle, margin: '0 0 14px' }}>
        Leave it blank if the seed is still wet and unthreshed. You can set or change the count at
        every step, and you&apos;ll be asked for a final one when you mark the lot stored.
      </p>

      {/* The weight is an ALTERNATIVE to the count, not a second thing to fill in: a packet states one or the other and */}
      {/* rarely both. Hence "Or", and both fields optional and blank. */}
      {/* type="text", NOT type="number", and that is load-bearing: a number input rejects "2.5 g" and hands back an */}
      {/* EMPTY string for it in every browser, so the suffix this field documents would silently erase what the user */}
      {/* typed. inputMode decimal for the keypad. */}
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

      {/* Optional, and DEFAULTED OFF. Choosing a process writes a permanent seed_lot_stage_log row, so the sheet must */}
      {/* not pick one on the user's behalf (BUG-SEEDPROCFORCED-001). "Not yet" leaves the lot un-staged, as */}
      {/* /inventory/add would. */}
      <div style={fieldLabelStyle} id="save-seed-process-label">Start tracking it?</div>
      <div role="group" aria-labelledby="save-seed-process-label" style={{ marginBottom: 14 }}>
        {/* An unstaged lot is a row in Seeds › My seeds. */}
        {[['none', 'Not yet — just save the lot', 'It waits in Seeds › My seeds until you start the process'],
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

      {/* Keyed on `variety`, the state that will actually be WRITTEN, and not on the `planting` prop: they differ */}
      {/* when the user opens the picker and chooses another cultivar, and the warning must be about the seed being */}
      {/* saved. Sits above Save so it is the last thing read before the tap it is about. Renders NOTHING (not an */}
      {/* empty box) when there is no assessment; see breedingNotice. */}
      {/* One block, read from two places. While the plantings are one variety (truth-table rows 0-7) the Variety */}
      {/* row's line stands and the parent set only ADDS its own sentences under it ("From 2 plantings of X."). With */}
      {/* two or more varieties (rows 8-10) no single variety's line is true of the jar, so only the set speaks. */}
      {(() => {
        const setSays = multi && rows.length > 0
          ? lotNotice({
            source_plants: sourcePlants,
            source_plant_id: parent?.id ?? null,
            breeding_system: variety?.breeding_system ?? null,
            variety_rank: isMix ? 'blend' : (variety?.variety_rank ?? null),
            variety_name: isMix ? mixName : (variety?.name ?? null),
          })
          : null
        const notice = setSays && setSays.row >= 8 ? null : breedingNotice(variety)
        const sentences = setSays?.sentences ?? []
        if (!notice && sentences.length === 0) return null
        return (
          <div
            data-testid="breeding-notice" data-breeding={notice ? variety?.breeding_system : undefined}
            style={breedingNoticeStyle}
          >
            {notice?.badge && (
              <Badge tone={notice.tone} style={{ marginRight: 8, verticalAlign: 'middle' }}>
                {notice.badge}
              </Badge>
            )}
            {notice && <span>{notice.line}</span>}
            {sentences.map((sentence, i) => (
              <span
                key={sentence} data-testid="breeding-notice-set"
                style={{ display: 'block', marginTop: notice || i > 0 ? 6 : 0 }}
              >
                {sentence}
              </span>
            ))}
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
// The mix's name is two or three variety names joined, so it wraps where a single name did not. Same box as
// varietyRowStyle, with vertical padding in place of a fixed line.
const mixRowStyle = { ...varietyRowStyle, padding: '10px 12px', overflowWrap: 'anywhere' }
const linkBtnStyle = {
  background: 'none', border: 'none', padding: '4px 2px', cursor: 'pointer',
  fontSize: '0.82rem', fontWeight: 600, color: P.green, textDecoration: 'underline',
  // The tap floor, read from the token (gate:save-seed-sheet measures it).
  minHeight: T.tapMinHeight,
}
// The "From" block. Rows are plain lines, not boxed fields: they state what was chosen and are not inputs. Both
// controls are T.tapMinHeight tall (and the remove control as wide), read from the token. The remove control is a ✕
// with the planting's name in its accessible name, so it is never told apart from its neighbour by position.
const fromHeadingStyle = { fontSize: '0.82rem', fontWeight: 600, color: P.mid }
const fromListStyle = { listStyle: 'none', margin: '2px 0 0', padding: 0 }
const fromRowStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  minHeight: T.tapMinHeight, borderBottom: `1px solid ${P.border}`,
}
const fromNameStyle = {
  flex: 1, minWidth: 0, overflowWrap: 'anywhere', padding: '8px 0', color: P.dark, fontSize: '0.95rem',
}
const fromRemoveStyle = {
  flexShrink: 0, minWidth: T.tapMinHeight, minHeight: T.tapMinHeight, padding: 0,
  background: 'none', border: 'none', borderRadius: 8, cursor: 'pointer',
  color: P.mid, fontSize: '1rem', lineHeight: 1,
}
const fromAddStyle = {
  display: 'block', width: '100%', textAlign: 'left', minHeight: T.tapMinHeight, padding: '0 2px',
  background: 'none', border: 'none', cursor: 'pointer',
  color: P.green, fontSize: '0.9rem', fontWeight: 600,
}
// The adder's style, with room for a second line under a lot's name.
const fromPutInStyle = { ...fromAddStyle, padding: '8px 2px', overflowWrap: 'anywhere' }
const fromPutInLineStyle = { display: 'block', marginTop: 2, color: P.mid, fontSize: '0.78rem', fontWeight: 400 }
const processRowStyle = (selected) => ({
  display: 'block', width: '100%', textAlign: 'left', minHeight: 64, padding: 12,
  marginBottom: 10, borderRadius: 8, cursor: 'pointer',
  border: `1px solid ${selected ? P.green : P.border}`,
  backgroundColor: selected ? P.greenPale : P.white, color: P.dark,
})
const hintStyle = { margin: '6px 0 0', color: P.mid, fontSize: '0.78rem', lineHeight: 1.5 }
// Lighter than processRowStyle: that one offers a choice in its own right, this one modifies the field it sits under,
// and giving them the same weight would read as two questions. The count label's own bottom margin is zeroed on both
// surfaces so the switch sits against the field it is about. Selected state is carried by border + fill + weight,
// never by colour alone.
const basisRowStyle = (on) => ({
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
  minHeight: T.tapMinHeight, margin: '6px 0 14px', padding: '0 12px',
  borderRadius: 8, cursor: 'pointer',
  border: `1px solid ${on ? P.green : P.border}`,
  backgroundColor: on ? P.greenPale : P.white,
  color: on ? P.dark : P.mid, fontSize: '0.82rem', fontWeight: on ? 600 : 400,
})
const basisMarkStyle = (on) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  width: 18, height: 18, borderRadius: 4,
  border: `1px solid ${on ? P.green : P.border}`,
  backgroundColor: on ? P.green : P.white, color: P.white, fontSize: '0.7rem', lineHeight: 1,
})
// No border or fill of its own: the F1 arm carries a warn Badge that is already the colour signal, and boxing the
// other three arms would give an ordinary factual line the visual weight of an alert. Bottom margin only, so the
// block sits against Save.
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
