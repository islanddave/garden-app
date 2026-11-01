// harvestPost.js — V4-COMPOSEPOST-001. Turns the /api/harvests read model into a Facebook-ready
// harvest post. PURE: no React, no network, no clock — every time input is passed in. Mirrors the
// lambda/harvests/aggregate.js split so it unit-tests with zero runtime deps.
//
// WHY A BATCH AND NOT A DAY: Dave's posts correspond to ONE evening logging session, not a calendar
// day. Picks logged earlier in the day (berries, herbs, cup-unit picks) are deliberately omitted, and
// clustering by created_at gap reproduces that split. A "today's harvest" summary is measurably
// noisier than what he actually writes.
//
// WHY 45 MINUTES: over 40 days of real gaps there are ZERO observed gaps in the (45, 75] minute band,
// so 45 sits inside a genuinely empty interval rather than on a slope. The reference batches say
// nothing about N (they are bounded by gaps far wider than any candidate N). The cost of 45 is a
// ONE-ITEM last batch on a straggler evening, which is why MIN_POST_LINES exists below.
//
// WHY (created_by, created_at) AND NOT created_at ALONE: Jen is a real second logger. Overlapping
// evening sessions would otherwise merge into one "batch" published in Dave's first person.
//
// WHY created_at AND NOT event_date: event_date is date-grained by construction (a DST-safe
// date-at-noon encoding, 08:00 ET), so it cannot order within a day.

export const DEFAULT_GAP_MINUTES = 45

// A crop gets its own heading only at >= 3 distinct varieties. Dave lists two distinct pepper
// varieties as FLAT lines with no "Peppers:" heading, so a >=2 rule would emit a heading he did not
// write. 3 reproduces both reference posts.
export const DEFAULT_GROUP_THRESHOLD = 3

// Past ~15 lines the tail falls below Facebook's "See more" fold, so the crops added last become
// invisible. Advisory only — the UI warns, it never truncates. Never silently drop a harvested item.
export const LINE_SOFT_CAP = 15

// Below this, the surface offers nothing. N=45 produces a one-item last batch on a straggler evening
// (see the header), and "tonight's harvest: 1 tomato" is a post nobody writes.
export const MIN_POST_LINES = 2

// Only `count` renders. Weight is mostly server-ESTIMATED and must never appear in a public post.
// Both reference batches are 100% count, so this drops nothing Dave actually posted.
const POSTABLE_UNITS = new Set(['count'])

// Validated against the live cultivar corpus. ' Roma' is deliberately ABSENT: "San Marzano Roma" is
// a legitimate full variety name that appears in both reference batches, and stripping it would
// silently rename a crop in a public post.
const STRIP_SUFFIXES = [' F1', ' (Burpee)', ' Heirloom']

// Evidence-backed shortenings, taken verbatim from Dave's published post text where the DB name and
// the name he actually writes differ. Seeded ONLY from posts we can read, not from guesses. ' Roma'
// is a per-name override rather than a blanket suffix strip: Dave shortens THIS one, which does not
// make the suffix generally droppable.
export const NAME_OVERRIDES = {
  'san marzano roma': 'San Marzano',
  "czech's bush": 'Czech Bush',
  'chilly chill': 'Chilly Chills',
}

// Cultivar/planting names carrying identification uncertainty must never publish as-is, e.g.
// "Onion — scallion-type (thick blue-green, ID pending)".
const UNCERTAIN_NAME = /\b(id pending|unknown variety|unknown|tbd)\b|\(.*\?\s*\)/i

/**
 * Would publishing this name assert an identification the data does not support?
 *
 * Exported because seasonRetro.js is a SECOND public-output surface over the same names, and a
 * private copy of this predicate is exactly how the two metadata strippers diverged — one path
 * hardened, the other quietly kept publishing what the first had learned not to.
 */
export function isUncertainName(raw) {
  return UNCERTAIN_NAME.test(String(raw || ''))
}

// Crops with no distinct plural. "squash" is the one that bites — Dave writes "3 Zephyr squash".
const INVARIANT_PLURALS = new Set([
  'squash', 'greens', 'lettuce', 'kale', 'spinach', 'chard', 'basil', 'corn', 'garlic', 'broccoli',
])

// Nouns ending in -o are irregular in English and no rule separates them: tomato -> tomatoes but
// tomatillo -> tomatillos. Enumerate rather than guess; a wrong plural ships in a public post.
const O_TAKES_ES = new Set(['tomato', 'potato', 'hero'])

/**
 * Drop a TRAILING parenthetical. Every parenthetical in the harvested-name corpus is internal
 * bookkeeping or an ID note ("Cherokee Green (Rescue)", "Scallion (thin clump)"), never part of the
 * name Dave would write in a post. ID notes ("unknown variety", "ID pending") are blocked outright by
 * isUncertainName; this handles the ones that are safe to publish once the note is removed.
 * Crop types have the same shape: without this, "Onion (bunching / scallion)" pluralised to
 * "Onion (bunching / scallion)s".
 */
function stripParenthetical(s) {
  return String(s || '').replace(/\s*\([^()]*\)\s*$/, '').trim()
}

export function pluralizeCrop(word, qty) {
  const w = stripParenthetical(word)
  if (!w || Number(qty) === 1) return w
  // Pluralise the LAST word, keep the qualifiers: testing the whole string would miss the `squash`
  // invariant ("Summer Squashes") and the tomato -> tomatoes rule ("Cherry Tomatos").
  const parts = w.split(/\s+/)
  const head = parts.slice(0, -1)
  const tail = parts[parts.length - 1]
  const lower = tail.toLowerCase()
  let plural
  if (INVARIANT_PLURALS.has(lower)) plural = tail
  else if (O_TAKES_ES.has(lower)) plural = `${tail}es`
  else if (/(s|x|z|ch|sh)$/i.test(tail)) plural = `${tail}es`
  else if (/[^aeiou]y$/i.test(tail)) plural = `${tail.slice(0, -1)}ies`
  else plural = `${tail}s`
  return [...head, plural].join(' ')
}

// Strip-only. NEVER spell-correct, title-case, or expand: Dave wrote "Grandadero" for the DB's
// "Granadero" and `1 "beefsteak"` in scare quotes, and that idiosyncrasy is what reads as human.
// A resolver that "fixes" him publishes a correction he did not ask for.
export function normalizeVarietyName(raw) {
  // Parenthetical first: it is a note appended to the name, so it sits outside every suffix rule
  // below and would otherwise block them from matching the real end of the name.
  let n = stripParenthetical(raw)
  if (!n) return ''
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of STRIP_SUFFIXES) {
      if (n.length > suffix.length && n.toLowerCase().endsWith(suffix.toLowerCase())) {
        n = n.slice(0, -suffix.length).trim()
        changed = true
      }
    }
  }
  // Fold curly apostrophes to straight before the lookup: "Czech’s Bush" would otherwise miss the
  // "czech's bush" key. Which form a cultivar carries depends on how it was typed.
  const override = NAME_OVERRIDES[n.toLowerCase().replace(/[‘’]/g, "'")]
  return override || n
}

function toMillis(value) {
  if (value == null) return null
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

// The most recent contiguous run of harvests by one logger. Returns null when there is nothing
// postable. Entries arrive ordered by event_date DESC (NOT created_at), so we re-sort here.
export function detectLastBatch(entries, options = {}) {
  const { gapMinutes = DEFAULT_GAP_MINUTES, createdBy = null } = options
  const gapMs = Math.max(1, Number(gapMinutes)) * 60 * 1000

  const usable = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && toMillis(e.created_at) != null)
    .filter((e) => (createdBy ? e.created_by === createdBy : true))
    .map((e) => ({ entry: e, at: toMillis(e.created_at) }))
    .sort((a, b) => b.at - a.at)

  if (!usable.length) return null

  const owner = usable[0].entry.created_by ?? null
  const run = []
  let prevAt = null
  for (const row of usable) {
    // A different logger ends the run: an overlapping session must not merge into this batch.
    if ((row.entry.created_by ?? null) !== owner) break
    if (prevAt != null && prevAt - row.at > gapMs) break
    run.push(row)
    prevAt = row.at
  }

  const items = run.map((r) => r.entry).reverse() // chronological within the batch
  return {
    items,
    createdBy: owner,
    startedAt: new Date(run[run.length - 1].at).toISOString(),
    endedAt: new Date(run[0].at).toISOString(),
  }
}

function cropLabel(entry) {
  return String(entry.crop_name || entry.crop_type_slug || '').trim()
}

// One post line per harvest entry. Nothing is dropped here — a row with no variety name renders at
// crop level and is flagged `needsName`, because silently omitting a harvested item defeats the
// itemization that is the whole point of the post.
export function toLines(items) {
  return (Array.isArray(items) ? items : []).map((e) => {
    const crop = cropLabel(e)
    const rawName = e.planting_name || e.variety_name || ''
    const uncertain = UNCERTAIN_NAME.test(rawName)
    const name = uncertain ? '' : normalizeVarietyName(rawName)
    // harvest_log.quantity is `numeric`, so the neon driver hands back a STRING; left as is, every sum
    // in leadFacts becomes concatenation and every comparison lexical.
    const qty = Number(e.quantity)
    return {
      id: e.event_id,
      name,
      crop,
      quantity: Number.isFinite(qty) ? qty : null,
      unit: e.unit ?? null,
      // Dave's OWN marking, not a computed guess: a window function over plant_id contradicts his
      // hand annotations in both directions on the reference posts. So this is only ever pre-checked
      // from his event type.
      isFirst: e.event_type === 'first_harvest',
      // Suggestion, never finished copy: he REWRITES these ("Fell off plant with major blotch" ->
      // "(fell from plant w/ deformity, not 1st harvest)"). The UI offers it; it is not auto-emitted.
      noteSuggestion: e.note_excerpt || '',
      needsName: !name,
      uncertainName: uncertain,
      // A row with NEITHER a name NOR a crop renders as a bare integer ("2"), which is worse than an
      // omission because it publishes as a line of the itemised list. Harvests with plant_id NULL are
      // exactly this shape (no plant, so no cultivar, so no crop_types join). Not postable, but still
      // surfaced to the composer as `needsName` so it is visible and namable rather than dropped.
      postable: POSTABLE_UNITS.has(e.unit) && Number.isFinite(qty) && qty > 0 && !!(name || crop),
    }
  })
}

// BUG-HARVESTPOSTREGEX-001 — kept byte-identical to the escape in lambda/facebook-share/altText.js on
// purpose. The two run over the same user-authored crop and cultivar strings on the two halves of one
// publish path; a different character class between them makes the client and the Page disagree about
// a name only for cultivars containing the character one of them missed.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// How Dave actually writes a flat line: "1 Cubanelle pepper", "2 Pineapple tomatillos",
// "2 Dark Green zucchini", "10 cucamelons". Three things fall out of that:
//   - a MULTI-WORD crop label is taxonomy, not speech ("Summer Squash"), so it is never appended —
//     he writes "zucchini", which is already in the variety name;
//   - when the variety name IS the crop ("Cucamelon"), the line is just the pluralised crop;
//   - when the name ENDS with the crop ("Pineapple Tomatillo"), that trailing word is pluralised
//     and lowercased in place rather than duplicated.
// Anything this gets wrong is one tap to edit — every line is editable before the post leaves.
export function renderLine(line, { withCrop } = {}) {
  const qty = line.quantity
  const name = line.name || ''
  const crop = line.crop || ''
  if (!name) return `${qty} ${crop ? pluralizeCrop(crop, qty).toLowerCase() : ''}`.trim()
  if (!withCrop || !crop) return `${qty} ${name}`.trim()

  const cropIsSingleWord = !/\s/.test(crop)
  const plural = pluralizeCrop(crop, qty).toLowerCase()

  if (name.toLowerCase() === crop.toLowerCase()) return `${qty} ${plural}`
  // BUG-HARVESTPOSTREGEX-001 — `crop` is user-authored, so it must be escaped before `new RegExp`.
  // A crop named "Squash+" or "Pepper[" would throw a SyntaxError out of renderLine and take the
  // whole post composer with it; milder metacharacters mis-match silently instead.
  //
  // Crop types with parentheses ("Onion (bunching / scallion)") only avoid this because they contain
  // a space and cropIsSingleWord gates them out, which is an accident of an unrelated taxonomy rule,
  // not a guard. Dave can mint crop types from the app. lambda/facebook-share/altText.js escapes the
  // same way.
  const cropTail = cropIsSingleWord ? new RegExp(`\\s${escapeRe(crop)}$`, 'i') : null
  if (cropTail && cropTail.test(name)) {
    return `${qty} ${name.replace(cropTail, ` ${plural}`)}`
  }
  if (cropIsSingleWord && !name.toLowerCase().includes(crop.toLowerCase())) {
    return `${qty} ${name} ${plural}`
  }
  return `${qty} ${name}`
}

// Group into crop headings + a flat tail, mirroring the shape of Dave's real posts: the crops with
// several varieties get a heading, everything else is a flat line at the bottom.
export function buildPostModel(lines, options = {}) {
  const { groupThreshold = DEFAULT_GROUP_THRESHOLD } = options
  const raw = (Array.isArray(lines) ? lines : []).filter((l) => l && l.include !== false && l.postable)

  // Sibling plantings of one cultivar are DISTINCT garden_node rows, so picking from two beds of San
  // Marzano emits two identical lines. Dave writes "8 San Marzano", not "4 San Marzano / 4 San
  // Marzano". Merge on the RESOLVED name + crop (post identity), not on variety_id or plant_id:
  // two sibling plantings are different plants and the same thing to a reader.
  // A merged line keeps the first row's id so annotations and exclusions still address it, and ORs
  // isFirst so a first-harvest on either sibling survives the merge.
  const merged = new Map()
  for (const line of raw) {
    const key = `${(line.name || '').toLowerCase()}|${(line.crop || '').toLowerCase()}`
    const prev = merged.get(key)
    if (!prev) { merged.set(key, { ...line, mergedIds: [line.id] }); continue }
    prev.quantity = (prev.quantity ?? 0) + (line.quantity ?? 0)
    prev.isFirst = prev.isFirst || line.isFirst
    prev.mergedIds.push(line.id)
  }
  const included = [...merged.values()]

  const byCrop = new Map()
  for (const line of included) {
    const key = line.crop || ''
    if (!byCrop.has(key)) byCrop.set(key, [])
    byCrop.get(key).push(line)
  }

  const groups = []
  const singles = []
  for (const [crop, group] of byCrop) {
    const distinct = new Set(group.map((l) => l.name.toLowerCase()).filter(Boolean)).size
    if (crop && distinct >= groupThreshold) groups.push({ crop, lines: group })
    else singles.push(...group)
  }

  // Largest group first (matches both reference posts), then the flat tail.
  groups.sort((a, b) => b.lines.length - a.lines.length || a.crop.localeCompare(b.crop))
  // Within a group, interest before volume: his own posts lead with the single first-harvest, not
  // the biggest number, and a first pushed to the bottom of a long group falls below the fold.
  for (const g of groups) {
    g.lines.sort((a, b) => (b.isFirst ? 1 : 0) - (a.isFirst ? 1 : 0) || (b.quantity ?? 0) - (a.quantity ?? 0))
  }
  singles.sort((a, b) => (b.isFirst ? 1 : 0) - (a.isFirst ? 1 : 0) || (b.quantity ?? 0) - (a.quantity ?? 0))

  const lineCount = included.length
  return { groups, singles, lineCount, overCap: lineCount > LINE_SOFT_CAP }
}

// Final post text. `lead` is Dave's — this function never writes prose, and an absent lead simply
// means the post opens with the list.
export function renderPost(model, options = {}) {
  const { lead = '', annotations = {} } = options
  const out = []
  const leadText = String(lead || '').trim()
  if (leadText) out.push(leadText, '')

  const decorate = (line) => {
    const parts = [renderLine(line, { withCrop: false })]
    const notes = []
    if (line.isFirst) notes.push('1st harvest!')
    const extra = String(annotations[line.id] || '').trim()
    if (extra) notes.push(extra)
    return notes.length ? `${parts[0]} (${notes.join(', ')})` : parts[0]
  }

  for (const g of model.groups) {
    out.push(`${pluralizeCrop(g.crop, 2)}:`)
    for (const line of g.lines) out.push(`  ${decorate(line)}`)
  }
  if (model.groups.length && model.singles.length) out.push('')
  for (const line of model.singles) {
    const base = renderLine(line, { withCrop: true })
    const notes = []
    if (line.isFirst) notes.push('1st harvest!')
    const extra = String(annotations[line.id] || '').trim()
    if (extra) notes.push(extra)
    out.push(notes.length ? `${base} (${notes.join(', ')})` : base)
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

// Per-crop season totals, read from the aggregates block of GET /api/harvests.
//
// BUG-COMPOSETOTALS-001 — never sum the ENTRIES array: it is keyset-paginated at 50 rows, so the
// total is wrong and, with the page boundary inside a day ordered by UUID, changes between loads. The
// endpoint already computes the correct figure over the FULL range with no cursor and no limit.
export function seasonCountsByCrop(aggregates) {
  const out = new Map()
  for (const c of aggregates?.crops ?? []) {
    const name = c.crop_name || c.crop_type_slug
    const counted = (c.units ?? []).find((u) => u.unit_key === 'count')
    if (name && counted && Number.isFinite(Number(counted.total))) out.set(name, Number(counted.total))
  }
  return out
}

// Facts Dave currently computes in his head, handed to him as material for the lead paragraph.
// Deliberately NOT prose — a generated sentence in his voice is worse than no lead at all.
//
// `seasonCounts` is a Map(cropName -> count) from seasonCountsByCrop, and `windowLabel` names the
// span those totals cover. The label is REQUIRED and unabbreviated in the emitted chip: "N so far"
// reads as season-to-date while the window is a few days, and a chip that ships into a public post
// has to say what it counted.
export function leadFacts(batch, seasonCounts, windowLabel = 'this season') {
  const items = batch?.items ?? []
  const counted = items.filter((e) => POSTABLE_UNITS.has(e.unit) && Number(e.quantity) > 0)
  const total = counted.reduce((s, e) => s + Number(e.quantity), 0)
  const varieties = new Set(counted.map((e) => e.planting_name || e.variety_name).filter(Boolean)).size

  // Per-crop batch totals, so each season figure is compared against ITS OWN crop rather than the
  // cross-crop batch sum (incomparable aggregates).
  const batchByCrop = new Map()
  for (const e of counted) {
    const c = e.crop_name || e.crop_type_slug
    if (c) batchByCrop.set(c, (batchByCrop.get(c) || 0) + Number(e.quantity))
  }

  const facts = []
  if (total > 0) facts.push(`${total} picked tonight`)
  if (varieties > 1) facts.push(`${varieties} varieties`)

  const counts = seasonCounts instanceof Map ? seasonCounts : new Map()
  for (const [crop, batchQty] of batchByCrop) {
    const n = counts.get(crop)
    if (n && n > batchQty) facts.push(`${n} ${pluralizeCrop(crop, n).toLowerCase()} ${windowLabel}`)
  }

  return facts
}
