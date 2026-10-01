// src/components/recipes/recipes.js
// Put-Up release 4 (V4 §2.6, §3.1–§3.2, "pH"; F §1.5; recipe types and the final container per Dave
// 2026-09-30) — the PURE half of the recipe library: the words a recipe surface says, the one request body
// the sheet sends, what "Make this" / "Made it as written" / "I made this" write, and the recipe rung of the
// Put it up preview. The .jsx siblings paint these; they decide nothing a test cannot pin here.
//
// The body rules are the Lambda's own (lambda/preservation/recipeRules.js is dependency-free and imported
// here, the way putItUp.js imports shelfLife.js), so a body the server would refuse is caught here with the
// same words and there is no second copy to drift.
//
// ⚠ pH (V4 "pH"). His target pH lives in `notes`, which only recipe detail renders, verbatim. Nothing here
// reads, parses, labels or compares a number out of the notes, and no surface but recipe detail is handed
// them (the batch-facing read carries no notes at all).
//
// ⚠ Banned words (V4 §3.2, swept on the Put-Up surfaces): the keeps line is worded by place and length
// ("Fridge · 7 days"), never by the column's own name.
import * as engine from '../../../lambda/preservation/shelfLife.js'
import {
  linkUrlError, keepsError, recipeLineError, RECIPE_STORAGE_KINDS, RECIPE_NAME_MAX, RECIPE_TYPE_LABEL_MAX,
} from '../../../lambda/preservation/recipeRules.js'
import { KITCHEN_UNITS } from '../../../lambda/preservation/kitchenBatch.js'
import { shortDay, basisWords, ESTIMATED_PRECISIONS } from '../putup/jarWords.js'
import { newRow } from '../putup/putItUp.js'
import { describeOutcome } from '../putup/batchClose.js'
import { KIND_CHIPS } from '../kitchen/KindChips.jsx'
import { mintKey } from '../kitchen/idempotencyKey.js'

export { RECIPE_STORAGE_KINDS, RECIPE_NAME_MAX, RECIPE_TYPE_LABEL_MAX, KITCHEN_UNITS }

// ── words ────────────────────────────────────────────────────────────────────────────────────────
export const RECIPES_SEGMENT_LABEL = 'Recipes'
export const NEW_RECIPE_CTA = 'New recipe'
export const MAKE_THIS_CTA = 'Make this'
// Put-Up UX pass R1: the button says what it will do, and its confirm says where nothing goes. "Kept some?"
// starts a batch the way Make this does — there is no batch yet to put up.
export const I_MADE_THIS_CTA = 'Made it, ate it all'
export const MADE_CONFIRM_TEXT = 'Logs a make of this for today, every line as written. Nothing goes into the Pantry.'
export const MADE_CONFIRM_CTA = 'Log this make'
export const KEPT_SOME_CTA = 'Kept some? Start a batch instead →'
export const MADE_AS_WRITTEN_CTA = 'Made it as written'
export const SAVE_AS_RECIPE_CTA = 'Save as recipe'
export const FOLLOWING_QUESTION = 'Following a recipe?'
export const NEW_TYPE_CTA = 'New type…'
// "Made it, ate it all" is a make with nothing kept (V4 §2.2): recorded as eaten ('consumed', "Ate it").
export const NOTHING_KEPT_OUTCOME = 'consumed'

// The recipe sheet's words (UX pass R1). Two pickers, each saying what it is for; a line asks for its name
// and the amount as he would write it, and keeps the exact number behind one tap.
export const TYPE_LABEL = 'What it makes'
export const TYPE_HELP = 'Groups it in your recipe list.'
export const MORE_TYPES_CTA = 'More types…'
export const KIND_LABEL = "How it's made"
export const KIND_HELP = 'The kind of batch Make this starts.'
export const LINE_NAME_LABEL = 'Name'
export const LINE_AMOUNT_LABEL = "Amount as you'd write it"
export const AT_THE_END_LABEL = 'at the end'
export const EXACT_AMOUNT_CTA = '▸ exact amount'
export const KEEPS_LABEL = 'How long, and where'
export const KEEPS_N_LABEL = 'How many'
export const MORE_PLACES_CTA = 'More…'
export const COOKED_LABEL = 'Cooked after blending'

export const STORAGE_KIND_WORDS = Object.freeze({
  deep_freezer: 'Deep freezer', fridge_freezer: 'Fridge freezer', fridge: 'Fridge', pantry: 'Pantry shelf',
  cold_storage: 'Cellar', other: 'Counter',
})
export const KEEPS_UNIT_WORDS = Object.freeze({ day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'] })

// "Fridge · 7 days". null when the recipe has no such line.
export function keepsWords(r) {
  if (!r || r.keeps_n == null || !r.keeps_unit || !r.keeps_storage_kind) return null
  const n = Number(r.keeps_n)
  const unit = KEEPS_UNIT_WORDS[r.keeps_unit]
  const place = STORAGE_KIND_WORDS[r.keeps_storage_kind]
  if (!Number.isFinite(n) || !unit || !place) return null
  return `${place} · ${n} ${n === 1 ? unit[0] : unit[1]}`
}

const num = (v) => (v == null || v === '' ? null : String(v))
// "1 qt quart jar", "4 fl oz · 4 oz woozy" — a container as its name and size, whichever are known.
export function containerWords(label, size, unit, count = null) {
  const sized = size != null && unit ? `${num(size)} ${unit}` : null
  const name = label && String(label).trim() ? String(label).trim() : null
  const main = name && sized && !name.toLowerCase().includes(num(size)) ? `${name} (${sized})` : (name ?? sized)
  if (!main) return null
  return count != null && Number(count) > 1 ? `${Number(count)} × ${main}` : main
}

// The process jar and the final container, in one line each (Dave 2026-09-30: a make can be multi-vessel).
export function vesselWords(r) { return r ? containerWords(r.vessel_label, r.vessel_size, r.vessel_unit, r.vessel_count) : null }
export function bottleWords(r) {
  const c = r ? containerWords(r.bottle_label, r.bottle_size, r.bottle_unit) : null
  if (!c) return null
  return r.bottle_cooked === true ? `${c} · cooked after blending` : c
}

// A line as reference text: the amount AS WRITTEN when there is one, else "qty unit name".
export function recipeLineWords(l) {
  if (!l) return ''
  const written = l.amount_text && String(l.amount_text).trim()
  const name = l.name && String(l.name).trim()
  // The amount as written carries the ingredient's name for seeded lines ("150 g Megatron jalapeño") but not for
  // one typed on the recipe sheet ("4 cloves", name "Garlic") — so the name leads unless the amount already says it.
  const base = written
    ? (name && !written.toLowerCase().includes(name.toLowerCase()) ? `${name} — ${written}` : written)
    : [l.qty != null && l.qty_unit ? `${num(l.qty)} ${l.qty_unit}` : null, l.name].filter(Boolean).join(' ')
  const extra = [l.brand, l.note && !written ? l.note : null].filter(Boolean)
  return extra.length ? `${base} (${extra.join(', ')})` : base
}

// How many put-ups a batch made, in the closed list's own words ("put-up", never "jar": most methods make no
// jar). output_count is an uncast count and arrives as a STRING, so Number() first. null when there are none.
function putUpCountWords(b) {
  const n = Number(b?.output_count)
  if (!Number.isFinite(n) || n <= 0) return null
  return n === 1 ? '1 put-up' : `${n} put-ups`
}

// A batch made from the recipe, dated, with its ending in plain words at equal weight — never a reading.
// Returns { when, ending } strings. The ending is batchClose.js's own label with the count after it; the one
// label the count already says ("Put it up", when put-ups follow) is left out, so the row reads
// "Mojo Oct · Oct 2 · 6 put-ups" and not an instruction (UX pass R1; the closed list drops it the same way).
export function madeBatchWords(b, now = new Date()) {
  const at = b?.started_at ?? b?.first_recorded_at ?? null
  const when = at ? shortDay(at, now) : 'date not recorded'
  let ending
  if (b?.closed_at || b?.outcome) {
    const count = putUpCountWords(b)
    ending = b.outcome === 'put_up' && count ? count : [describeOutcome(b) ?? 'finished', count].filter(Boolean).join(' · ')
  } else if (b?.suspended_at) ending = 'paused'
  else ending = 'still going'
  return { when, ending }
}

// ── the notes, as recipe detail SHOWS them ───────────────────────────────────────────────────────
// DISPLAY ONLY. The stored text, the sheet's textarea and the save body are his text verbatim and never
// pass through here. A pair of marks around a run of words on ONE line shows as bold (two asterisks each
// side) or italic (one each side) with the marks hidden; every other asterisk prints exactly as typed.
// The rule for a pair is narrow on purpose, so arithmetic and bullets are never read as marks:
//   · the opening mark starts the line or follows a space or punctuation, and a word follows it at once;
//   · the closing mark follows a word at once, and ends the line or is followed by a space or punctuation;
//   · both sit on the same line, with at least one character between them.
// So "2 * 3 cups", "2*3*4", a "* " bullet, a lone mark and a pair split by a line break all stay as typed.
// Marks do not nest: inside a bold run a single asterisk is text.
// Returns [{ kind: 'plain' | 'bold' | 'italic', text }], in order; putting the marks back round each bold
// and italic run and joining gives the input again, character for character.
const WORD_CHAR = /[\p{L}\p{N}]/u
const atEdge = (c) => c === undefined || (c !== '*' && !WORD_CHAR.test(c))
const startsRun = (c) => c !== undefined && c !== '*' && !/\s/.test(c)
const MARKS = [['**', 'bold'], ['*', 'italic']]
function markedRunAt(line, i) {
  if (line[i] !== '*' || !atEdge(line[i - 1])) return null
  for (const [mark, kind] of MARKS) {
    const w = mark.length
    if (!line.startsWith(mark, i) || !startsRun(line[i + w])) continue
    for (let j = line.indexOf(mark, i + w + 1); j !== -1; j = line.indexOf(mark, j + 1)) {
      if (startsRun(line[j - 1]) && atEdge(line[j + w])) return { kind, text: line.slice(i + w, j), end: j + w }
    }
  }
  return null
}
export function notesSegments(notes) {
  const out = []
  let plain = ''
  const flush = () => { if (plain) { out.push({ kind: 'plain', text: plain }); plain = '' } }
  const lines = (notes == null ? '' : String(notes)).split('\n')
  lines.forEach((line, n) => {
    let i = 0
    while (i < line.length) {
      const run = markedRunAt(line, i)
      if (run) { flush(); out.push({ kind: run.kind, text: run.text }); i = run.end } else { plain += line[i]; i += 1 }
    }
    if (n < lines.length - 1) plain += '\n'
  })
  flush()
  return out
}

// The kind vocabulary a recipe takes is the batch-kind vocabulary (chk_recipe_kind).
export const RECIPE_KIND_OPTIONS = KIND_CHIPS

// ── types ────────────────────────────────────────────────────────────────────────────────────────
// Built-ins first (in their order), then the household's by name — the server's own order, restated so a
// list that arrives out of order still reads the same.
export function sortTypes(types) {
  return [...(types ?? [])].sort((a, b) => (b.builtin === true) - (a.builtin === true)
    || (a.builtin ? (a.sort_order ?? 0) - (b.sort_order ?? 0) : String(a.label).localeCompare(String(b.label))))
}

// The type chips of the recipe sheet (UX pass R1): { front, rest }. `front` is what shows at open — the type
// the picker opened on (`pinned`), then the types this household's recipes already use (`usedIds`); `rest`
// is every other type, behind "More types…". Both keep sortTypes' order, and `pinned` is the value at OPEN,
// not the live one, so a chip never moves under a finger when another is tapped.
export function typeChips({ types, pinned = null, usedIds = [] } = {}) {
  const list = sortTypes(types)
  const used = new Set(usedIds ?? [])
  const front = [...list.filter(t => t.id === pinned), ...list.filter(t => t.id !== pinned && used.has(t.id))]
  return { front, rest: list.filter(t => t.id !== pinned && !used.has(t.id)) }
}

// The list grouped by type: [{ key, label, recipes }], types in built-in order then by name, "No type" last.
export function groupByType(recipes) {
  const groups = new Map()
  for (const r of recipes ?? []) {
    const key = r.recipe_type_id ?? 'none'
    if (!groups.has(key)) groups.set(key, { key, label: r.type_label ?? 'No type', sort: r.type_sort ?? null, recipes: [] })
    groups.get(key).recipes.push(r)
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === 'none') return 1
    if (b.key === 'none') return -1
    const as = a.sort ?? 1e9; const bs = b.sort ?? 1e9
    return as - bs || a.label.localeCompare(b.label)
  }).map(g => ({ ...g, recipes: [...g.recipes].sort((x, y) => String(x.name).localeCompare(String(y.name))) }))
}

// ── the sheet's draft and its ONE body ───────────────────────────────────────────────────────────
export const EMPTY_LINE = Object.freeze({ name: '', amount: '', qty: '', unit: '', atTheEnd: false })
export function emptyDraft() {
  return {
    key: '', name: '', typeId: null, kind: null, link: '', notes: '',
    keepsN: '', keepsUnit: 'day', keepsKind: '',
    vesselLabel: '', vesselSize: '', vesselUnit: '', vesselCount: '',
    bottleLabel: '', bottleSize: '', bottleUnit: '', bottleCooked: false, madeText: '',
    lines: [],
  }
}

export function draftFromRecipe(r) {
  const d = emptyDraft()
  if (!r) return d
  const s = (v) => (v == null ? '' : String(v))
  return {
    ...d, name: s(r.name), typeId: r.recipe_type_id ?? null, kind: r.kind ?? null, link: s(r.link_url), notes: s(r.notes),
    keepsN: s(r.keeps_n), keepsUnit: r.keeps_unit ?? 'day', keepsKind: r.keeps_storage_kind ?? '',
    vesselLabel: s(r.vessel_label), vesselSize: s(r.vessel_size), vesselUnit: s(r.vessel_unit), vesselCount: s(r.vessel_count),
    bottleLabel: s(r.bottle_label), bottleSize: s(r.bottle_size), bottleUnit: s(r.bottle_unit), bottleCooked: r.bottle_cooked === true,
    madeText: s(r.made_text),
    lines: (r.lines ?? []).map(l => ({ name: s(l.name), amount: s(l.amount_text), qty: s(l.qty), unit: s(l.qty_unit), atTheEnd: l.at_the_end === true, _keep: l })),
  }
}

const t = (v) => String(v ?? '').trim()

// "▸ exact amount" (a line's number and unit) opens by itself when the amount as written starts with a
// digit, and stays open while the line holds a number or a unit — what Save will send is never off screen.
// The amount is not parsed: "Made it as written" weighs a line only from the number and unit typed here.
export function exactAmountOpens(line) {
  return /^\s*\d/.test(String(line?.amount ?? '')) || t(line?.qty) !== '' || t(line?.unit) !== ''
}

// The place chips of "How long, and where": { chips, more }. The three most recipes name come first; a
// kind the recipe already holds (`stored`) or the sheet has chosen (`value`) is ALWAYS among the chips, so
// a recipe kept in a cellar never opens with nothing chosen; the others sit behind "More…" until it is
// opened. All six of the Lambda's kinds are reachable, and none is merged into another: the recipe's date
// applies to a jar only at a place of exactly this kind.
export const KEEPS_COMMON_KINDS = Object.freeze(['fridge', 'deep_freezer', 'pantry'])
export function keepsKindChips({ value = '', stored = '', moreOpen = false } = {}) {
  const chips = [...KEEPS_COMMON_KINDS]
  for (const k of [stored, value]) if (RECIPE_STORAGE_KINDS.includes(k) && !chips.includes(k)) chips.push(k)
  const more = RECIPE_STORAGE_KINDS.filter(k => !chips.includes(k))
  return moreOpen ? { chips: [...chips, ...more], more: [] } : { chips, more }
}

// The facts a sheet line does not edit (form, brand, role, heat, salt facts) ride through untouched when the
// line came from the recipe and its name and amounts were not changed; otherwise the line is what was typed.
function lineBody(l, i) {
  const out = { ordinal: i + 1, name: t(l.name) }
  const amount = t(l.amount)
  if (amount) out.amount_text = amount
  const qty = t(l.qty)
  // A number and its unit travel together; either one alone is sent as typed so the line rule names it.
  if (qty !== '') out.qty = qty
  if (t(l.unit)) out.qty_unit = t(l.unit)
  if (l.atTheEnd === true) out.at_the_end = true
  const k = l._keep
  if (k && t(k.name) === out.name && num(k.qty) === (out.qty ?? null) && (k.qty_unit ?? null) === (out.qty_unit ?? null)) {
    for (const f of ['form', 'brand', 'role', 'note', 'shu_rating_low', 'shu_rating_high', 'salt_pct', 'salt_base', 'base_g', 'salt_method', 'base_from']) {
      if (k[f] != null) out[f] = k[f]
    }
  }
  return out
}

// { body } or { error, field }. `mode` 'create' carries the key and leaves blanks out; 'edit' sends every
// field the sheet shows (an emptied field is a cleared column — the PATCH is presence-sentinel).
export function recipeBody(d, { mode = 'create' } = {}) {
  const name = t(d.name)
  if (!name) return { error: 'Give it a name.', field: 'name' }
  if (name.length > RECIPE_NAME_MAX) return { error: `A name can be at most ${RECIPE_NAME_MAX} characters.`, field: 'name' }
  const link = t(d.link)
  if (link) {
    const e = linkUrlError(link)
    if (e) return { error: 'A link has to start with http:// or https://.', field: 'link' }
  }
  const notes = String(d.notes ?? '')
  let keeps = null
  if (t(d.keepsN) !== '' || t(d.keepsKind) !== '') {
    keeps = { n: Number(t(d.keepsN)), unit: d.keepsUnit, storage_kind: t(d.keepsKind) }
    if (keepsError(keeps)) return { error: 'Say how long (a whole number) and where — or leave both empty.', field: 'keeps' }
  }
  const lines = (d.lines ?? []).filter(l => t(l.name) || t(l.amount)).map((l, i) => lineBody({ ...l, name: t(l.name) || t(l.amount) }, i))
  for (const [i, l] of lines.entries()) {
    const e = recipeLineError(l, `line ${i + 1}`)
    if (e) return { error: e.replace(/^line (\d+): /, 'Line $1: '), field: 'lines', row: i }
  }
  const pair = (size, unit, what) => {
    const s = t(size); const u = t(unit)
    if (!s && !u) return { size: null, unit: null }
    if (!s || !u || !(Number(s) > 0)) return { error: `The ${what} size needs a number and a unit — or leave both empty.` }
    return { size: s, unit: u }
  }
  const vessel = pair(d.vesselSize, d.vesselUnit, 'jar')
  if (vessel.error) return { error: vessel.error, field: 'vessel' }
  const bottle = pair(d.bottleSize, d.bottleUnit, 'bottle')
  if (bottle.error) return { error: bottle.error, field: 'bottle' }
  const count = t(d.vesselCount)
  if (count && !(Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= 50)) {
    return { error: 'How many jars: a whole number, 1 to 50.', field: 'vessel' }
  }
  const all = {
    name, kind: d.kind ?? null, recipe_type_id: d.typeId ?? null,
    link_url: link || null, notes: notes.trim() ? notes : null, keeps,
    vessel_label: t(d.vesselLabel) || null, vessel_size: vessel.size, vessel_unit: vessel.unit,
    vessel_count: count ? Number(count) : null,
    bottle_label: t(d.bottleLabel) || null, bottle_size: bottle.size, bottle_unit: bottle.unit,
    bottle_cooked: d.bottleCooked === true ? true : null,
    made_text: t(d.madeText) || null,
    lines,
  }
  if (mode === 'edit') return { body: all }
  const body = { idempotency_key: d.key || mintKey() }
  for (const [k, v] of Object.entries(all)) {
    if (k === 'lines' ? v.length : v != null) body[k] = v
  }
  return { body }
}

// ── Make this / Made it as written / I made this ─────────────────────────────────────────────────
// The Start sheet's prefill: the label, the kind (when it is a kind the chips offer) and the recipe it follows.
export function startPrefill(r) {
  if (!r) return null
  const kind = KIND_CHIPS.some(c => c.value === r.kind) ? r.kind : null
  return { label: String(r.name ?? '').slice(0, 120), kind, recipeId: r.id, recipeName: r.name ?? '' }
}

// The batch's process jar from the recipe (the merge PUT's keys), or null when the recipe names none.
export function vesselPatch(r) {
  if (!r) return null
  const out = {}
  if (r.vessel_label) out.vessel_label = r.vessel_label
  if (r.vessel_size != null && r.vessel_unit) { out.vessel_size = String(r.vessel_size); out.vessel_unit = r.vessel_unit }
  if (r.vessel_count != null) out.vessel_count = Number(r.vessel_count)
  return Object.keys(out).length ? out : null
}

// F's line POST refuses salt_base 'peppers' (a 1b word) — such facts stay on the recipe, not the batch.
const LINE_SALT_BASES = new Set(['produce', 'water', 'all'])
// "Made it as written": every line (by default the pot lines — `at the end` lines go in at the bottling)
// as a keyed typed line, amounts asserted. An amount written with no number rides as the line's note.
export function asWrittenLines(r, { includeAtTheEnd = false } = {}) {
  const out = []
  for (const l of r?.lines ?? []) {
    if (l.at_the_end && !includeAtTheEnd) continue
    const body = { input_kind: 'other', idempotency_key: mintKey(), label: String(l.name).trim() }
    const hasQty = l.qty != null && l.qty_unit
    if (hasQty) { body.qty = String(l.qty); body.qty_unit = l.qty_unit }
    const note = [!hasQty && l.amount_text ? String(l.amount_text).trim() : null, l.note ? String(l.note).trim() : null].filter(Boolean).join(' · ')
    if (note) body.note = note
    if (l.brand) body.brand = l.brand
    if (l.role) body.role = l.role
    else if (l.form) body.form = l.form
    if (!l.role && l.shu_rating_low != null) { body.shu_rating_low = l.shu_rating_low; if (l.shu_rating_high != null) body.shu_rating_high = l.shu_rating_high }
    if (l.role === 'salt' && hasQty && l.salt_pct != null && LINE_SALT_BASES.has(l.salt_base)) {
      Object.assign(body, { salt_pct: String(l.salt_pct), salt_base: l.salt_base, base_g: String(l.base_g) })
      if (l.salt_method) body.salt_method = l.salt_method
      if (l.base_from) body.base_from = l.base_from
    }
    if (l.role === 'salt' && l.salt_method && !body.salt_method) body.salt_method = l.salt_method
    out.push(body)
  }
  return out
}

// ── Put it up with a recipe: the first row's defaults and the recipe rung of the preview ───────────
// The first row takes the recipe's final container and "cooked after blending" as DEFAULTS the person can
// change (Dave 2026-09-30). Rows 2..N inherit from row 1 as they always do.
export function recipeFirstRow(r) {
  const row = newRow()
  if (!r) return row
  if (r.bottle_label || (r.bottle_size != null && r.bottle_unit)) {
    row.container = {
      label: r.bottle_label || `${num(r.bottle_size)} ${r.bottle_unit}`,
      size_value: r.bottle_size != null && r.bottle_unit ? Number(r.bottle_size) : null,
      size_unit: r.bottle_size != null && r.bottle_unit ? r.bottle_unit : null,
    }
  }
  if (r.bottle_cooked === true) row.cooked = true
  return row
}

// V4 §3.1's second rung, for the preview line before Save: typed rows are the shipped preview's; a row at a
// place of the recipe's storage kind shows the recipe's date, worded "from the recipe: <name>" with no
// duration (§3.2). null = the recipe does not decide this row (the caller shows the engine's preview).
export function recipePreview({ row, when, recipe, now = new Date() }) {
  if (!recipe || !when?.date || row?.discard?.mode === 'none' || row?.discard?.mode === 'date') return null
  const res = engine.recipeUseBy(recipe, row?.place?.kind ?? null, String(when.date).slice(0, 10), { precision: when.precision })
  if (!res) return null
  const day = shortDay(res.use_by_target, now)
  const shown = ESTIMATED_PRECISIONS.has(when.precision) ? `around ${day}` : day
  return {
    date: res.use_by_target, basis: 'recipe',
    words: `discard by ${shown} · ${basisWords('recipe', { recipeName: recipe.name })}`,
  }
}
