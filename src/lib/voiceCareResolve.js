// src/lib/voiceCareResolve.js
// V5-VOICECARE-001 — turn a spoken bulk care command into an EXACT set of plantings, or refuse.
//
// voiceCareGrammar.js answers "is this a care command and what are its parts"; this file answers
// "which plantings does it mean". It implements rules R0–R7 of the Resolution contract in
// Projects/Gardening/_roadmapexec_20260916/lane-G-voicecare-hostres.md, with Dave's three decisions
// of 2026-09-16 applied:
//   Q-A  the scope is EVERY live planting in the named area (Log Many's `space` meaning), not
//        today's care list — so S is the batch dry-run for that location.
//   Q-B  the go-ahead after the read-back is an explicit spoken "next", the harvest save word.
//        Silence or anything else cancels. careConfirmDecision() below.
//   Q-C  a fuzzy-matched skip name is SAID inside the read-back with what was heard, and still
//        waits for "next". It is never applied silently and never refused just for being fuzzy.
//
// PURE. No fetch, no clock, no randomness: the host (or voiceCareBatch.js) runs the dry run and hands
// its result in as `scopeSet`. That is what lets every rule below be pinned by a unit test against
// the real vocabulary shape.
//
// ── THE ASYMMETRY EVERY RULE SERVES ─────────────────────────────────────────────────────────────
// A care batch writes MANY rows and a wrong or missing exclusion looks exactly like success — the
// plant he meant to skip simply looks fed. Harvest voice can be permissive because a wrong harvest
// row is one visible row. So here: the scope never goes through fuzzy matching (a wrong area is the
// biggest possible blast radius), any doubt about any name refuses the WHOLE command, and the
// read-back names every skipped plant by the name the app RESOLVED, because a count alone ("skipping
// 3") hides a lost or swapped name unless he is counting (design §2h).
//
// ── REUSED, NOT RE-DERIVED ──────────────────────────────────────────────────────────────────────
//   looseKey            comboboxInput.js    — the shared voice-forgiving key; voiceKey wraps it
//   resolveAlias        voiceAliases.js     — the learned-mishearing layer, unchanged
//   fuzzyMatch          voiceFuzzyMatch.js  — the closed-set scorer, called with looseKey exactly as
//                                             harvest calls it, so its measured thresholds still mean
//                                             what they were measured to mean
//   foldNumberWords     voiceHarvestGrammar.js — the harvest order's number-word layer
//   classify            voiceHarvestGrammar.js — "next" is whatever harvest saves on (Q-B)
// careTerms() is the one local copy: it must equal VoiceHarvest.jsx's plantingAliases(), and
// voiceCareResolve.test.js pins the two against each other. It is copied rather than imported because
// nothing in src/lib imports from src/pages, and the likeliest host for this flow is that page — the
// import would be a cycle.

import { looseKey } from './comboboxInput.js'
import { resolveAlias } from './voiceAliases.js'
import { fuzzyMatch } from './voiceFuzzyMatch.js'
import { classify, foldNumberWords, normalise } from './voiceHarvestGrammar.js'

// ── KEY(x) — the comparison key for voice ───────────────────────────────────────────────────────
// looseKey keeps characters speech never produces — parentheses, '&', commas, '/', '>' — so "Holy
// Basil (Tulsi)" and "Hot & Spicy Oregano" could never be an exact match for anything said aloud, and
// "Pasture > In-Ground" could never equal "pasture in ground" (design §2d: 13/106 Bag Area plantings
// carry such a term, one carries nothing else). KEY strips every remaining non-alphanumeric.
//
// THE SECOND looseKey IS LOAD-BEARING. looseKey collapses repeated letters, but only ones that are
// adjacent when it runs: "Hot & Tangy" keys to "hot&tangy", while the spoken "hot tangy" keys to
// "hotangy". Stripping the '&' afterwards leaves "hottangy" on the name side, and the two never meet.
// Re-applying looseKey after the strip collapses both sides the same way.
//
// Voice-only. looseKey itself is shared with three typed surfaces and is deliberately NOT changed.
export function voiceKey(s) {
  return looseKey(looseKey(s).replace(/[^\p{L}\p{N}]/gu, ''))
}

// What a planting can be called out loud — MUST equal VoiceHarvest.jsx plantingAliases(); see header.
export function careTerms(p) {
  return [p?.name, p?.variety_ref?.name, p?.variety_ref?.crop_type_slug, ...(p?.crop_aliases ?? [])]
    .filter(Boolean).map(String)
}

// The CLASSIFICATION terms — everything but the planting's own name. A group (R3b) is several
// plantings that all carry the word that was said as one of THESE: a shared variety or crop. Two
// plantings that merely share a spelling across a name and a variety are a coincidence, not a group.
function classTerms(p) {
  return [p?.variety_ref?.name, p?.variety_ref?.crop_type_slug, ...(p?.crop_aliases ?? [])]
    .filter(Boolean).map(String)
}

export const CARE_READBACK_VERBS = {
  watering: 'Water',
  fertilizing: 'Feed',
  mulched: 'Mulch',
  weeded: 'Weed',
}

// Q-B. The go-ahead is the harvest save word. Read from the harvest grammar rather than listed here,
// so "next" (and its exact paraphrases "next one" / "save and next") stay the same words on both
// flows — Dave's decision was "the same trigger phrase we are using on harvest", not a new vocabulary.
export const CONFIRM_COMMAND = 'save_and_advance'
export const CARE_CONFIRM_PROMPT = 'Say “next” to log it. Anything else cancels.'

// R2 enumerates the ways a segment can be split into exact names. Real lists enumerate a handful of
// readings; this budget is a ceiling against a pathological run of one-word names, and hitting it
// refuses rather than guessing.
export const SPLIT_STEP_BUDGET = 5000
const CANDIDATE_NAMES = 3

// ── refusals ────────────────────────────────────────────────────────────────────────────────────
// Every refusal happens before anything is written, so every one can truthfully end "Nothing was
// logged" — which is the sentence a hands-free user needs, since a refusal he half-hears must never
// be mistaken for a success.
function refusal(rule, reason, text, extra = {}) {
  return { kind: 'care_refusal', rule, reason, spokenReason: `${text} Nothing was logged.`, ...extra }
}

const R0_TEXT = {
  'no-scope': 'Say which area, like “water all bag area”.',
  'empty-exclusion-list': 'I didn’t catch which plants to skip.',
}

// Screen form keeps the path separator; the spoken form drops it, because a speech engine may read
// ">" aloud ("Pasture greater than In-Ground").
function spokenArea(fullPath) {
  return String(fullPath).split(/\s*>\s*/).join(' ')
}

function orList(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

function nameCandidates(names) {
  const shown = names.slice(0, CANDIDATE_NAMES)
  const more = names.length - shown.length
  return more > 0 ? `${shown.join(', ')} or ${more} more` : orList(shown)
}

// ── L: the live locations ───────────────────────────────────────────────────────────────────────
// GET /api/locations returns { locations, locations_with_path } (lambda/locations/index.js); the name
// lives on one and the full_path on the other. Accepts that response or an already-joined array.
export function careLocations(res) {
  if (Array.isArray(res)) return res
  const paths = new Map((res?.locations_with_path ?? []).map((w) => [w.id, w.full_path]))
  return (res?.locations ?? []).map((l) => ({
    id: l.id, name: l.name, full_path: paths.get(l.id) ?? l.name, level: l.level, parent_id: l.parent_id ?? null,
  }))
}

// A zone is a top-level location. Fail-closed on missing data: a row with neither a level nor a
// parent is treated as a zone, which only ever makes it HARDER to reach (exact key only).
function isZone(l) {
  if (l.level != null) return Number(l.level) === 0
  return l.parent_id == null
}

// ── R0 + R1: the scope ──────────────────────────────────────────────────────────────────────────
/**
 * Resolve the spoken area to exactly one location, or refuse. Pure.
 *
 *   null                                   not a care command (grammar returned null) — pass through
 *   { kind: 'care_refusal', rule, reason, spokenReason, ... }
 *   { kind: 'care_scope', location, match: 'exact'|'substring', heard }
 *
 * The host needs this BEFORE resolveCareCommand, because S is the dry run for the location it names.
 */
export function resolveCareScope(care, locations) {
  if (care == null) return null
  if (care.kind === 'care_refused') {
    return refusal('R0', care.reason, R0_TEXT[care.reason] ?? 'I couldn’t use that.')
  }
  if (care.kind !== 'care') return null

  // R1: drop a leading "all". What remains must name an area — "water all" is refused, never read as
  // the whole garden, which is the widest possible over-application.
  const words = String(care.scope ?? '').replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  if (words[0] === 'all') words.shift()
  const heard = words.join(' ')
  const k = voiceKey(heard)
  if (!k) return refusal('R1', 'no-scope', R0_TEXT['no-scope'])

  const locs = (locations ?? []).filter((l) => l && l.id != null)

  // EXACT KEY FIRST, over the name and the full path. "pasture in ground" is the full path of Pasture >
  // In-Ground exactly — and a SUBSTRING of "Legacy Pasture In-Ground", the deliberately unmanaged
  // legacy bed. "stable" is the zone Stable exactly — and a substring of "Yard - Stable". In both, only
  // the exact reading is what he means (design §1b; the live tree 2026-09-23).
  const exact = locs.filter((l) => voiceKey(l.name) === k || voiceKey(l.full_path) === k)
  if (exact.length === 1) return { kind: 'care_scope', location: exact[0], match: 'exact', heard }
  if (exact.length > 1) {
    return refusal('R1', 'scope-ambiguous',
      `“${heard}” could be ${nameCandidates(exact.map((l) => l.full_path))}.`)
  }

  // Substring over the same, but NEVER a zone: a zone is reachable by its exact name only, because
  // "pasture" is 127 plantings against the 24 of the area he usually means.
  const sub = locs.filter((l) => !isZone(l)
    && (voiceKey(l.name).includes(k) || voiceKey(l.full_path).includes(k)))
  if (sub.length === 1) return { kind: 'care_scope', location: sub[0], match: 'substring', heard }
  if (sub.length > 1) {
    return refusal('R1', 'scope-ambiguous',
      `“${heard}” could be ${nameCandidates(sub.map((l) => l.full_path))}.`)
  }
  return refusal('R1', 'scope-unknown', `I don’t know an area called “${heard}”.`)
}

// ── the planting index (U) ──────────────────────────────────────────────────────────────────────
function buildIndex(plantings) {
  const rows = []
  const byId = new Map()
  const byPlanting = new Map()
  const byKey = new Map()
  for (const p of plantings ?? []) {
    if (!p || p.id == null) continue
    const row = {
      p,
      id: String(p.id).toLowerCase(),
      keys: [...new Set(careTerms(p).map(voiceKey).filter(Boolean))],
      classKeys: new Set(classTerms(p).map(voiceKey).filter(Boolean)),
    }
    rows.push(row)
    byId.set(row.id, row)
    byPlanting.set(p, row)
    for (const key of row.keys) {
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(row)
    }
  }
  return { rows, byId, byPlanting, byKey }
}

// Plantings with a term KEY-equal to what was said — or to its number-folded form, since a fold is
// derived by rule rather than guessed ("super sweet one hundred" IS "super sweet 100").
function exactRowsFor(text, idx) {
  const hits = idx.byKey.get(voiceKey(text))
  if (hits) return hits
  const folded = foldNumberWords(text)
  if (folded === normalise(text)) return []
  return idx.byKey.get(voiceKey(folded)) ?? []
}

// ── R2: split an unpunctuated list ──────────────────────────────────────────────────────────────
// Chrome rarely punctuates, so "zephyr crimson sweet king richard" arrives as one segment. Split
// points are chosen by EXACT names only — substring, learned and fuzzy never decide where one name
// ends, because substring splitting produced wrong-but-clean readings in the design's simulation
// (§2h: 15 of 400, e.g. "bell pepper unknown" -> "bell pepper" + "unknown") and exact never did.
// Every segment is tried, whatever the grammar's `ambiguousList` says: that flag is only set for a
// single segment, and a partly punctuated list carries multi-name segments flagged as unambiguous.
function splitSegment(segment, idx) {
  const words = String(segment).split(/\s+/).filter(Boolean)
  if (words.length <= 1) return { parts: [words.join(' ')] }

  const memo = new Map()
  const span = (i, j) => {
    const key = `${i}:${j}`
    if (!memo.has(key)) memo.set(key, exactRowsFor(words.slice(i, j).join(' '), idx))
    return memo.get(key)
  }

  const readings = []
  const used = new Set()
  const parts = []
  let steps = 0
  let exhausted = false
  const walk = (i) => {
    if (exhausted) return
    if (++steps > SPLIT_STEP_BUDGET) { exhausted = true; return }
    if (i === words.length) { readings.push(parts.slice()); return }
    for (let j = i + 1; j <= words.length; j++) {
      const rows = span(i, j)
      // Every part must be an exact name, and the parts must name DISJOINT plantings — "celebrity" +
      // "celebrity rescue" is not two names, it is one name said with a stutter.
      if (!rows.length || rows.some((r) => used.has(r.id))) continue
      for (const r of rows) used.add(r.id)
      parts.push({ text: words.slice(i, j).join(' '), ids: rows.map((r) => r.id) })
      walk(j)
      parts.pop()
      for (const r of rows) used.delete(r.id)
    }
  }
  walk(0)

  if (exhausted) {
    return { refusal: refusal('R2', 'split-too-many', `I can’t tell where the names in “${segment}” start and end.`) }
  }
  // No exact reading at all: the whole segment is one name, and R3's later layers get their turn.
  if (!readings.length) return { parts: [segment] }

  // FEWEST PARTS WINS — a whole name beats two shorter names that happen to be inside it. Two
  // fewest-part readings that name different plantings are a genuine ambiguity, and refused.
  const fewest = Math.min(...readings.map((r) => r.length))
  const best = readings.filter((r) => r.length === fewest)
  const sig = (r) => [...new Set(r.flatMap((p) => p.ids))].sort().join(',')
  if (new Set(best.map(sig)).size > 1) {
    return { refusal: refusal('R2', 'split-ambiguous', `I can’t tell where the names in “${segment}” start and end.`) }
  }
  return { parts: best[0].map((p) => p.text) }
}

// ── R3: resolve one name against U ──────────────────────────────────────────────────────────────
function hit(rows, how, heard, exact, term = null) {
  return { rows, how, heard, exact, term }
}

// The word a group is read back by — "Celebrity", "green bean", "watermelon" (a crop slug, so its
// underscores become spaces).
function groupTerm(rows, k) {
  for (const t of classTerms(rows[0].p)) {
    if (voiceKey(t) === k) return t.replace(/_/g, ' ')
  }
  return rows[0].p.name
}

function ambiguous(heard, rows, inS) {
  const names = [...rows]
    .sort((a, b) => (inS.has(b.id) - inS.has(a.id)) || String(a.p.name).localeCompare(String(b.p.name)))
    .map((r) => r.p.name)
  return refusal('R3', 'name-ambiguous', `“${heard}” could be ${nameCandidates(names)}.`, { heard })
}

// Several exact hits are acceptable only as a GROUP: every one carries the said word as a variety or
// crop term. Anything else — one planting NAMED the word, another merely sharing it — is refused.
function fromExact(rows, k, heard, exact, inS) {
  if (rows.length === 1) return hit(rows, 'strict', heard, exact)
  if (rows.every((r) => r.classKeys.has(k))) return hit(rows, 'group', heard, exact, groupTerm(rows, k))
  return ambiguous(heard, rows, inS)
}

// THE ORDER IS THE HARVEST ORDER (matchPlantingsWithRescue): strict (exact before substring) ->
// learned -> folded -> fuzzy. Every layer runs against U, the whole household list — NEVER against S.
// Narrowing to the area first is the trap the design measured on Dave's own taught phrases (§2g): in
// In-Ground alone, "cucumber one" (taught for Suyo Long, which lives in the Bag Area) is auto-selected
// by fuzzy as Cucamelon. Against U it resolves to Suyo Long, and R4 then refuses it as not in the area
// — which is how a misheard name, or a misheard area, shows itself.
function resolveName(heard, idx, aliasIndex, plantings, inS) {
  const k = voiceKey(heard)
  if (!k) return refusal('R3', 'name-empty', 'I didn’t catch one of the names to skip.')

  const exactRows = idx.byKey.get(k)
  if (exactRows) return fromExact(exactRows, k, heard, true, inS)
  const sub = idx.rows.filter((r) => r.keys.some((t) => t.includes(k)))
  if (sub.length === 1) return hit(sub, 'strict', heard, false)
  if (sub.length > 1) return ambiguous(heard, sub, inS)

  // Learned. An alias names a VARIETY, so it can return several plantings — all of one variety by
  // construction, which is the same shared-term shape as a group, announced with its count.
  const learned = resolveAlias(aliasIndex, heard, plantings)
    .map((p) => idx.byPlanting.get(p)).filter(Boolean)
  if (learned.length) {
    return hit(learned, 'alias', heard, false, learned.length > 1 ? learned[0].p.variety_ref?.name ?? null : null)
  }

  const folded = foldNumberWords(heard)
  if (folded !== normalise(heard)) {
    const fk = voiceKey(folded)
    const fExact = idx.byKey.get(fk)
    if (fExact) return fromExact(fExact, fk, heard, false, inS)
    const fSub = idx.rows.filter((r) => r.keys.some((t) => t.includes(fk)))
    if (fSub.length === 1) return hit(fSub, 'strict', heard, false)
    if (fSub.length > 1) return ambiguous(heard, fSub, inS)
  }

  // Q-C: a confident fuzzy guess is ACCEPTED, and the read-back says what was heard. 'many' is not a
  // guess, it is a list, and a care command has nowhere to show a list — so it refuses.
  const res = fuzzyMatch(plantings, heard, careTerms, looseKey)
  if (res.kind === 'one') {
    const row = idx.byPlanting.get(res.planting)
    if (row) return hit([row], 'fuzzy', heard, false)
  }
  if (res.kind === 'many') {
    return ambiguous(heard, res.hits.map((h) => idx.byPlanting.get(h.planting)).filter(Boolean), inS)
  }
  // The one refusal a taught alias can fix — the host may offer the TeachPicker AFTER this (R9).
  return refusal('R3', 'name-unknown', `I couldn’t find “${heard}”.`, { heard, teachable: heard })
}

// ── R4: membership ──────────────────────────────────────────────────────────────────────────────
// A resolved name must be IN the dry-run set. A group excludes only its members that are, and says
// how many. The refusal is worded "isn't one of the N plants in <area>" rather than "isn't in <area>"
// because U carries no status: an ENDED planting standing in that very bed fails this check too, and
// "Cantaloupe isn't in Pasture In-Ground" would be false to a man looking at it.
function membership(res, inS, area, sCount) {
  const inScope = res.rows.filter((r) => inS.has(r.id))
  if (!inScope.length) {
    const label = res.rows.length === 1 ? res.rows[0].p.name : (res.term ?? res.heard)
    const said = res.exact ? '' : ` (heard “${res.heard}”)`
    return refusal('R4', 'not-in-scope', `${label}${said} isn’t one of the ${sCount} plants in ${area}.`,
      { heard: res.heard })
  }
  return {
    plantingIds: inScope.map((r) => r.id),
    resolvedName: inScope.length === 1 ? inScope[0].p.name : (res.term ?? inScope[0].p.name),
    heard: res.heard,
    how: res.how,
    exact: res.exact,
    count: inScope.length,
  }
}

// Two pieces that land on the same plantings are one exclusion — "except pick and pop" arrives from
// the grammar as "pick" + "pop" (it splits on "and"), and both are the one planting Pick and Pop.
function mergeEntries(entries) {
  const out = []
  const bySig = new Map()
  for (const e of entries) {
    const sig = [...e.plantingIds].sort().join(',')
    const prev = bySig.get(sig)
    if (prev) {
      if (!prev.heardAll.includes(e.heard)) prev.heardAll.push(e.heard)
      prev.exact = prev.exact && e.exact
      continue
    }
    const entry = { ...e, heardAll: [e.heard] }
    bySig.set(sig, entry)
    out.push(entry)
  }
  return out
}

// ── R6: the read-back ───────────────────────────────────────────────────────────────────────────
function entryText(e, { spoken }) {
  const name = e.count > 1 ? `${e.count} ${e.resolvedName} plants` : e.resolvedName
  if (e.exact) return name
  const heard = e.heardAll.map((h) => (spoken ? h : `‘${h}’`)).join(', ')
  return `${name} — heard ${heard}`
}

function readBack({ verb, keepCount, area, entries, excludedCount, rainNote, spoken }) {
  let s = `${verb} ${keepCount} in ${area}`
  if (entries.length) s += `, skipping ${excludedCount}: ${entries.map((e) => entryText(e, { spoken })).join(', ')}`
  s += '.'
  if (rainNote) s += ' Rain is forecast tomorrow.'
  return s
}

/**
 * R0–R6. Pure.
 *
 * Inputs
 *   care         classifyCareCommand(transcript)
 *   plantings    U — the household list as ?view=picker returns it, with `crop_aliases` attached the
 *                way VoiceHarvest.jsx attaches them. Every name resolves against THIS, never against S.
 *   locations    L — live locations, careLocations(GET /api/locations)
 *   aliasIndex   A — indexAliases(rows) from voiceAliases.js; null degrades silently, as in harvest
 *   scopeSet     S — { locationId, count, capped, plantings:[{id,...}] }, the dry run for the location
 *                resolveCareScope named (voiceCareBatch.fetchCareScopeSet)
 *   rainTomorrow bedWaitActive(plan) from careNeeded.js, when the host has the plan
 *   inGroundIds  ids the host knows are in-ground beds; omitted = unknown, and the rain note is then
 *                given for any watering while rain is due (a spurious note costs a sentence; a missing
 *                one is the bed-wait over-watering runBulk exists to avoid)
 *
 * Returns null (not a care command), a refusal { kind:'care_refusal', rule, reason, spokenReason },
 * or a plan:
 *   { kind:'care_plan', eventType, verb, location, scopeMatch, scopeCount, keepIds,
 *     exclusions:[{ plantingIds, resolvedName, heard, heardAll, how:'strict'|'alias'|'fuzzy'|'group',
 *                   exact, count }],
 *     excludedCount, readBackText, readBackSpoken, needsRainNote }
 * keepIds (W) is what R8 writes, as scope {type:'ids'} — never space + exclude_plant_ids.
 */
export function resolveCareCommand({
  care, plantings, locations, aliasIndex = null, scopeSet, rainTomorrow = false, inGroundIds = null,
} = {}) {
  const scope = resolveCareScope(care, locations)
  if (scope == null || scope.kind !== 'care_scope') return scope
  const { location } = scope
  const area = location.full_path ?? location.name
  const verb = CARE_READBACK_VERBS[care.eventType] ?? String(care.verb ?? care.eventType)
  const lower = (v) => String(v ?? '').toLowerCase()

  // S must be the dry run for THIS location. A mismatch is a host bug, and resolving names against
  // the wrong area's set would make every membership check below answer the wrong question.
  if (!scopeSet || lower(scopeSet.locationId) !== lower(location.id) || !Array.isArray(scopeSet.plantings)) {
    return refusal('R1', 'scope-set-mismatch', `Something went wrong reading ${area}.`)
  }
  if (scopeSet.capped) {
    return refusal('R1', 'scope-capped', `${area} has more than 500 plants — too many to log at once.`)
  }
  const sIds = []
  const inS = new Set()
  for (const p of scopeSet.plantings) {
    const id = lower(p?.id)
    if (!id || inS.has(id)) continue
    inS.add(id)
    sIds.push(id)
  }
  if (!sIds.length) return refusal('R1', 'scope-empty', `There’s nothing to ${verb.toLowerCase()} in ${area}.`)

  const idx = buildIndex(plantings)
  const entries = []
  // R5: ALL-OR-NOTHING. The first refusal from any name returns — there is no "log the rest".
  for (const segment of care.exclusions ?? []) {
    const split = splitSegment(segment, idx)
    if (split.refusal) return split.refusal
    for (const name of split.parts) {
      const res = resolveName(name, idx, aliasIndex, plantings, inS)
      if (res.kind === 'care_refusal') return res
      const entry = membership(res, inS, area, sIds.length)
      if (entry.kind === 'care_refusal') return entry
      entries.push(entry)
    }
  }

  const exclusions = mergeEntries(entries)
  const excluded = new Set(exclusions.flatMap((e) => e.plantingIds))
  const keepIds = sIds.filter((id) => !excluded.has(id))
  if (!keepIds.length) return refusal('R5', 'nothing-left', `That skips every plant in ${area}.`)

  const inGround = inGroundIds == null ? null : new Set([...inGroundIds].map(lower))
  const needsRainNote = care.eventType === 'watering' && rainTomorrow === true
    && (inGround == null || keepIds.some((id) => inGround.has(id)))

  const common = { verb, keepCount: keepIds.length, entries: exclusions, excludedCount: excluded.size, rainNote: needsRainNote }
  return {
    kind: 'care_plan',
    eventType: care.eventType,
    verb,
    location,
    scopeMatch: scope.match,
    scopeCount: sIds.length,
    keepIds,
    exclusions,
    excludedCount: excluded.size,
    readBackText: readBack({ ...common, area, spoken: false }),
    readBackSpoken: readBack({ ...common, area: spokenArea(area), spoken: true }),
    needsRainNote,
  }
}

// ── R7: the go-ahead ────────────────────────────────────────────────────────────────────────────
/**
 * One utterance heard while a read-back is pending -> 'confirm' | 'cancel' | 'ignore'.
 *
 * 'confirm' only for the harvest save word (Q-B). EVERYTHING else that carries words cancels — a
 * continuation of the command ("except zephyr…" after a pause), a mishear of "next" ("text"), a
 * doubled "next next". A missed "next" fails safe: nothing is logged and he says it again.
 * 'ignore' is only for an empty final, which Chrome emits routinely at the head of a session (36 in
 * 54 s on the 2026-09-13 trace) and which is not an utterance at all.
 *
 * The HOST must consume the utterance whatever this returns. A cancelled continuation that fell
 * through to a harvest search branch on the same page is the failure the design names for this
 * window (§3, the split-utterance case).
 */
export function careConfirmDecision(raw) {
  const r = classify(raw)
  if (r.kind === 'unparsed' && r.reason === 'empty') return 'ignore'
  return r.kind === 'command' && r.command === CONFIRM_COMMAND ? 'confirm' : 'cancel'
}
