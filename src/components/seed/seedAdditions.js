// src/components/seed/seedAdditions.js — V5-SEEDLOTADDITION-001 (seed release 3). "Put it in a seed lot
// I already started", the parts that are decided without a screen: whether the surface exists at all,
// which of a plant's own lots can still take seed, the request and the timeline entry, and every
// sentence the add form can say. AddToLot.jsx draws them and SaveSeedSheet.jsx opens it.
//
// PURE. Nothing here fetches, and nothing here prints a server's sentence: a refusal is answered by
// its `code` in the client's own words (sentenceForRefusal), and an answer with no code gets the
// general sentence.
//
// ONE READER FOR THE SWITCH. Every surface of this release asks addToLotAvailable() and nothing else,
// so "off" is one answer everywhere: no link, no list, no form, no "still says" line, and no request
// to either new route. It needs BOTH flags: the add form lives in release 2b's From block.
import { SEED_MULTI_PARENT, SEED_ADD_TO_LOT } from '../../lib/featureFlags.js'
import { formatSeedWeight } from '../../lib/format.js'
import { seedCountLabel } from './seedLots.js'
import { seedStageLabel } from './seedStages.js'

export function addToLotAvailable() {
  return SEED_MULTI_PARENT && SEED_ADD_TO_LOT
}

// ── Which lots can take more seed ────────────────────────────────────────────────────────────────────
const NY_YEAR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' })
const nyYear = (at) => {
  const d = at instanceof Date ? at : new Date(at)
  return Number.isNaN(d.getTime()) ? null : NY_YEAR.format(d)
}

// One of the plant's OWN lots (a row of GET /api/plants/:id/seed-lots), by the server's rule for the
// open-lots read: something left in it, never fermenting, and either still drying or started this year
// by the New York calendar. That row carries no `status`; a lot marked used up some other way is
// answered by the write's 409.
export function isOpenLot(lot, now = new Date()) {
  if (!lot || !(Number(lot.quantity_on_hand) > 0)) return false
  if (lot.seed_stage === 'fermenting') return false
  if (lot.seed_stage === 'drying') return true
  const made = nyYear(lot.created_at)
  return made != null && made === nyYear(now)
}

// ── What a lot's line says ───────────────────────────────────────────────────────────────────────────
const amountWords = (lot) => [
  seedCountLabel(lot?.seed_count, lot?.seed_count_estimated),
  formatSeedWeight(lot?.seed_weight_g),
].filter(Boolean)

// "Drying · approx. 120 seeds". A fact the lot does not have is left out, never a placeholder.
export function lotFactsLine(lot) {
  return [lot?.seed_stage ? seedStageLabel(lot.seed_stage) : '', ...amountWords(lot)].filter(Boolean).join(' · ')
}

export const HAS_THIS_PLANT = 'Has seed from this plant'

// The second line of a row in the lot list. The one parent is named unless it is this plant (the row
// already says so); two or more are counted, their names being one tap away on the lot's page.
export function lotRowLine(row, plantId) {
  const parents = Array.isArray(row?.source_plants) ? row.source_plants.filter(Boolean) : []
  let from = ''
  if (parents.length >= 2) from = `from ${parents.length} plantings`
  else if (parents.length === 1 && String(parents[0].id) !== String(plantId)) {
    const name = String(parents[0].name ?? '').trim()
    if (name) from = `from ${name}`
  }
  return [row?.is_member ? HAS_THIS_PLANT : '', lotFactsLine(row), from].filter(Boolean).join(' · ')
}

// ── What he typed ────────────────────────────────────────────────────────────────────────────────────
export const ADD_COUNT_MAX = 1000000
export const ADD_WEIGHT_MAX_G = 100000

// Today's count. Blank is "not counted" and sends nothing. The route takes a whole number from 1 to
// a million and refuses the rest, so the rest is answered here, before anything is sent.
export function parseAddCount(raw) {
  const typed = String(raw ?? '').trim()
  if (typed === '') return { value: null, error: null }
  if (!/^\d+$/.test(typed) || Number(typed) < 1) {
    return { value: null, error: 'Type a whole number of seeds, 1 or more, or leave it blank.' }
  }
  const n = Number(typed)
  if (n > ADD_COUNT_MAX) return { value: null, error: 'That is more seeds than one addition can hold.' }
  return { value: n, error: null }
}

// Today's weight, in grams ("mg" after the number for milligrams, as on Save seed). Rounded to the
// column's three places FIRST, as the route does, and only then judged: more than nothing, and no
// more than 100 kg.
export function parseAddWeight(raw) {
  const typed = String(raw ?? '').trim()
  if (typed === '') return { value: null, error: null }
  const m = typed.match(/^((?:\d+(?:\.\d+)?|\.\d+))\s*(g|mg)?$/i)
  if (!m) return { value: null, error: 'That is not a weight. Type a number of grams, or add "mg".' }
  const grams = m[2] && m[2].toLowerCase() === 'mg' ? Number(m[1]) / 1000 : Number(m[1])
  const rounded = Math.round(grams * 1000) / 1000
  if (!(rounded > 0)) return { value: null, error: 'That is too little to weigh. Leave it blank instead.' }
  if (rounded > ADD_WEIGHT_MAX_G) return { value: null, error: 'That is more weight than one addition can hold.' }
  return { value: rounded, error: null }
}

// ── The request ──────────────────────────────────────────────────────────────────────────────────────
// POST /api/inventory-items/:id/seed-additions. Four keys always, four only when there is something
// to say: the route reads `null` and an absent key alike, so nothing is sent as null. NEVER a top-level
// name, type or category: an older Lambda answers this path with its create arm, and a `name` there
// would make a new item.
export function buildAdditionBody({ key, plantId, expectedIds, pickedOn, count = null, estimated = false,
  weight = null, filing = null }) {
  const body = {
    addition_key: key,
    plant_id: plantId,
    expected_source_plant_ids: [...(expectedIds ?? [])],
    picked_on: pickedOn,
  }
  if (count != null) {
    body.add_seed_count = count
    body.add_estimated = !!estimated
  }
  if (weight != null) body.add_seed_weight_g = weight
  if (filing) body.filing = filing
  return body
}

// Only a 2xx that names the picking it wrote is a save. An older Lambda can answer 2xx without one.
export const additionSaved = (reply) => reply?.addition?.id != null

// ── The timeline entry ───────────────────────────────────────────────────────────────────────────────
// Permanent, so every clause is true when written: the lot's name as stored after the write, and the
// count only when one was typed. Nothing for a weight.
export function additionNote(lotName, count = null, estimated = false) {
  const seeds = count == null ? '' : seedCountLabel(count, estimated)
  return `Added seed to "${String(lotName ?? '').trim()}".${seeds ? ` ${seeds}.` : ''}`
}

// POST /api/events, once, after a save. The amounts are those of the body that was POSTED, never the
// fields as they stand now, so the timeline cannot name an amount the lot did not get.
export function additionEventBody(sent, reply) {
  const metadata = { seed_lot_id: reply.id, addition: true, seed_addition_id: reply.addition.id }
  if (sent.add_seed_count != null) {
    metadata.added_seed_count = sent.add_seed_count
    metadata.added_estimated = !!sent.add_estimated
  }
  if (sent.add_seed_weight_g != null) metadata.added_seed_weight_g = sent.add_seed_weight_g
  return {
    plant_id: sent.plant_id,
    event_type: 'seed_saved',
    event_date: sent.picked_on,
    notes: additionNote(reply.name, sent.add_seed_count ?? null, sent.add_estimated),
    metadata,
  }
}

// ── What the form says before the tap ────────────────────────────────────────────────────────────────
// The one line under the count field: what the lot will say afterwards. `count` is today's parsed
// number or null. A lot counted by hand that takes uncounted seed becomes an estimate; a lot at 0 that
// takes uncounted seed has nothing worth announcing; a lot with no count keeps none, whatever is typed.
export function outcomeLine(lot, count = null, estimated = false) {
  const has = lot?.seed_count != null && lot.seed_count !== ''
  if (!has) {
    return lot?.seed_stage === 'stored'
      ? "This lot has no seed count yet. You can add one on the lot's page."
      : "This lot has no seed count yet. You'll be asked for one when you mark it stored."
  }
  const now = Number(lot.seed_count)
  if (count != null) {
    const total = seedCountLabel(now + count, lot.seed_count_estimated === true || !!estimated)
    return `The lot will say ${total} (${now} now and ${count} today).`
  }
  if (!(now > 0)) return null
  return `The lot will say ${seedCountLabel(now, true)}, because today's seed is not counted.`
}

export const STORED_LOT_LINE = 'This lot is marked stored. Seed that is not fully dry can spoil the rest.'

// The re-file sentence, shown before the tap whenever adding this plant changes what the lot is filed
// under. An automatic lot name follows the mix; a name he typed stays.
export function refileSentence({ plantingName, mixName, newLotName = null }) {
  const who = String(plantingName ?? '').trim() || 'This planting'
  return newLotName
    ? `${who} is recorded under a different variety, so this lot will be filed as a mix and renamed ${newLotName}.`
    : `${who} is recorded under a different variety, so this lot will be filed as a mix: ${mixName}. Its name stays the same.`
}

// ── What the form says after the tap ─────────────────────────────────────────────────────────────────
export const ADD_CHANGED = 'This lot changed somewhere else just now. This is the latest. Tap Add to this lot if it still needs adding.'
// The last sentence is true because the lot's page can undo both things the server means by it: the
// "All used up" toggle (or the Qty on hand field) and the Status select.
export const ADD_USED_UP = 'That lot is marked used up or no longer in use. Nothing was added. Open the lot to change that first.'
export const ADD_REFUSED = "Couldn't add to that lot. Nothing was changed."
export const ADD_OFFLINE = "You're offline. Nothing was added. Your entries stay here until you're back in range."
export const ADD_CHECKING = 'Checking whether that was added…'
export const ADD_UNKNOWN = "That didn't finish, so today's seed may or may not have been added. Tap Try again. It will not be added twice."
// The close question while that stands (and while "Checking…" does). The ordinary one, "Close without
// adding?", would be untrue here: the seed may already be in the lot. This one claims only what is
// known and says what to look at before a second add.
export const UNSURE_CLOSE = Object.freeze({
  title: 'Close without checking?',
  body: "Today's seed may or may not have been added. Look at the lot's seed count before you add it again.",
  confirmLabel: 'Close',
  cancelLabel: 'Keep checking',
})
export const LOTS_FAILED = "Couldn't load your lots. Nothing was changed."
export const LOTS_FROM_CACHE = "This list may be out of date. Nothing can be added until you're back in range."

// The three answers that mean "the lot is not what this form was drawn from": redraw, then ask again.
const CHANGED_CODES = new Set(['lot_changed', 'parents_changed', 'blend_required'])
export const isChangedRefusal = (code) => CHANGED_CODES.has(code)

// A refusal's sentence, by its code. Every other code, and an answer with none, is the general one.
export function sentenceForRefusal(code) {
  if (isChangedRefusal(code)) return ADD_CHANGED
  if (code === 'lot_used_up') return ADD_USED_UP
  return ADD_REFUSED
}

// The toast after a save. `shownName` is the name the form showed; a different name in the reply
// means the write renamed the lot.
export function addedToast(shownName, replyName, eventFailed = false) {
  const stored = String(replyName ?? '').trim() || String(shownName ?? '').trim()
  const renamed = stored !== String(shownName ?? '').trim()
  const said = renamed ? `Added. The lot is now ${stored}.` : `Added to ${stored}`
  if (!eventFailed) return { message: said, tone: 'success' }
  return { message: `${said}${renamed ? '' : '.'} The timeline entry didn't save.`, tone: 'error' }
}

// ── The list's words ─────────────────────────────────────────────────────────────────────────────────
export const cropWords = (slug) => String(slug ?? '').replace(/[-_]+/g, ' ').trim().toLowerCase()
// A planting whose crop did not come back still gets a sentence, without the gap a blank would leave.
const cropped = (crop) => (crop ? `${crop} lots` : 'lots')
export const lotsLoadingLine = (crop) => `Looking for your other ${cropped(crop)}…`
export const lotsNoneLine = (crop) => `No ${cropped(crop)} to add to right now.`
export const otherLotsDivider = (crop) => `Other ${cropped(crop)}. Adding to one makes it a mix.`
