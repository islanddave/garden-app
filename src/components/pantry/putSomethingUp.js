// src/components/pantry/putSomethingUp.js
// Put-Up B′ release 2 (V4 §2.2 "Put something up" and "Walk a place", §3.1, §6.3, Appendix B) — the
// pure half of the two doors that add stock one thing at a time: which method chips a place offers,
// when "As is" is offered and what it is called, which table a save goes to, the preview line, and the
// one request body per route. PutSomethingUpSheet.jsx and WalkPlace.jsx paint these.
//
// THE ONE TABLE RULE (V4 §2.1): if the household applied a method it is a put-up (POST /api/preservation),
// whatever the source; As is — bought, fresh or leftovers — is a pantry item (POST /api/pantry/items).
// The person never picks a table; the method chip does.
//
// THE PREVIEW (§3.1): before Save, one line with the put-up date it uses and the discard date with its
// basis, computed by putItUp.js previewDiscard — the SAME engine module (lambda/preservation/shelfLife.js)
// the create route resolves with, so the date shown is the date stored. The completion line afterwards
// is built from what the server answered, never from this preview.
import {
  ALL_PUT_UP_METHODS, METHOD_LABELS, RAW_METHODS, TEXTURE_METHODS, estimateChips, previewDiscard, resolveWhen,
} from '../putup/putItUp.js'
import {
  putUpDateWords, shortDay, parseYmd, toYmd, discardWords, ESTIMATED_PRECISIONS, totalOfEach, qtyText,
} from '../putup/jarWords.js'
import { parseAmount } from './AmountField.jsx'

export const AS_IS = 'as_is'
// The no-method choice in two lengths. On its CHIP it says what it covers — true for a typed name whatever
// it is (bought, a gift, leftovers, something foraged): the app does not know where a typed thing came
// from, so the chip never says "bought". Everywhere else (the save line, the Walk's band) it is "As is".
export const AS_IS_LABEL = 'As is'
export const AS_IS_CHIP_LABEL = 'As is (bought, given, leftovers)'
export const FRESH_LABEL = 'Fresh, as picked'
export const DOOR_TITLE = 'Put something up'
export const DOOR_CTA = 'Put something up'
export const DOOR_SHEET = 'putsomethingup'
export const METHOD_REQUIRED_TEXT = 'How was it put up? Pick one — or As is.'
// Every disclosure says what it holds (there were two controls called "More" 60 px apart): the methods'
// one, and the options' — which hold different things on the door and on the Walk.
export const OTHER_WAYS_LABEL = 'Other ways…'
export const WALK_OPTIONS_LABEL = 'Raw or in oil, discard by, another date'
// Put-Up R2a — the door has TWO: A holds what changes the date line (When · In oil · Discard by), B what is
// record only (where it's from · notes). A names In oil only where it is offered (a put-up method); B is
// "Notes" alone for a planting, which gets no where-from row (its origin is the planting).
export const DOOR_OPTIONS_LABEL = 'Date, discard by'
export const DOOR_OPTIONS_LABEL_PUT_UP = 'Date, discard by, in oil'
export const DOOR_FROM_LABEL = 'Where from, notes'
export const DOOR_FROM_LABEL_PLANTING = 'Notes'
export const DOOR_NOTES_PLACEHOLDER = 'Anything to remember'
export const DOOR_NOTES_PLACEHOLDER_PUT_UP = 'Recipe you followed, or anything to remember'
// One question, two labels: on a put-up it asks what went IN (a gifted jar of jam is not the household's own
// put-up); on an as-is item, where the thing itself came from.
export const WHERE_FROM_HEADING = "Where it's from"
export const MADE_WITH_HEADING = 'Made with produce from'
export const SIZE_LINK_LABEL = '＋ Size of each container'
export const AMOUNT_LINK_LABEL = '＋ How much'
export const HOW_DRY_LABEL = 'How dry?'
export const RAW_OR_IN_OIL_LABEL = 'Raw or in oil'
// The door is for a thing that is finished. A ferment still going is a batch: this line hands the typed
// name to the Start sheet.
export const START_BATCH_INSTEAD_TEXT = 'Still going (a ferment)? Start a batch instead →'
export const WHAT_REQUIRED_TEXT = 'What is it? Type a name.'
export const WHERE_REQUIRED_TEXT = 'Where does it live? Pick a place.'

const FREEZER_KINDS = new Set(['deep_freezer', 'fridge_freezer'])

// Before a place is picked there is no kind to rank by: the general four (Put-Up UX pass R1), so the
// row is never just "As is" and a link. A place then puts ITS four in their place.
export const GENERAL_METHODS = Object.freeze(['whole_freeze', 'can_water_bath', 'ferment', 'dehydrate'])

// Appendix B "Method chips on Put something up and the Walk, by place kind" — ≤ 4, a fixed seed order.
export const PLACE_KIND_METHODS = Object.freeze({
  deep_freezer: ['whole_freeze', 'blanch_freeze', 'roast_freeze', 'pesto'],
  fridge_freezer: ['whole_freeze', 'blanch_freeze', 'roast_freeze', 'pesto'],
  fridge: ['quick_pickle', 'hot_sauce', 'ferment', 'pesto'],
  pantry: ['can_water_bath', 'jam_preserve', 'dehydrate', 'cure_store'],
  cold_storage: ['cold_store', 'cure_store', 'can_water_bath', 'ferment'],
  other: ['cure_store', 'dehydrate', 'candy'],
})

export function isPlantingHit(what) { return what?.source === 'planting' && !!what?.plant_id }

// { chips, more, asIs } for a place kind and a What. `asIs` is the no-method CHIP's label, or null when
// it is not offered: at a freezer a planting hit shows methods and Other ways… only (the first chip is
// Freeze whole), while the as-is chip stays there for other hits (bought frozen food). For a planting hit
// anywhere else it reads "Fresh, as picked"; for a typed name or any other hit, "As is (bought, given,
// leftovers)". No place yet → the general four.
export function methodChoices({ placeKind = null, what = null } = {}) {
  const chips = PLACE_KIND_METHODS[placeKind] ?? GENERAL_METHODS
  const more = ALL_PUT_UP_METHODS.filter(m => !chips.includes(m))
  const planting = isPlantingHit(what)
  const asIs = planting && FREEZER_KINDS.has(placeKind) ? null : (planting ? FRESH_LABEL : AS_IS_CHIP_LABEL)
  return { chips, more, asIs }
}

export function methodLabel(method, what = null) {
  if (method === AS_IS) return isPlantingHit(what) ? FRESH_LABEL : AS_IS_LABEL
  return METHOD_LABELS[method] ?? method
}

export function routeFor(method) {
  if (!method) return null
  return method === AS_IS ? 'item' : 'jar'
}

const isPutUpMethod = (method) => !!method && method !== AS_IS
export function doorOptionsLabel(method) { return isPutUpMethod(method) ? DOOR_OPTIONS_LABEL_PUT_UP : DOOR_OPTIONS_LABEL }
export function doorFromLabel(what) { return isPlantingHit(what) ? DOOR_FROM_LABEL_PLANTING : DOOR_FROM_LABEL }
export function doorNotesPlaceholder(method) { return isPutUpMethod(method) ? DOOR_NOTES_PLACEHOLDER_PUT_UP : DOOR_NOTES_PLACEHOLDER }
export function whereFromHeading(method) { return isPutUpMethod(method) ? MADE_WITH_HEADING : WHERE_FROM_HEADING }

// ── The canning line (R2a A7) ────────────────────────────────────────────────────────────────────
// A quoted reference with a link-out, shown under the method row for the two canning methods on the door
// and the Walk. It says what each method is for and reads nothing about this jar: it never compares,
// colours, gates or changes a date. ONE constant; DoorParts.CanningLine is its one part.
export const CANNING_METHODS = new Set(['can_water_bath', 'can_pressure'])
export const CANNING_LINE = Object.freeze({
  lines: Object.freeze([
    'Published home-canning advice: water-bath canning is only for acid foods (most fruit, jam, pickles, tomatoes with added acid).',
    'Low-acid foods (vegetables, meat) need a pressure canner.',
  ]),
  linkText: 'National Center for Home Food Preservation →',
  linkName: 'National Center for Home Food Preservation — opens in a new tab',
  href: 'https://nchfp.uga.edu/how/can',
})

// The ONE slot under the method row, by method — never two at once: the canning line (the two canning
// methods), Raw with its line (the three that allow Raw), How dry? (the two dried). Nothing for the rest.
export function methodSlot(method) {
  if (CANNING_METHODS.has(method)) return 'canning'
  if (RAW_METHODS.has(method)) return 'raw'
  if (TEXTURE_METHODS.has(method)) return 'dry'
  return null
}

// ── Size (R2a A1) ────────────────────────────────────────────────────────────────────────────────
// `size`: { value: the typed text, unit: a stored unit | null } — the size of EACH container. The column
// holds the TOTAL (jarWords "QUANTITY IS THE TOTAL"), so what is sent is size × how many. The typed text is
// read through AmountField.parseAmount FIRST: it takes a comma ("0,5"), and jarWords.totalOfEach — size
// first, then the count — has no comma arm. → { each, total, unit } with both numbers, or null when there is
// no size (or half of one: the door refuses that in place before a save).
export const PUT_UP_TOTAL_MAX = 99999999.99
export const SIZE_TOTAL_TOO_BIG_TEXT = 'That is more in all than a put-up can record — type a smaller size, or clear the size.'
export function sizeTotal(size, count) {
  const each = parseAmount(size?.value)
  if (each == null || !size?.unit) return null
  const total = totalOfEach(String(each), count)
  return total == null ? null : { each, total: Number(total), unit: size.unit }
}
// The create has no upper bound and numeric(10,2) does: a total past the column would answer 500.
export function sizeTotalError(size, count) {
  const t = sizeTotal(size, count)
  return t && t.total > PUT_UP_TOTAL_MAX ? SIZE_TOTAL_TOO_BIG_TEXT : null
}
// "3 × 1 qt = 3 qt in all" — both numbers on screen where the size is typed, because the stored one is the
// total. Only with more than one container; null otherwise.
export function sizeEcho(size, count) {
  const n = Number(count)
  const t = sizeTotal(size, n)
  if (!t || !(n > 1)) return null
  return `${n} × ${qtyText(t.each)} ${t.unit} = ${qtyText(t.total)} ${t.unit} in all`
}

// "Save · frozen", "Save · as is" — the button names the result (V4 §2.2).
const SAVE_WORDS = {
  whole_freeze: 'frozen', blanch_freeze: 'frozen', roast_freeze: 'frozen', dehydrate: 'dried', powder: 'dried',
  can_water_bath: 'canned', can_pressure: 'canned', ferment: 'fermenting', ferment_mash: 'fermenting',
  quick_pickle: 'pickled', candy: 'candied', cure_store: 'curing', cold_store: 'in cold store',
}
export function saveLabel(method, what = null) {
  if (!method) return 'Save'
  if (method === AS_IS) return isPlantingHit(what) ? 'Save · fresh' : 'Save · as is'
  return `Save · ${SAVE_WORDS[method] ?? (METHOD_LABELS[method] ?? method).toLowerCase()}`
}

// ── When ─────────────────────────────────────────────────────────────────────────────────────────
// The door: Today by default; Yesterday / Earlier… under More (putItUp.resolveWhen, §3.6 windows).
export function doorWhen({ chip = 'today', estimate = null, pickedDate = '', now = new Date() } = {}) {
  return resolveWhen({ chip, estimate, pickedDate, now })
}

// The Walk: one date per sitting from the §3.6 estimate chips, Not sure included. Not sure stores the
// walk day with precision `unknown` (§3.6) — that jar gets no table or house date (§3.1).
export const WALK_NOT_SURE = { id: 'unsure', label: 'Not sure' }
export function walkWhenChips(now = new Date()) {
  return [...estimateChips(now), WALK_NOT_SURE]
}
export function walkWhen({ choice, pickedDate = '', now = new Date() } = {}) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!choice) return { error: 'Roughly when? Pick one — or Not sure.' }
  if (choice === 'unsure') return { when: { date: toYmd(today), precision: 'unknown' }, words: 'not sure' }
  if (choice === 'pickdate') {
    const d = parseYmd(pickedDate)
    if (!d) return { error: 'Pick the date — or tap Not sure.' }
    if (d.getTime() > today.getTime()) return { error: "That date hasn't happened yet — pick another." }
    return { when: { date: toYmd(d), precision: 'day' }, words: shortDay(d, now) }
  }
  const c = estimateChips(now).find(x => x.id === choice)
  if (!c || !c.start) return { error: 'Roughly when? Pick one — or Not sure.' }
  return { when: { date: toYmd(c.start), precision: c.precision }, words: putUpDateWords(toYmd(c.start), c.precision, { now }) }
}

// ── The preview line (§3.1) ──────────────────────────────────────────────────────────────────────
// `discard`: { mode: 'auto' | 'none' | 'date', date }. A put-up resolves auto through the engine; a
// bought item has a discard date only if one is typed — and SAYS SO when none is ("got it today · no
// discard date"), so the line states both things a save will store.
// `isRaw` / `inOil` / `texture` (the chips of both doors): the engine reads all three, so the line changes
// the moment one is tapped. Raw counts only on a method that allows it, a texture only on a dried one
// (putItUp.RAW_METHODS, TEXTURE_METHODS — previewDiscard's own rules).
// WHEN RAW OR IN OIL IS WHAT REMOVED THE DATE (the same jar without them has one) the line says why and names
// the control that sets one. Every other no-date cause keeps the standing sentence, and so does the stored
// row (jarWords.basisWords): a row cannot know the cause.
export const NO_DISCARD_DATE_WORDS = 'no discard date'
export const RAW_OIL_NO_DATE_WORDS = 'no date — no general figure for raw or in-oil food. Set your own under Discard by.'
export function previewLine({
  method, place, when, discard = { mode: 'auto', date: '' }, isRaw = false, inOil = false, texture = null, now = new Date(),
}) {
  if (!method || !when) return null
  if (method === AS_IS) {
    const today = when.precision === 'day' && when.date === toYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
    const got = when.precision === 'unknown' ? 'put up: not sure'
      : `got it ${today ? 'today' : putUpDateWords(when.date, when.precision, { now })}`
    if (discard?.mode === 'date') {
      const d = parseYmd(discard.date)
      return d ? `${got} · discard by ${shortDay(d, now)} · set by hand` : `${got} · pick the date from the label`
    }
    return `${got} · ${NO_DISCARD_DATE_WORDS}`
  }
  const dateWords = when.precision === 'unknown' ? 'put up: not sure' : `put up ${putUpDateWords(when.date, when.precision, { now })}`
  const row = { place, discard, isRaw: isRaw === true, inOil: inOil === true, texture: texture ?? null }
  const at = { date: when.date, precision: when.precision }
  const p = previewDiscard({ row, method, when: at, now })
  if (!p) return dateWords
  if (p.basis === 'none' && (row.isRaw || row.inOil)) {
    const without = previewDiscard({ row: { ...row, isRaw: false, inOil: false }, method, when: at, now })
    if (without?.date) return `${dateWords} · ${RAW_OIL_NO_DATE_WORDS}`
  }
  return `${dateWords} · ${p.words}`
}

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────────
// `what`: { source: 'typed'|'planting'|'put_up'|'pantry_item', name, plant_id?, crop_type_slug?,
// variety_id? }. `place`: a place chip ({id?, kind, label}). `when`: {date, precision}.
function placeKeys(place) {
  if (place?.id) return { storage_location_id: String(place.id) }
  return { place: { kind: place?.kind, label: String(place?.label ?? '').trim() } }
}

// { error, field } for the three required answers (§6.3: what · where · how), else null. A "date from
// the label" chosen with no date is refused rather than silently saved as the worked-out one.
export const DISCARD_DATE_TEXT = 'Pick the date from the label — or tap Work it out.'
export function doorError({ what, place, method, discard = null }) {
  if (!String(what?.name ?? '').trim()) return { error: WHAT_REQUIRED_TEXT, field: 'what' }
  if (!place) return { error: WHERE_REQUIRED_TEXT, field: 'where' }
  if (!method) return { error: METHOD_REQUIRED_TEXT, field: 'method' }
  if (discard?.mode === 'date' && !parseYmd(discard.date)) return { error: DISCARD_DATE_TEXT, field: 'discard' }
  return null
}

// POST /api/preservation (the 1b create). `storageLocationId` is the place's id (a template chip is made
// first, pantryApi.ensurePlaceId). An absent use_by_target is the engine's date; null is "no date · set
// by hand"; a date is his (§3.1, key presence). `is_raw` / `in_oil` are sent ONLY when chosen (true), and
// Raw only for a method that allows it — an untouched save's body is exactly what it was, and the route
// ignores a key it does not know, so a misspelt one would store nothing and say nothing.
// Put-Up R2a — three OPTIONAL named arguments; a call passing none returns the body it always did, byte for
// byte. `size` ({ value, unit }, the size of EACH container): quantity_value is the TOTAL, a JSON NUMBER
// (=== Number(totalOfEach(size, count))), with quantity_unit — and when there is no total BOTH keys are
// absent, never a Number(null). `source` ({ kind, label }): source_kind, and source_label when a name was
// typed for a kind that takes one; a planting What ALWAYS sends own_garden and no label, whatever the state
// held (lineRoutes.js reads a jar's source_kind for its garden mark, and the server refuses a planting with
// any other source). `texture`: only on Dehydrate or Powder (the server refuses it on any other method).
function sourceKeys(source) {
  const kind = source?.kind ?? null
  if (!kind) return {}
  const label = kind === 'own_garden' ? '' : String(source?.label ?? '').trim()
  return label ? { source_kind: kind, source_label: label } : { source_kind: kind }
}

export function jarBody({
  key, what, storageLocationId, method, when, count = 1, discard, notes = '', isRaw = false, inOil = false,
  size = null, source = null, texture = null,
}) {
  const n = Number(count)
  const body = {
    idempotency_key: key,
    label: String(what.name).trim(),
    method,
    preserved_at: when.date,
    preserved_at_precision: when.precision,
    preserved_at_approx: when.precision !== 'day' && when.precision !== 'exact',
    package_count: Number.isInteger(n) && n >= 1 ? n : 1,
    storage_location_id: String(storageLocationId),
  }
  if (what.crop_type_slug) body.crop_type_slug = what.crop_type_slug
  if (what.variety_id) body.variety_id = what.variety_id
  if (isPlantingHit(what)) { body.plant_id = what.plant_id; body.source_kind = 'own_garden' }
  else Object.assign(body, sourceKeys(source))
  const total = sizeTotal(size, body.package_count)
  if (total) { body.quantity_value = total.total; body.quantity_unit = total.unit }
  if (discard?.mode === 'none') body.use_by_target = null
  else if (discard?.mode === 'date' && parseYmd(discard.date)) body.use_by_target = toYmd(parseYmd(discard.date))
  if (isRaw === true && RAW_METHODS.has(method)) body.is_raw = true
  if (inOil === true) body.in_oil = true
  if (texture && TEXTURE_METHODS.has(method)) body.texture = texture
  const nt = String(notes ?? '').trim()
  if (nt) body.notes = nt
  return body
}

// POST /api/pantry/items (the contract shape). A planting hit keeps its planting and crop.
// Put-Up R2a — two OPTIONAL named arguments; a call passing none returns the body it always did, byte for
// byte. `amount` ({ value, unit }): quantity_value, a JSON NUMBER (the route refuses a string), with
// quantity_unit — the amount as logged, never a count and never "left". `source` ({ kind, label }) as on a
// put-up, EXCEPT that a planting What sends plant_id and NO source keys: an item's garden origin is its
// planting (nothing reads an item's source_kind while plant_id is set, and sending one would turn every
// Fresh, as picked save into a 400 on an older route). The route's allowlist refuses any other key, so no
// put-up-only key (a count, a size, Raw, In oil, a texture, a method) may ever be built here.
export function itemBody({ key, what, place, when, discard, notes = '', amount = null, source = null }) {
  const body = { idempotency_key: key, name: String(what.name).trim(), ...placeKeys(place) }
  if (when?.precision === 'unknown') body.acquired_precision = 'unknown'
  else if (when?.date) { body.acquired_at = when.date; body.acquired_precision = when.precision }
  if (discard?.mode === 'date' && parseYmd(discard.date)) body.use_by_target = toYmd(parseYmd(discard.date))
  if (isPlantingHit(what)) body.plant_id = what.plant_id
  if (what.crop_type_slug) body.crop_type_slug = what.crop_type_slug
  const qty = parseAmount(amount?.value)
  if (qty != null && amount?.unit) { body.quantity_value = qty; body.quantity_unit = amount.unit }
  if (!isPlantingHit(what)) Object.assign(body, sourceKeys(source))
  const nt = String(notes ?? '').trim()
  if (nt) body.notes = nt
  return body
}

// ── A replayed item create (BUG-PUTUPREPLAYDROPSEDIT-001; kitchen/idempotencyKey.js) ─────────────────────
// The item's PATCH carries every key a create body can hold EXCEPT the planting (the Lambda's
// ITEM_PATCH_KEYS), so plant_id is the fixed half of an item send's print. itemPatchOf is a create body as
// that PATCH, for the item a replay answered with (`item`): a key the body left out goes as null (the create
// stored nothing there; the PATCH is presence-sentinel, and each pair travels together), and the place goes
// by id. The crop a typed name resolved to goes ONLY when it is not the item's already — so a change that
// leaves the crop alone sends the body the PATCH has always taken — and never for a planting, whose crop is
// the planting's (the Lambda refuses it there).
export const ITEM_FIXED_KEYS = Object.freeze(['plant_id'])
export function itemPatchOf(body, storageLocationId, item = null) {
  const patch = {
    name: body.name, storage_location_id: String(storageLocationId),
    acquired_at: body.acquired_at ?? null, acquired_precision: body.acquired_precision ?? null,
    use_by_target: body.use_by_target ?? null, notes: body.notes ?? null,
    quantity_value: body.quantity_value ?? null, quantity_unit: body.quantity_unit ?? null,
    source_kind: body.source_kind ?? null, source_label: body.source_label ?? null,
  }
  const crop = body.crop_type_slug ?? null
  if (body.plant_id == null && crop !== (item?.crop_type_slug ?? null)) patch.crop_type_slug = crop
  return patch
}
// Said when the first Save made the item and What has since become another planting, or stopped being one:
// nothing is written, and the form stays as it is. `item` is the row the replay answered with.
export function replayFixedText(item) {
  const name = String(item?.name ?? '').trim()
  return `${name ? `Already in the Pantry as “${name}”` : 'Already in the Pantry'} — the first Save went through. Which planting it came from can't be changed from here. Put it back as it was, or close this and fix it in the Pantry.`
}

// The completion line, from what the server answered (V4 §2.2 "completion in place on the Pantry"):
// a put-up is the created row (POST /api/preservation answers the row itself); an item is `{item}`'s.
export function completionWords({ route, saved, place = null, now = new Date() }) {
  const name = String((route === 'item' ? saved?.name : saved?.label) ?? '').trim() || 'It'
  const parts = [`${name} — ${route === 'item' ? 'in the pantry' : 'put up'}`]
  if (place?.label) parts.push(place.label)
  if (route === 'item') {
    if (saved?.use_by_target) parts.push(`discard by ${shortDay(saved.use_by_target, now)} · set by hand`)
  } else {
    const w = discardWords({
      date: saved?.use_by_target ?? null, basis: saved?.use_by_basis ?? null, method: saved?.method ?? null,
      kind: place?.kind ?? null, estimated: ESTIMATED_PRECISIONS.has(saved?.preserved_at_precision), now,
    })
    if (w) parts.push(w)
  }
  return parts.join(' · ')
}
