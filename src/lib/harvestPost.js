// harvestPost.js — V4-COMPOSEPOST-001. Turns the /api/harvests read model into a Facebook-ready
// harvest post. PURE: no React, no network, no clock — every time input is passed in. Mirrors the
// lambda/harvests/aggregate.js split so it unit-tests with zero runtime deps.
//
// WHY A BATCH AND NOT A DAY (crucible 2026-08-10, measured against prod, 469 gaps / 30 days):
// Dave's posts correspond to ONE evening logging session, not a calendar day. On 2026-08-05 he
// logged 31 picks and posted 19 — the berry/herb/cup-unit picks logged earlier that day were
// deliberately omitted. Clustering by created_at gap reproduces that split exactly (9 items at
// 10:25, 3 at 12:09, 19 at 23:08 = 31). A "today's harvest" summary is measurably noisier than
// what he actually writes, which is why this file exists at all.
//
// WHY 45 MINUTES: the gap distribution has a near-empty valley from 30–90 min, and BOTH reference
// batches reproduce identically at every threshold from 20 to 240 min — so this is the middle of a
// wide plateau, not a tuned constant. 90 was rejected because it merges long grazing sessions (the
// 08-08 batch spans 131 min held together entirely by sub-90m internal gaps → one 32-item post).
//
// WHY (created_by, created_at) AND NOT created_at ALONE: Jen is a real second logger. Overlapping
// evening sessions would otherwise merge into one "batch" published in Dave's first person.
//
// WHY created_at AND NOT event_date: event_date is date-grained by construction — 482 of 504 rows
// sit at exactly 08:00 ET (a DST-safe date-at-noon encoding) — so it cannot order within a day.

export const DEFAULT_GAP_MINUTES = 45

// A crop gets its own heading only at >= 3 distinct varieties. Ground truth: Dave's 2026-08-06 post
// lists Cubanelle and Piri Piri — two distinct pepper varieties — as FLAT lines with no "Peppers:"
// heading, so a >=2 rule would emit a heading he did not write. 3 reproduces both reference posts.
export const DEFAULT_GROUP_THRESHOLD = 3

// Past ~15 lines the tail falls below Facebook's "See more" fold, so the crops added last become
// invisible. Advisory only — the UI warns, it never truncates. Never silently drop a harvested item.
export const LINE_SOFT_CAP = 15

// Only `count` renders. Weight is 73.5% server-ESTIMATED and must never appear in a public post.
// 2026 unit distribution: count 404, cup 87, head 5, bunch 3 — and both reference batches are 100%
// count, so this drops nothing Dave actually posted.
const POSTABLE_UNITS = new Set(['count'])

// Validated against the live cultivar corpus. ' Roma' is deliberately ABSENT: "San Marzano Roma" is
// a legitimate full variety name that appears in both reference batches, and stripping it would
// silently rename a crop in a public post.
const STRIP_SUFFIXES = [' F1', ' (Burpee)', ' Heirloom']

// Evidence-backed shortenings, taken verbatim from Dave's published post text (2026-08-05 and
// 2026-08-06) where the DB name and the name he actually writes differ. This is the "small override
// table" the crucible asked for, seeded ONLY from posts we can read — not from guesses. ' Roma' is
// here as a per-name override rather than a blanket suffix strip because "San Marzano Roma" is a
// legitimate full variety name; the evidence is that Dave shortens THIS one, not that the suffix is
// generally droppable.
export const NAME_OVERRIDES = {
  'san marzano roma': 'San Marzano',
  "czech's bush": 'Czech Bush',
  'chilly chill': 'Chilly Chills',
}

// Cultivar/planting names carrying identification uncertainty must never publish as-is. These are
// real values in prod ("Onion — scallion-type (thick blue-green, ID pending)").
const UNCERTAIN_NAME = /\b(id pending|unknown variety|unknown|tbd)\b|\(.*\?\s*\)/i

// Crops with no distinct plural. "squash" is the one that bites — Dave writes "3 Zephyr squash".
const INVARIANT_PLURALS = new Set([
  'squash', 'greens', 'lettuce', 'kale', 'spinach', 'chard', 'basil', 'corn', 'garlic', 'broccoli',
])

// Nouns ending in -o are irregular in English and no rule separates them: tomato -> tomatoes but
// tomatillo -> tomatillos. Enumerate rather than guess; a wrong plural ships in a public post.
const O_TAKES_ES = new Set(['tomato', 'potato', 'hero'])

export function pluralizeCrop(word, qty) {
  const w = String(word || '').trim()
  if (!w || Number(qty) === 1) return w
  const lower = w.toLowerCase()
  if (INVARIANT_PLURALS.has(lower)) return w
  if (O_TAKES_ES.has(lower)) return `${w}es`
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`
  return `${w}s`
}

// Strip-only. NEVER spell-correct, title-case, or expand: Dave wrote "Grandadero" for the DB's
// "Granadero" and `1 "beefsteak"` in scare quotes, and that idiosyncrasy is what reads as human.
// A resolver that "fixes" him publishes a correction he did not ask for.
export function normalizeVarietyName(raw) {
  let n = String(raw || '').trim()
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
  const override = NAME_OVERRIDES[n.toLowerCase()]
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
    const qty = Number(e.quantity)
    return {
      id: e.event_id,
      name,
      crop,
      quantity: Number.isFinite(qty) ? qty : null,
      unit: e.unit ?? null,
      // Dave's OWN marking, not a computed guess. A window function over plant_id contradicts him
      // in both directions on the reference posts — it says Piri Piri's first was 2026-08-05 while
      // his 08-06 post calls it a first, and it flags Armageddon as a first on the exact row he
      // hand-annotated "not 1st harvest". So this is only ever pre-checked from his event type.
      isFirst: e.event_type === 'first_harvest',
      // Suggestion, never finished copy: he REWRITES these ("Fell off plant with major blotch" ->
      // "(fell from plant w/ deformity, not 1st harvest)"). The UI offers it; it is not auto-emitted.
      noteSuggestion: e.note_excerpt || '',
      needsName: !name,
      uncertainName: uncertain,
      postable: POSTABLE_UNITS.has(e.unit) && Number.isFinite(qty) && qty > 0,
    }
  })
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
  if (cropIsSingleWord && new RegExp(`\\s${crop}$`, 'i').test(name)) {
    return `${qty} ${name.replace(new RegExp(`\\s${crop}$`, 'i'), ` ${plural}`)}`
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
  const included = (Array.isArray(lines) ? lines : []).filter((l) => l && l.include !== false && l.postable)

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

// Facts Dave currently computes in his head, handed to him as material for the lead paragraph.
// Deliberately NOT prose — a generated sentence in his voice is worse than no lead at all.
export function leadFacts(batch, allEntries) {
  const items = batch?.items ?? []
  const counted = items.filter((e) => POSTABLE_UNITS.has(e.unit) && Number(e.quantity) > 0)
  const total = counted.reduce((s, e) => s + Number(e.quantity), 0)
  const varieties = new Set(counted.map((e) => e.planting_name || e.variety_name).filter(Boolean)).size
  const crops = new Set(counted.map((e) => e.crop_name || e.crop_type_slug).filter(Boolean))

  const facts = []
  if (total > 0) facts.push(`${total} picked tonight`)
  if (varieties > 1) facts.push(`${varieties} varieties`)

  // Season totals per crop, from whatever window the caller loaded. Labelled by the caller, not here.
  const seasonByCrop = new Map()
  for (const e of Array.isArray(allEntries) ? allEntries : []) {
    if (!POSTABLE_UNITS.has(e.unit)) continue
    const c = e.crop_name || e.crop_type_slug
    const q = Number(e.quantity)
    if (!c || !Number.isFinite(q)) continue
    seasonByCrop.set(c, (seasonByCrop.get(c) || 0) + q)
  }
  for (const crop of crops) {
    const n = seasonByCrop.get(crop)
    if (n && n > total) facts.push(`${n} ${pluralizeCrop(crop, n).toLowerCase()} so far`)
  }

  return facts
}
