// Voice harvest screen: a separate route with its own state, deliberately not part of /log, so a defect
// here cannot break the weigh-in form. There is no root mic provider; the recogniser lives and dies with
// this component.
//
// The recogniser is open-coded here, not shared with ContinuousVoiceProbe or lib/transcribe.js. The probe
// is valuable because it is un-abstracted. transcribe.js ends a session on `onend` with no restart and
// never delivers a revised final, which the debouncer's supersede rule needs ("231 grams" would commit
// as "231"). This component owns its mic and releases it on unmount.
//
// Safety properties ("a silent wrong save is worse than a slow form"):
//   * A save NEVER happens without a planting AND a quantity. A "next" that cannot save says so and keeps
//     the record intact; it does not advance over it.
//   * Every outcome is announced on three channels: a large banner, a distinct haptic, and a permanent
//     ledger row. The strip counts both halves ("12 saved · 3 not captured") because the banner is one
//     overwritten slot and a refusal he did not glance at is erased by the next utterance.
//   * A Screen Wake Lock is held for the run: the screen going dark takes all three channels at once.
//   * Every committed row carries an Undo for the whole session, not just the last one.
//   * A save that FAILS releases the write cooldown, so saying "next" again retries instead of being
//     swallowed for 1500 ms as a transport duplicate.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { useApiFetch } from '../lib/api.js'
import { todayLocalISO } from '../lib/dateLocal.js'
import { HARVEST_WRITE_TIMEOUT_MS } from '../lib/harvestWriteTimeout.js'
import { looseKey, looseIncludes, splitCropAliases } from '../lib/comboboxInput.js'
import { useCropTypes } from '../hooks/useCropTypes.js'
import { fuzzyMatch } from '../lib/voiceFuzzyMatch.js'
import { fetchAliases, indexAliases, resolveAlias, teachAlias, recordAliasUse, MIN_ALIAS_CHARS } from '../lib/voiceAliases.js'
import {
  buildValue, classify, classifyPartial, foldNumberWords, isNumberPhrase, normalise, segmentCandidates,
  splitTrailingCommand, parseValueSequence, oneBreathReadings, NUMBER_HOMOPHONES,
} from '../lib/voiceHarvestGrammar.js'
import { recordVoiceEvent, recordVoiceMark } from '../lib/voiceDebug.js'
import { createCommitDebouncer } from '../lib/voiceCommitDebounce.js'
import { acquireMic, releaseMic } from '../lib/micArbiter.js'
import {
  hapticSaveCommitted, hapticSaveFailed, hapticDigitAccepted, hapticDigitRejected, hapticUndoApplied,
  hapticMatchUncertain,
} from '../lib/haptics.js'

// A hard stop, not a nag: an unbounded live mic is a recorder someone forgets, and this surface is
// reachable from the ordinary + menu. The re-arm cap is sized well above the device's ~5 sessions per
// 4 utterances.
export const RUN_BUDGET = { restarts: 600, runMs: 30 * 60 * 1000, label: '30 minutes' }

function ctor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

// One reader for "is this document hidden": four places branch on it and they must not disagree. Either
// spelling counts as hidden; `visibilityState` is what a test can redefine, `hidden` is the shorthand.
function isHidden() {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'hidden' || document.hidden === true
}

// The `src` column every voiceDebug entry from this page carries, so a log that also contains
// transcribe.js or probe entries can be read back to the surface that produced it.
const VOICE_DEBUG_SRC = 'voiceharvest'

// Cap on the "Which one?" candidate buttons. Exported so the test asserts the same number the UI uses.
export const CANDIDATE_LIMIT = 8

// The longest the first utterance of a visit may wait for the taught-name list. What is said meanwhile
// is held, in order, and read the moment the list answers. When the wait runs out the held words are
// read with the names unknown, which resolveBareOneBreath refuses (`aliasesKnown`) rather than guesses.
export const ALIAS_WAIT_MS = 2500
// Delays before a list that FAILED to load is asked for again; it is also re-asked on every Start. Until
// it loads, named one-breath sentences are refused.
export const ALIAS_RETRY_MS = [2000, 5000, 15000]

// One-line rendering of a classify() result for the debug log. Pure so the log format is testable without
// a recogniser. Quotes the transcript on every branch: a decision line without the words is half a datum.
export function describeResult(r) {
  if (!r || !r.kind) return '?'
  const said = JSON.stringify(String(r.transcript ?? ''))
  switch (r.kind) {
    case 'quantity':
    case 'weight':  return `${r.kind} ${r.value} ${r.unit}${r.implausible ? ' IMPLAUSIBLE' : ''}${r.joined ? ' JOINED' : ''} <- ${said}`
    case 'command':  return `command ${r.command} <- ${said}`
    case 'search':   return `search ${JSON.stringify(String(r.text ?? ''))} <- ${said}`
    case 'unparsed': return `unparsed ${r.reason || '?'} <- ${said}`
    default:         return `${r.kind} <- ${said}`
  }
}

// What a planting can be called out loud: its name, variety name, crop-type slug and the crop type's
// aliases ("cantaloupe" for a melon). A recogniser fails on a cultivar name it has never heard but not on
// "cucumber".
//
// The slug alone is the crop-type term. display_name is the Title Case of the slug for every type
// ('bunching_onion' / "Bunching Onion") and looseKey lowercases both, so a display_name term was a
// near-duplicate that cost a third fetch on mount. Re-add it only for a crop type whose display name is
// not its de-snake-cased slug.
//
// `crop_aliases` is attached to the row by the page, not read from the payload: ?view=picker carries
// the crop-type SLUG and nothing else crop-shaped, and the alias text comes from the separate
// vocabulary fetch. A row without it — no vocabulary loaded, or a crop type with no aliases, which
// is most of them — yields exactly the three terms it always did.
export function plantingAliases(p) {
  return [p?.name, p?.variety_ref?.name, p?.variety_ref?.crop_type_slug, ...(p?.crop_aliases ?? [])]
    .filter(Boolean).map(String)
}

// Pure so the matcher is testable without a recogniser, a network or a DOM. Returns every planting any
// of whose aliases contains the spoken text, with exact alias matches promoted: "cucumber" must select a
// planting actually NAMED cucumber ahead of "Cucumber Beetle Trap Crop".
export function matchPlantings(plantings, spoken) {
  const needle = looseKey(spoken)
  if (!needle) return []
  const hits = plantings.filter((p) => plantingAliases(p).some((a) => looseIncludes(a, spoken)))
  const exact = hits.filter((p) => plantingAliases(p).some((a) => looseKey(a) === needle))
  return exact.length ? exact : hits
}

// Is this bare number the WHOLE NAME of a live planting? The hold that stops a count splitting
// requires a planting to be selected, after which a bare number can only be an amount. This is the
// exception, so "1884" can still switch to the planting named 1884 (the word form already resolves).
//
// Two bounds are the safety argument:
//   * Key equality, not looseIncludes. A proper substring can never satisfy it, so "two" in
//     *Brentwood*, "four" in Marvel of *Four* Seasons and "2" in Danvers 1*2*6 cannot reach this.
//   * Digits only. Allowing word forms would put "three" one badly-named planting away from silently
//     switching crops mid-record.
// looseKey collapses runs of repeated characters, which is wrong for digit runs; fixing that only
// shrinks the reachable set, so the bound only tightens.
export function namesAPlantingExactly(plantings, spoken) {
  const needle = looseKey(spoken)
  if (!needle || !/^\d+$/.test(needle)) return false
  return (plantings ?? []).some((p) => plantingAliases(p).some((a) => looseKey(a) === needle))
}

// The strict matcher re-run with spoken number words folded to digits ("eighteen eighty four" ->
// "1884"). Returns [] when there was nothing to fold, so the caller can tell "no numbers in this
// phrase" from "folded and missed".
//
// Not folded inside looseKey, which PlantingSelect and VarietyPicker share: typed "1884" would start
// returning eighteen-eighty-four rows on the daily form. The fold fixes a recogniser defect, so it
// stays on the voice path.
function matchFolded(plantings, spoken) {
  const folded = foldNumberWords(spoken)
  if (folded === normalise(String(spoken ?? ''))) return []
  return matchPlantings(plantings, folded)
}

// The rescue runs ONLY when matchPlantings returns empty, so every utterance that resolves strictly
// resolves identically; it can only turn "nothing matched" into something. It cannot reach a command or
// a number: classify() decides those before the search branch is entered. Returns the shape the caller
// already handles plus a `rescued` marker, so a non-strict hit is announced as a correction.
//
// Four layers, in this order (the order is the safety argument):
//   1. strict  — exact/substring, still first.
//   2. learned — a mishearing already fixed by hand. Beats fuzzy: fuzzy is a guess (77% right on
//                adversarial input), an alias is a fact a human asserted. It sits below strict so one
//                bad teach cannot shadow an exact name and make a planting unreachable.
//   3. folded  — spoken number words read as the digits in a name. Above fuzzy because a fold is
//                derivable by rule and edit distance cannot reach it ("eighteen eighty four" scores
//                0.353 against *helichrysum*). Below learned because a person's explicit correction
//                of their own device outranks a universal rule; aliases are user-scoped.
//   4. fuzzy   — closed-set scoring, for a mishearing nobody has taught yet.
export function matchPlantingsWithRescue(plantings, spoken, aliasIndex = null) {
  const strict = matchPlantings(plantings, spoken)
  if (strict.length) return { hits: strict, rescued: null }

  const learned = resolveAlias(aliasIndex, spoken, plantings)
  if (learned.length) return { hits: learned, rescued: 'learned' }

  // Truthy `rescued`, like any non-strict outcome: the caller quotes the heard text so a fold does
  // not pass itself off as a clean match.
  const folded = matchFolded(plantings, spoken)
  if (folded.length === 1) return { hits: folded, rescued: 'folded' }
  if (folded.length > 1) return { hits: folded, rescued: null }

  const res = fuzzyMatch(plantings, spoken, plantingAliases, looseKey)
  if (res.kind === 'one') return { hits: [res.planting], rescued: res.alias }
  if (res.kind === 'many') return { hits: res.hits.map((h) => h.planting), rescued: null }
  return { hits: [], rescued: null }
}

// The NUMBERS in a name, as whole digit runs. Number words fold to digits ("marvel of four" -> 4) and a
// digit run glued to letters is split off ("5-Color", "F1") so it compares as a run of its own.
export function digitRuns(text) {
  return foldNumberWords(text)
    .replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((t) => /^\d+$/.test(t))
}

// The variety a phrase names when it IS a taught alias, else null. A taught alias is a name wherever a
// name is recognised (the head guard, a reading's name, ownership); without that, a taught "cucumber one"
// split into the crop "cucumber" plus an amount of 1.
//
// Whole-key equality and never under MIN_ALIAS_CHARS, the bounds resolveAlias itself applies. Key-level,
// not planting-level: the phrase is a name whether or not that variety has a live planting.
export function aliasVarietyOf(aliasNames, spoken) {
  if (!aliasNames?.size) return null
  for (const key of [looseKey(spoken), looseKey(foldNumberWords(spoken))]) {
    if (key.length >= MIN_ALIAS_CHARS && aliasNames.has(key)) return aliasNames.get(key)
  }
  return null
}

// The keys aliasVarietyOf reads: each stored heard_key, plus its heard_text with number words folded, so
// Chrome's "cucumber 1" is the taught "cucumber one". Kept apart from indexAliases so the learned SEARCH
// layer stays as it was and only "is this a name?" learns the folded form. Rows without heard_text
// contribute their key alone.
export function indexAliasNames(rows, base = null) {
  const byKey = new Map(base ?? [])
  for (const r of rows ?? []) {
    if (!r?.variety_id) continue
    const text = r.heard_text == null ? null : String(r.heard_text)
    const keys = [String(r.heard_key ?? ''), ...(text ? [looseKey(text), looseKey(foldNumberWords(text))] : [])]
    for (const k of keys) if (k) byKey.set(k, r.variety_id)
  }
  return byKey
}

// The same keys as indexAliasNames, each pointing at the alias it came from (the stored heard_key the
// server counts by, and its variety), so "cucumber 1" counts as a use of the taught "cucumber one".
export function indexAliasUses(rows, base = null) {
  const byKey = new Map(base ?? [])
  for (const r of rows ?? []) {
    if (!r?.variety_id || !r?.heard_key) continue
    const use = { heard_key: String(r.heard_key), variety_id: r.variety_id }
    const text = r.heard_text == null ? null : String(r.heard_text)
    const keys = [use.heard_key, ...(text ? [looseKey(text), looseKey(foldNumberWords(text))] : [])]
    for (const k of keys) if (k) byKey.set(k, use)
  }
  return byKey
}

// The taught alias that chose THIS planting from THESE words, or null. Credited only when the alias did
// the choosing: a strict name answers before any alias, so words that already name the planting strictly
// ("super sweet 100") are not a use. Same variety only: an alias names a variety.
export function aliasUseOf(aliasUses, plantings, spoken, planting) {
  const varietyId = planting?.variety_ref?.id
  if (!aliasUses?.size || !varietyId || !spoken) return null
  const strict = isNumberPhrase(spoken) ? plantingsNamedExactly(plantings, spoken) : matchPlantings(plantings ?? [], spoken)
  if (strict.some((p) => p.id === planting.id)) return null
  for (const key of [looseKey(spoken), looseKey(foldNumberWords(spoken))]) {
    const use = key.length >= MIN_ALIAS_CHARS ? aliasUses.get(key) : null
    if (use && use.variety_id === varietyId) return use
  }
  return null
}

// A taught alias of this planting's variety, said whole, carries its numbers and words with it.
const taughtFor = (planting, name, aliasNames) => {
  const variety = aliasVarietyOf(aliasNames, name)
  return variety != null && variety === planting?.variety_ref?.id
}

// Does this planting OWN every number left in the name that reached it? Every digit run in the spoken
// name must be a whole digit run of one of the planting's aliases, counted with multiplicity. "danvers
// 126" owns 126; "danvers 12" does not (looseIncludes finds it inside "danvers126carrot"); "suyo long 2"
// does not (the fuzzy layer resolves it to Suyo Long). A name that fails this is not a name: the number
// was an amount the split put on the wrong side.
// A name that IS an alias taught for this planting's variety owns its numbers ("cucumber one" owns its
// 1 for Suyo Long), whole alias only.
export function plantingOwnsNumbers(planting, name, aliasNames = null) {
  const wanted = digitRuns(name)
  if (!wanted.length) return true
  if (taughtFor(planting, name, aliasNames)) return true
  return plantingAliases(planting).some((alias) => {
    const pool = digitRuns(alias)
    return wanted.every((d) => {
      const i = pool.indexOf(d)
      if (i < 0) return false
      pool.splice(i, 1)
      return true
    })
  })
}

// Plantings whose alias IS this phrase, raw or with number words folded. The only matcher a number-only
// phrase may use (see isNumberPhrase): whole-key equality cannot be met by a proper substring, the same
// bound namesAPlantingExactly puts on a bare digit. A taught alias answers second, in the search's own
// order (strict, then learned).
export function plantingsNamedExactly(plantings, spoken, aliasNames = null) {
  const keys = new Set([looseKey(spoken), looseKey(foldNumberWords(spoken))].filter(Boolean))
  const named = (plantings ?? []).filter((p) => plantingAliases(p)
    .some((a) => keys.has(looseKey(a)) || keys.has(looseKey(foldNumberWords(a)))))
  if (named.length) return named
  const taught = aliasVarietyOf(aliasNames, spoken)
  return taught == null ? [] : (plantings ?? []).filter((p) => p?.variety_ref?.id === taught)
}

// Pick the ONE reading of a one-breath sentence that the live planting vocabulary supports, or none.
//
// `segmentCandidates` refuses to choose: for "eighteen eighty four two count" the string alone cannot
// say whether the count is 2, 6 or 86, because the planting really is named 1884. The vocabulary can.
// This is closed-set selection applied to the split point instead of the spelling.
//
// Exactness is the tiebreak: "super sweet one hundred three count" yields both "super sweet one
// hundred" (the exact alias "super sweet 100") and "super sweet one" (a SUBSTRING of the same planting):
// counts 3 and 103. Preferring the exact alias resolves it; without that this correct sentence would be
// refused.
//
// Refuses on a genuine tie. If two survivors of equal strength disagree about the planting or the
// values, no reading is chosen and the caller falls through to "say the parts separately". A wrong
// harvest committed silently is the one outcome this flow must not have.
//
// Two bounds on the name half:
//   * A name made ONLY of numbers resolves by exact equality or not at all (plantingsNamedExactly): "2"
//     offered as a name hit Danvers 1*2*6 through the substring layer.
//   * Every number left in a name must be the planting's own (plantingOwnsNumbers): "cucumber 3 231
//     grams" kept Suyo Long's 231 g while the 3 vanished into the name.
// Neither bound touches a name without digits. `aliasNames` is indexAliasNames' map; given only the
// search index, the raw keys still count.
export function resolveOneBreath(plantings, candidates, aliasIndex = null, aliasNames = aliasIndex) {
  const survivors = []
  for (const c of candidates) {
    const hits = isNumberPhrase(c.name)
      ? plantingsNamedExactly(plantings, c.name, aliasNames)
      : matchPlantingsWithRescue(plantings, c.name, aliasIndex).hits
    if (hits.length !== 1) continue
    if (!plantingOwnsNumbers(hits[0], c.name, aliasNames)) continue
    const keys = [looseKey(c.name), looseKey(foldNumberWords(c.name))]
    const exact = plantingAliases(hits[0]).some((a) => keys.includes(looseKey(a)))
    survivors.push({ ...c, planting: hits[0], exact })
  }
  if (survivors.length === 0) return null
  const strong = survivors.filter((s) => s.exact)
  const pool = strong.length ? strong : survivors
  const first = pool[0]
  // Agreement, not arrival order. Two readings that land on the same planting AND the same values
  // are the same answer reached twice and are safe to accept; anything else is a real ambiguity.
  const sameValues = (a, b) => a.length === b.length
    && a.every((v, i) => v.kind === b[i].kind && v.value === b[i].value && v.unit === b[i].unit)
  const agreed = pool.every((s) => s.planting.id === first.planting.id && sameValues(s.values, first.values))
  return agreed ? first : null
}

// ── One-breath record said WITHOUT (all of) its units ──────────────────────────────────────────────
//
// "planting 2 165" as ONE final. oneBreathReadings (the grammar) returns every way to split the final
// into a name and one or two amounts; this decides which are real, using what the grammar cannot see:
// the planting vocabulary and the current selection.
//
// THE RULE: a one-breath final is read exactly as its parts would be read as separate finals, and it is
// REFUSED when the split into parts is not unique. The hazard is a number that could sit on either side
// of the name boundary: "super sweet 100 3 200", "cherry rescue 1 200", "danvers 126 200", "peach tree
// 200" ("tree" is the recogniser's "three"). A reading survives only if:
//   * its name resolves to exactly ONE planting that OWNS every number left in the name
//     (plantingOwnsNumbers); a name of numbers only resolves by exact equality or not at all
//     (plantingsNamedExactly), because "2" is a substring of Danvers 1*2*6;
//   * no bare amount is itself a planting's whole name ("1884"): said alone, that is the planting;
//   * nameless, a planting is already selected — "a bare number before a planting is chosen is a
//     search" stands unless the same final names one.
// A reading is AMBIGUOUS, and the whole final refused, when its first bare amount is a number the
// planting's own name carries ("clemson 80 200"), when a name ending in a homophone reads differently
// with that word as the first amount ("peach tree 200" vs "peach" + 3, 200), or, defensively, when the
// name holds a homophone the planting's name does not ("suyo long to 7 165"). Two surviving readings
// that disagree are ambiguous too.
//
// Returns null when the final is not this reader's (the ordinary path handles it), { kind: 'apply',
// planting, groups, command, nearCommand } (planting null means the selected one), or { kind: 'refuse',
// reason: 'ambiguous' | 'crowded' | 'run' | 'numbers' | 'names', name?, hits? }.
const sameGroups = (a, b) => a.length === b.length
  && a.every((g, i) => g.value === b[i].value && g.unit === b[i].unit)

const plantingNumbers = (planting) => new Set(plantingAliases(planting).flatMap(digitRuns))

function plantingOwnsHomophones(planting, name, aliasNames = null) {
  const words = normalise(name).split(' ').filter((t) => Object.prototype.hasOwnProperty.call(NUMBER_HOMOPHONES, t))
  if (!words.length) return true
  if (taughtFor(planting, name, aliasNames)) return true
  const aliasWords = plantingAliases(planting).map((a) => normalise(a).split(/[^a-z0-9]+/))
  return words.every((w) => aliasWords.some((ws) => ws.includes(w)))
}

function judgeBareReading(plantings, r, ctx) {
  // A bare amount that IS a planting's whole name is that planting, exactly as it is said alone
  // (namesAPlantingExactly is the hold gate's own bound) — so this reading is not the real one.
  if (r.groups.some((g) => g.unit == null && namesAPlantingExactly(plantings, String(g.value)))) {
    return { kind: 'invalid' }
  }
  if (!r.name) return ctx.selected ? { kind: 'valid', planting: null, groups: r.groups } : { kind: 'invalid' }
  // A name that runs on into a TAUGHT alias is only the front of it: "cucumber" then "one" is
  // "cucumber one", so the one belongs to the name. The reading that keeps the whole alias is judged
  // on its own.
  const rest = r.groups.map((g) => g.text).join(' ').split(' ')
  for (let k = 1; k <= rest.length; k++) {
    if (aliasVarietyOf(ctx.aliasNames, `${r.name} ${rest.slice(0, k).join(' ')}`) != null) return { kind: 'invalid' }
  }
  const hits = isNumberPhrase(r.name)
    ? plantingsNamedExactly(plantings, r.name, ctx.aliasNames)
    : matchPlantingsWithRescue(plantings, r.name, ctx.aliasIndex).hits
  if (hits.length !== 1) {
    // Several plantings answer to a real name ("super sweet 100" is two of them): not specific
    // enough to guess between, and worth offering as a list. One that does not own its numbers is
    // not a name at all.
    return hits.length > 1 && hits.every((h) => plantingOwnsNumbers(h, r.name, ctx.aliasNames))
      ? { kind: 'crowded', name: r.name, hits } : { kind: 'invalid' }
  }
  const [planting] = hits
  if (!plantingOwnsNumbers(planting, r.name, ctx.aliasNames)) return { kind: 'invalid' }
  if (!plantingOwnsHomophones(planting, r.name, ctx.aliasNames)) return { kind: 'ambiguous' }
  const first = r.groups[0]
  if (first.unit == null && plantingNumbers(planting).has(String(first.value))) return { kind: 'ambiguous' }
  const words = normalise(r.name).split(' ')
  const last = words[words.length - 1]
  if (words.length > 1 && Object.prototype.hasOwnProperty.call(NUMBER_HOMOPHONES, last)) {
    const altGroups = [{ value: NUMBER_HOMOPHONES[last], unit: null, text: last }, ...r.groups]
      .filter((g, i, all) => !(i > 0 && g.unit == null && all[i - 1].unit == null && all[i - 1].value === g.value))
    if (altGroups.length <= 2) {
      const alt = judgeBareReading(plantings, { name: words.slice(0, -1).join(' '), groups: altGroups }, ctx)
      if (alt.kind === 'valid' && !(alt.planting?.id === planting.id && sameGroups(alt.groups, r.groups))) {
        return { kind: 'ambiguous' }
      }
    }
  }
  return { kind: 'valid', planting, groups: r.groups, name: r.name }
}

// `aliasesKnown: false` means his taught names could not be read (the list failed or has not loaded),
// which is not the same as "he taught none". Every guard that keeps a taught name whole ("cucumber one"
// is Suyo Long, not "cucumber" + 1) reads that list, so a NAMED sentence cannot be split safely: it is
// REFUSED ('names') and the caller clears the record as for any refused named sentence. Not sent the
// ordinary way, which is worse: the search re-selects the crop and KEEPS the amounts already on the
// record, so "Stupice", "5 count", "suyo long 3 231", "next" saved Suyo Long · 5 count.
// A planting's own whole name still passes (the guard below is first), and a sentence of numbers alone is
// still read. Default true, so a caller with no list to pass (every pure test) means "none taught".
export function resolveBareOneBreath(plantings, info, {
  selected = null, aliasIndex = null, aliasNames = aliasIndex, aliasesKnown = true,
} = {}) {
  if (!info) return null
  // The whole head IS a planting's name ("cherry rescue 1", "eighteen eighty four") or a taught name
  // ("cucumber one"): a name, not a record. The ordinary search selects it, with or without a trailing
  // command.
  if (plantingsNamedExactly(plantings, info.head).length || aliasVarietyOf(aliasNames, info.head) != null) return null
  if (!aliasesKnown && !info.nameless) return { kind: 'refuse', reason: 'names' }
  const judged = info.readings.map((r) => judgeBareReading(plantings, r, { selected, aliasIndex, aliasNames }))
  if (judged.some((j) => j.kind === 'ambiguous')) return { kind: 'refuse', reason: 'ambiguous' }
  const valid = judged.filter((j) => j.kind === 'valid')
  if (valid.length) {
    const [first] = valid
    const agree = valid.every((v) => (v.planting?.id ?? null) === (first.planting?.id ?? null)
      && sameGroups(v.groups, first.groups))
    return agree
      ? { kind: 'apply', planting: first.planting, groups: first.groups, command: info.command, nearCommand: info.nearCommand, name: first.name ?? null }
      : { kind: 'refuse', reason: 'ambiguous' }
  }
  // The longest name that several plantings answer to — readings run shortest name first.
  const crowded = judged.filter((j) => j.kind === 'crowded').pop()
  if (crowded) return { kind: 'refuse', reason: 'crowded', name: crowded.name, hits: crowded.hits }
  // Numbers only, and a crop chosen: an amount that cannot be read is refused in place rather than
  // sent to the search, which would clear the crop (the hold gate's reason for existing).
  if (info.nameless && selected && (info.badRun || info.overfull)) {
    return { kind: 'refuse', reason: info.badRun ? 'run' : 'numbers' }
  }
  if (!info.nameless && info.badRun) return { kind: 'refuse', reason: 'run' }
  return null
}

// The guard the grammar asks for at the call site: a whole-utterance command is not a command while the
// chooser's live result set contains an exact name match for that text. A planting name is free text,
// so the grammar cannot check disjointness itself; a planting named "Next" would be unselectable and
// would fire a save every time. Only an EXACT alias match demotes a command; a partial one must not, or
// "save" would stop working the moment something called Savoy is grown.
export function resolveCommandCollision(result, plantings) {
  if (!result || result.kind !== 'command') return result
  const spoken = String(result.transcript ?? '')
  const key = looseKey(spoken)
  if (!key) return result
  const collides = plantings.some((p) => plantingAliases(p).some((a) => looseKey(a) === key))
  return collides ? { kind: 'search', text: spoken, transcript: spoken } : result
}

// The one wording of an inferred unit ("3 count assumed"), shared by the live banner and the saved
// banner/row so they cannot drift apart. It says when the guessed value looks high; the flag rides on
// the slot (like `assumed`) so the saved banner and row say it too.
const assumedPhrase = (v) => `${v.value} ${v.unit} assumed${v.implausible ? ' — that looks high' : ''}`

// Where a held number will land if nothing changes it: the same slot order placeHeld uses (the crop's
// default unit into an empty quantity, else grams into an empty weight), and the axis from buildValue.
// Shared by the held-number card and the restatement's replaced-value note.
function heldLandingOf(held, qty, weight, selected) {
  if (held == null) return null
  const unit = qty == null ? (selected?.variety_ref?.default_unit || 'count') : weight == null ? 'g' : null
  const built = unit ? buildValue(held, unit, '') : null
  if (!built || (built.kind === 'weight' ? weight : qty) != null) return null
  return { axis: built.kind, value: built.value, unit: built.unit }
}

// The one wording of amounts a crop change took off the record: the banner note, the strip row and the
// debug mark. Shared by the switch itself, by a failed save that had sent them, and by the other doors
// that take values off the record, so the row reads the same whichever finds it true.
function switchWords(amountsCleared, planting) {
  const amounts = amountsCleared.map((v) => `${v.value} ${v.unit}`).join(' · ')
  const from = [...new Set(amountsCleared.map((v) => v.saidFor.name || v.saidFor.variety_ref?.name))].join(' and ')
  const to = planting.name || planting.variety_ref?.name
  return {
    amounts, from, to, planting,
    note: `cleared ${amounts} from ${from}`,
    row: `Cleared ${amounts} for ${from} — the crop changed to ${to} before it was saved.`,
    mark: `switch-cleared ${amounts} (${from} -> ${to})`,
  }
}

const TONE = {
  ok:   { bg: P.greenPale, border: P.green,       fg: P.dark },
  warn: { bg: P.warn,      border: P.warnBorder,  fg: P.dark },
  fail: { bg: P.alert,     border: P.alertBorder, fg: P.dark },
  idle: { bg: P.white,     border: P.border,      fg: P.light },
}

// `embedded` is set only by HarvestLog, which supplies its own title and the voice/manual selector. It
// suppresses this page's <h1> and swaps one sentence of help text; both branches are covered by
// VoiceHarvest.embedded.test.jsx.
export default function VoiceHarvest({ embedded = false } = {}) {
  const { fetch: apiFetch } = useApiFetch()

  // The raw picker payload and the crop-type vocabulary it is decorated with below. Held apart because
  // they come from two independent fetches and either may land first.
  const [rawPlantings, setRawPlantings] = useState([])
  const { cropTypes } = useCropTypes()
  const [loadError, setLoadError] = useState(null)
  const [running, setRunning]     = useState(false)
  const micTokenRef               = useRef(null)
  const [supported]               = useState(() => !!ctor())

  const [selected, setSelected]     = useState(null)
  const [candidates, setCandidates] = useState([])
  // The phrase that matched NOTHING, kept on screen so it stays teachable. Distinct from `candidates`
  // because the two render different affordances: a short list to confirm, versus a search box to
  // resolve from scratch.
  const [unmatched, setUnmatched]   = useState(null)
  const [qty, setQty]               = useState(null)     // { value, unit }
  const [heldNum, setHeldNum]       = useState(null)     // number awaiting its unit
  const [weight, setWeight]         = useState(null)     // { value, unit }
  const [rows, setRows]             = useState([])       // committed harvests, newest last
  const [heard, setHeard]           = useState(null)     // the pending, not-yet-settled utterance
  const [status, setStatus]         = useState({ tone: 'idle', text: 'Tap Start, then say a crop.' })
  const [endsAt, setEndsAt]         = useState(null)
  // Whether the screen is being held awake, said out loud rather than assumed. A wake lock can be refused
  // (low battery, insecure context, no API) and a refusal that presents as a success is the silent fail
  // this page exists to close.
  const [screenNote, setScreenNote] = useState(null)

  // The recogniser and the run's own bookkeeping. Refs, not state: the recogniser callbacks fire
  // outside React's render cycle and must read CURRENT values, never the ones closed over at arm().
  const recRef      = useRef(null)
  const debRef      = useRef(null)
  const tickRef     = useRef(null)
  const wallRef     = useRef(null)
  const restartsRef = useRef(0)
  const stopRef     = useRef(false)
  // `wakeRef` is the live WakeLockSentinel or null. `hiddenRef` records that THIS run was interrupted by
  // the page hiding, so it is announced once (Chrome's `aborted`, our visibilitychange listener and
  // `onend` can all arrive for one screen timeout). `runningRef` is for the visibility listener, which
  // fires outside React's render cycle.
  const wakeRef     = useRef(null)
  const hiddenRef   = useRef(false)
  const runningRef  = useRef(false)
  // How many cues the platform REFUSED since the last report.
  const refusedRef  = useRef(0)

  // THE RECORD UNDER CONSTRUCTION, mirrored into refs. `setState` updaters are not a synchronous
  // read — a ref is the only synchronous truth — and the save path has to know, at the instant the
  // "next" commits, exactly what is on screen. Reading state here would save the previous record.
  const selectedRef = useRef(null)
  const qtyRef      = useRef(null)
  const weightRef   = useRef(null)
  const plantingsRef = useRef([])
  // `aliasRef` is the learned-mishearing index, consulted between strict and fuzzy. `unmatchedRef` is the
  // phrase behind what the user is looking at, the thing a tap would TEACH; a ref so the tap handler reads
  // what was actually heard, not what the last render closed over.
  const aliasRef    = useRef(null)
  // The same aliases as NAMES (indexAliasNames), which the one-breath readers ask "is this phrase a
  // taught name?". Loaded and taught alongside aliasRef, never instead of it.
  const aliasNamesRef = useRef(null)
  // Whether the taught names are KNOWN: 'loading' until the first GET answers, 'ready' once a list loaded
  // (an empty list too: none taught), 'failed' when it could not be read. Only 'ready' lets the one-breath
  // reader treat a name and a number as a record.
  const aliasStateRef = useRef('loading')
  // Names taught in THIS visit, laid over every (re)load, so a list that lands after a teach keeps it.
  const taughtRowsRef = useRef([])
  // What was said while the list was still loading — { items: [[result, meta]], timer } — or null.
  const heldRef = useRef(null)
  const waitSpentRef = useRef(false)
  const reloadAliasesRef = useRef(null)
  const releaseHeldRef = useRef(null)
  const applyCommittedRef = useRef(null)
  // `aliasUsesRef` maps what can be said to the alias it would use (indexAliasUses); `aliasUseRef` is the
  // alias that chose the planting on the record under construction ({ heard_key, variety_id, plantingId }
  // or null), counted once that record saves.
  const aliasUsesRef = useRef(null)
  const aliasUseRef = useRef(null)
  const unmatchedRef = useRef(null)
  // A number whose unit has not arrived yet. A REF because the recogniser callbacks that read it fire
  // outside React's render cycle; `heldNum` is the render-visible mirror so a half-finished value is
  // never invisible on screen.
  const heldNumRef  = useRef(null)
  // What the last crop change cleared, for the crop it changed to: { plantingId, text } or null.
  // saveRecord says it again, because a switch and a save in one breath ("suyo long 3 231 next") leave
  // the save's banner as the only one on screen.
  const switchedRef = useRef(null)
  // The saves whose POST is still out, oldest first: { plantId, slots, rechosen }. `slots` are the exact
  // count and weight objects sent; they stay on the record until the POST answers and are compared BY
  // IDENTITY (a value said again while the POST is out is a new object even if it reads the same).
  // `rechosen` marks the saved crop chosen again while its POST was out. `sendingLossRef` holds what a
  // door would have said about taking sent values off the record ({ slots, words }; `words(values)`
  // builds that door's own row, note and mark) until their POSTs answer; `savedSlotsRef` holds every
  // value a POST saved.
  const inFlightRef = useRef([])
  const sendingLossRef = useRef([])
  const savedSlotsRef = useRef(new WeakSet())
  // A "next" queued behind the send in its way: { flight, plantId, token } or null. Set when a "next" is
  // refused because the record holds a value that POST is sending plus something new; it then goes
  // through as a spoken one would when the POST answers (saveRecord). Cancelled by clearRecord or
  // clearForSwitch.
  const pendingSaveRef = useRef(null)
  const applyOneUtteranceRef = useRef(null)
  // The ledger as it stands, for the save path's banner after its await.
  const rowsRef = useRef([])
  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { qtyRef.current = qty }, [qty])
  useEffect(() => { weightRef.current = weight }, [weight])
  useEffect(() => { rowsRef.current = rows }, [rows])
  // Decorate the rows with the crop-type aliases rather than threading a vocabulary map through the
  // matchers. plantingAliases() has six call sites, four of them exported pure helpers that take only
  // `plantings` (matchPlantings, namesAPlantingExactly, resolveOneBreath, resolveCommandCollision) plus
  // fuzzyMatch, which takes it as an injected function. A parameter would have to travel through every
  // signature and test, and a call site that forgot it would silently match less than its neighbour.
  // Attaching the terms to the row means every layer (strict, learned, folded, fuzzy, one-breath, the
  // teach picker's own filter) sees them.
  //
  // The slug stays on the row as a term, so a planting whose crop type is missing from the vocabulary (or
  // a vocabulary that failed to load) matches as before. display_name is deliberately not added (see
  // plantingAliases); aliases are the opposite case, since "cantaloupe" shares no characters with "melon".
  const plantings = useMemo(() => {
    const bySlug = new Map((cropTypes ?? []).map((c) => [c.slug, c]))
    return rawPlantings.map((p) => {
      const aliases = splitCropAliases(bySlug.get(p?.variety_ref?.crop_type_slug)?.search_aliases)
      return aliases.length ? { ...p, crop_aliases: aliases } : p
    })
  }, [rawPlantings, cropTypes])
  useEffect(() => { plantingsRef.current = plantings }, [plantings])
  useEffect(() => { runningRef.current = running }, [running])

  // The banner as last SAID, synchronously. A one-breath sentence runs several parts through the
  // ordinary path in one tick, and its read-back prefixes the planting to what the last part said.
  const statusRef = useRef(null)
  const say = useCallback((tone, text) => { statusRef.current = { tone, text }; setStatus({ tone, text }) }, [])

  // Fire a cue and read whether it landed. `haptic()` returns true only when the platform accepted the
  // vibration, and Chrome refuses on a hidden document and drops the request when the ringer is silent:
  // the pocketed-phone case, so the channel can be dead exactly when it is the only one left. Counting
  // refusals keeps the design honest about its reach.
  // Only an explicit `false` counts; anything else, including a test double that returns nothing, is not
  // evidence the platform said no.
  const cue = useCallback((fire) => { if (fire() === false) refusedRef.current += 1 }, [])

  // The channel that survives not looking. `status` is one slot and `say()` replaces it, so a refusal is
  // erased by the next utterance that parses cleanly ("Nothing matched" then "3 count" reads green). A
  // miss row is appended for every outcome announced as a failure, so the strip's header can answer
  // "did everything I said get logged?".
  //
  // An ambiguous match is deliberately NOT a miss: it leaves a candidate list and is normally resolved
  // by the next utterance, and counting it would inflate "not captured" with things captured a second
  // later.
  const noteMiss = useCallback((text) => {
    setRows((r) => [...r, { kind: 'miss', text, at: Date.now() }])
  }, [])

  // Reported when the document next becomes VISIBLE, the first moment the report can be read (the
  // refusals were mostly caused by the document being hidden). Returns the count so the caller can decide
  // whether to spend the banner on it. A NOTE, not a miss: a channel was lost, not a log, and folding it
  // into "not captured" would give that number two meanings.
  const reportRefusedCues = useCallback(() => {
    const n = refusedRef.current
    if (!n) return 0
    refusedRef.current = 0
    setRows((r) => [...r, {
      kind: 'note', at: Date.now(),
      text: `Your phone did not buzz for ${n} cue${n === 1 ? '' : 's'} — this list is the record of them.`,
    }])
    return n
  }, [])

  // ── Screen sleep ────────────────────────────────────────────────────────────────────────────────
  //
  // On Chrome Android the screen turning off kills the capture AND every non-visual cue in one event, and
  // it is the most likely way a hands-free run dies. In Chromium, speech_recognition.cc aborts recognition
  // unconditionally under IS_ANDROID when the page hides, vibration_controller.cc returns false from
  // navigator.vibrate on a hidden document (re-checked per pulse), and hidden-tab timer throttling stalls
  // the settle-window tick below. Treating 'aborted' as routine and re-arming a mic Chrome aborts again
  // burns the restart budget until "session limit reached".
  //
  // Wake Lock is feature-detected and a refusal is said out loud: it is absent in some browsers and in
  // insecure contexts, and it can be refused at request time (low battery). Its absence must degrade,
  // never throw, and must never be assumed to have held, because the whole cue stack is downstream of it.
  const requestWakeLock = useCallback(async () => {
    const wl = typeof navigator !== 'undefined' ? navigator.wakeLock : null
    if (!wl || typeof wl.request !== 'function') {
      setScreenNote('This browser will not hold the screen awake — listening stops when it sleeps.')
      return
    }
    try {
      wakeRef.current = await wl.request('screen')
      setScreenNote('Screen held awake while listening.')
    } catch (err) {
      wakeRef.current = null
      setScreenNote(`The screen may sleep — ${err?.message || 'the wake lock was refused'}. Listening stops if it does.`)
    }
  }, [])

  const releaseWakeLock = useCallback(() => {
    const sentinel = wakeRef.current
    wakeRef.current = null
    setScreenNote(null)
    // release() is async and rejects if the sentinel is already gone; neither outcome is worth a
    // banner, and a teardown must not be able to throw.
    if (sentinel) { try { sentinel.release()?.catch?.(() => {}) } catch { /* already released */ } }
  }, [])

  // Detach BEFORE aborting, for the reason the unmount path does: a teardown still dispatches, and a
  // final arriving after we have decided to stop would commit into a session nobody is watching.
  const releaseRecogniser = useCallback(() => {
    const rec = recRef.current
    recRef.current = null
    if (!rec) return
    rec.onstart = null; rec.onresult = null; rec.onerror = null; rec.onend = null; rec.onnomatch = null
    try { rec.abort() } catch { /* already gone */ }
  }, [])

  // One announcement per interruption: Chrome's `aborted`, our visibilitychange listener and `onend` can
  // each notice the same screen timeout, and three miss rows for one event would make the count
  // untrustworthy. The haptic is fired even though a hidden document is where Chrome refuses it; the
  // refusal is then counted and reported (reportRefusedCues), the only way that report can be true.
  const noteScreenSleep = useCallback(() => {
    if (hiddenRef.current) return false
    hiddenRef.current = true
    recordVoiceMark(VOICE_DEBUG_SRC, 'hidden')
    cue(hapticSaveFailed)
    noteMiss('The screen went off — listening stopped there, and anything said after it was not captured.')
    return true
  }, [cue, noteMiss])

  useEffect(() => {
    let live = true
    // ?view=picker is the narrow projection; the census in lambda/plants/grid-view.test.js lists its
    // consumers. Fields read here: id, name, archived_at, variety_ref.{name,crop_type_slug,default_unit}.
    apiFetch('/api/plants?view=picker')
      .then((r) => { if (live) setRawPlantings((r?.plants ?? r ?? []).filter((p) => !p.archived_at)) })
      .catch((e) => { if (live) setLoadError(e?.message || 'Could not load your plantings') })

    // Learned mishearings are fetched ALONGSIDE the plantings, not gating them, and this sets no
    // loadError: a chooser that refuses to start because a cache of corrections failed to load is worse
    // than one that forgot a few. fetchAliases answers null for "could not read" and aliasStateRef says
    // so, so the one-breath reader refuses a named sentence out loud instead of splitting "cucumber one"
    // into the crop and an amount of 1. A failed load is asked for again (ALIAS_RETRY_MS, and on every
    // Start); whatever was held while it loaded is read the moment it answers either way.
    let retry = null
    let attempts = 0
    let inFlight = false
    const load = () => {
      inFlight = true
      fetchAliases(apiFetch).then((rows) => {
        inFlight = false
        if (!live) return
        if (rows == null) {
          aliasStateRef.current = 'failed'
          recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `aliases-unavailable (attempt ${attempts + 1})`)
          if (attempts < ALIAS_RETRY_MS.length) {
            clearTimeout(retry)
            retry = setTimeout(() => { if (live && !inFlight && aliasStateRef.current === 'failed') load() },
              ALIAS_RETRY_MS[attempts++])
          }
        } else {
          const all = [...rows, ...taughtRowsRef.current]
          aliasRef.current = indexAliases(all)
          aliasNamesRef.current = indexAliasNames(all)
          aliasUsesRef.current = indexAliasUses(all)
          aliasStateRef.current = 'ready'
        }
        releaseHeldRef.current?.()
      })
    }
    reloadAliasesRef.current = () => { if (live && !inFlight && aliasStateRef.current === 'failed') load() }
    load()

    return () => { live = false; clearTimeout(retry); reloadAliasesRef.current = null }
  }, [apiFetch])

  const clearRecord = useCallback(() => {
    setSelected(null); setCandidates([]); setUnmatched(null); setQty(null); setWeight(null)
    selectedRef.current = null; qtyRef.current = null; weightRef.current = null
    unmatchedRef.current = null
    aliasUseRef.current = null
    // A held number belongs to the record being cleared. Carrying it into the NEXT planting would
    // let a count spoken for one crop attach itself to another — the silent wrong save this flow
    // exists to prevent, reached by the back door.
    heldNumRef.current = null; setHeldNum(null)
    // A queued "next" was for the record being cleared.
    pendingSaveRef.current = null
  }, [])

  // Every amount on the record carries the crop it was SAID FOR: the planting chosen when it was said, or
  // null before one was. It rides on the slot value like `assumed`, so it goes wherever the value goes and
  // is cleared with it. Every write of a count or weight goes through here.
  const fillSlot = useCallback((axis, v) => {
    const slot = { ...v, saidFor: selectedRef.current }
    if (axis === 'weight') { setWeight(slot); weightRef.current = slot } else { setQty(slot); qtyRef.current = slot }
  }, [])

  // A crop change clears the amounts said for the old crop, and says so. Without it a spoken name kept the
  // amounts standing: "Stupice", "5 count", "cucumber one", "next" saved Suyo Long · 5 count, Stupice's
  // count under another crop, with nothing said. The accepted cost: a correction ("Stupice… no, cucumber
  // one") means saying the amounts again.
  //
  // Called by EVERY door that chooses a planting, before it does: a spoken name, a tap in the list or the
  // teach box, and the one-breath readers. Keyed on what each amount was SAID FOR, not on the crop on
  // screen: the list and teach box only show once a search has unselected the crop, so at a tap nothing is
  // selected yet the amounts are still the old crop's. Each amount on the record is:
  //   * said for another planting — cleared, on the banner and in a miss row. Another planting BY ID (the
  //     row the harvest is saved under), so a second planting of the same variety is a different crop;
  //   * said for this planting — kept (the same crop chosen again, by any name or door);
  //   * said before any crop was chosen — kept, and from now on this crop's.
  // Returns the words for the read-back, or null when nothing was cleared.
  //
  // An amount a save has already SENT leaves the record without a word. It is on its way: "Cleared 5
  // count for Stupice" beside Stupice's own saved row would count a false miss ("1 saved · 1 not
  // captured"). Its words are held back (sendingLossRef) and said only if no POST saves it, the one case
  // where they are true. It still leaves the record: kept, "next" would save it again under the new crop.
  const clearForSwitch = useCallback((planting) => {
    const cleared = []
    const sending = []
    for (const [ref, set] of [[qtyRef, setQty], [weightRef, setWeight]]) {
      const v = ref.current
      if (!v) continue
      const next = !v.saidFor ? { ...v, saidFor: planting } : v.saidFor.id === planting.id ? v : null
      if (!next) (inFlightRef.current.some((f) => f.slots.includes(v)) ? sending : cleared).push(v)
      if (next !== v) { ref.current = next; set(next) }
    }
    // The crop being saved, chosen again while its POST is out, is a choice that POST must not undo.
    for (const f of inFlightRef.current) if (f.plantId === planting.id) f.rechosen = true
    // A "next" queued for another crop's record does not carry over; what it was for is cleared above,
    // and said, like anything else unsaved.
    if (pendingSaveRef.current && pendingSaveRef.current.plantId !== planting.id) pendingSaveRef.current = null
    if (sending.length) {
      const held = switchWords(sending, planting)
      recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `switch-sending ${held.amounts} (${held.from} -> ${held.to})`)
      sendingLossRef.current = [...sendingLossRef.current, { slots: sending, words: (vs) => switchWords(vs, planting) }]
    }
    if (!cleared.length) { switchedRef.current = null; return null }
    const words = switchWords(cleared, planting)
    recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `switch-cleared ${words.amounts} (${words.from} -> ${words.to})`)
    noteMiss(words.row)
    switchedRef.current = { plantingId: planting.id, text: words.note }
    return words.note
  }, [noteMiss])

  // A POST has answered. What a door took off the record while values were being sent is said now, in that
  // door's own words, for every one that no POST saved, once no POST is still sending any of them. Two
  // POSTs cannot carry one value while a save word is refused during a send (saveRecord); the check stays
  // so the words can never be false if that refusal is relaxed. Returns what it said, for the failed
  // save's banner.
  const settleSendingLosses = useCallback(() => {
    const said = []
    sendingLossRef.current = sendingLossRef.current.filter((held) => {
      if (held.slots.some((v) => inFlightRef.current.some((f) => f.slots.includes(v)))) return true
      const lost = held.slots.filter((v) => !savedSlotsRef.current.has(v))
      if (lost.length) {
        const words = held.words(lost)
        recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `${words.mark} after a failed save`)
        noteMiss(words.row)
        said.push(words)
      }
      return false
    })
    return said
  }, [noteMiss])

  // The other doors that take values off the record hold back their words the same way. A sentence
  // refused and started over, and amounts said again without units, each wrote a "Cleared …" / "Replaced
  // …" row for values a POST was still sending, which then saved ("1 saved · 2 not captured" for a record
  // that saved whole). This splits off the values being sent and hands `words(values)` (the door's own
  // row, note and mark) to settleSendingLosses, which says them only if no POST saves those values.
  // Returns the values held back; the door says the rest now. The switch splits its own, value by value,
  // because it also keeps and adopts.
  const holdBackSending = useCallback((values, words) => {
    const sending = values.filter((v) => v && inFlightRef.current.some((f) => f.slots.includes(v)))
    if (sending.length) sendingLossRef.current = [...sendingLossRef.current, { slots: sending, words }]
    return sending
  }, [])

  // Which taught alias, if any, chose the planting now on the record. Called wherever spoken words select
  // a planting; a selection by any other door leaves null.
  const noteAliasUse = useCallback((spoken, planting) => {
    const use = aliasUseOf(aliasUsesRef.current, plantingsRef.current, spoken, planting)
    aliasUseRef.current = use ? { ...use, plantingId: planting.id } : null
  }, [])

  // The teach: one handler for every manual pick, so a correction is learned identically from the
  // candidate list and from the search box.
  //
  // Selection happens first and unconditionally: the user's job is logging a harvest, so a failed teach
  // must never cost the pick. The record is set before the network call and not rolled back.
  //
  // A failed teach is said out loud, unlike a failed alias READ (swallowed): someone correcting the app
  // has been let down once, and a silent no-op would let them believe it was fixed.
  const pickPlanting = useCallback(async (p) => {
    const phrase = unmatchedRef.current
    const switched = clearForSwitch(p)
    setSelected(p); selectedRef.current = p
    // A pick from a learned alias's list ("Which one?" for a variety with two plantings) is a use of
    // it. A pick that TEACHES a new phrase is not: the phrase is not in the list yet, so this is null.
    noteAliasUse(phrase, p)
    setCandidates([]); setUnmatched(null)
    const label = p.name || p.variety_ref?.name
    say(switched ? 'warn' : 'ok', `${label} — ${switched ? `${switched}. Now say` : 'now say'} the count or the weight.`)

    const varietyId = p?.variety_ref?.id
    // Nothing to learn when the phrase already resolved strictly, and nothing to learn it AGAINST
    // when the picker payload carried no variety (a planting with no cultivar reference).
    if (!phrase || !varietyId) { unmatchedRef.current = null; return }
    unmatchedRef.current = null
    try {
      await teachAlias(apiFetch, { heardText: phrase, varietyId })
      // Update the live index immediately, so saying it again in THIS session already resolves; the
      // correction must be visibly true at once.
      const next = new Map(aliasRef.current ?? [])
      next.set(looseKey(phrase), varietyId)
      aliasRef.current = next
      const taughtRow = { heard_key: looseKey(phrase), heard_text: phrase, variety_id: varietyId }
      aliasNamesRef.current = indexAliasNames([taughtRow], aliasNamesRef.current)
      aliasUsesRef.current = indexAliasUses([taughtRow], aliasUsesRef.current)
      // Kept for a list still loading or being asked for again, so the load that lands later cannot undo
      // this teach. The state is NOT set to 'ready': one taught name is not the rest of the list.
      taughtRowsRef.current = [...taughtRowsRef.current, taughtRow]
      say(switched ? 'warn' : 'ok', `${label} — learned “${phrase}”${switched ? `, ${switched}` : ''}. Now say the count or the weight.`)
    } catch (err) {
      say('warn', `${label} selected, but I could not remember “${phrase}” — ${err?.message || 'the save failed'}.${switched ? ` (${switched})` : ''}`)
    }
  }, [apiFetch, clearForSwitch, noteAliasUse, say])

  // ── the save ────────────────────────────────────────────────────────────────────────────────────
  // Returns nothing and throws nothing: every outcome is a banner, a haptic and (on success) a row.
  // `token` is the debouncer's commit timestamp, which is how a failed write releases the cooldown that a
  // successful one armed; without it the natural retry is swallowed for 1500 ms.
  const saveRecord = useCallback(async (token) => {
    const plant = selectedRef.current
    const q = qtyRef.current
    const w = weightRef.current
    const aliasUse = aliasUseRef.current
    // What the change to this crop cleared, said again on both banners below ("cucumber one", "next"
    // refuses for want of the count said for Stupice a moment ago).
    const switchNote = plant && switchedRef.current?.plantingId === plant.id ? ` (${switchedRef.current.text})` : ''
    const noteAtSave = switchedRef.current

    // A save word while the record is still being sent sends nothing. The write cooldown (1.5 s) is the
    // only duplicate guard and a slow POST lasts longer, so a second "next" sent the same harvest again:
    // two rows, "2 saved". IDENTITY decides it, as it decides what the POST's answer clears: the record
    // holds a value a POST still out is sending (inFlightRef). That is the whole record when nothing was
    // said since "next" or the crop was only named again; it is part of it when a new amount was said for
    // the same crop while the other is on its way (sending that would save the other twice). Not a
    // failure, so no miss row and no buzz (the save's own buzz comes when it lands), and the cooldown
    // claim is given back, as the refusal below gives it back, so a real "next" straight after is not
    // swallowed as a duplicate.
    //
    // A "next" for a new amount is QUEUED, not dropped. Refused and told to say it again, it could end in
    // nothing: "stupice 5 count 231 grams next", "3 count", "next" during the save, then the POST landed
    // with the success buzz and the 3 count sat unsaved and uncounted. So the refusal promises the new
    // amount ("then 3 count") and queues the "next" behind the POST in the way; when that POST answers it
    // goes through as a spoken one would (settleQueuedNext below): a save, or a loud refusal when the
    // record cannot be saved (only a weight: it needs a quantity). A pure repeat queues nothing: that
    // harvest is on its way already. Without a crop, the refusal below answers as for any record without
    // one.
    const sending = [q, w].filter((s) => s && inFlightRef.current.some((f) => f.slots.includes(s)))
    const unsent = [q, w].filter((s) => s && !sending.includes(s))
    if (sending.length && (plant || !unsent.length)) {
      const amounts = unsent.map((v) => `${v.value} ${v.unit}`).join(' · ')
      if (unsent.length) {
        pendingSaveRef.current = { flight: inFlightRef.current.find((f) => sending.some((s) => f.slots.includes(s))), plantId: plant.id, token }
      }
      recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `save-while-sending${unsent.length ? ` (queued: ${amounts})` : ''}`)
      say('warn', !unsent.length ? 'Still saving the last one.'
        : unsent.includes(q) ? `Still saving the last one — then ${amounts}.`
          : `Still saving the last one — ${amounts} still needs a quantity.`)
      queueMicrotask(() => debRef.current?.invalidateLastWrite(token))
      return
    }

    // REFUSE LOUDLY AND KEEP THE RECORD. Advancing over an unsaveable record is how a picking gets
    // silently lost, which is the one failure mode this flow is least allowed to have.
    if (!plant || !q) {
      const missing = !plant && !q ? 'a crop and a quantity' : !plant ? 'a crop' : 'a quantity'
      cue(hapticSaveFailed)
      say('fail', `Not saved — still need ${missing}. Say it, then "next".${switchNote}`)
      noteMiss(`Not saved — still need ${missing}.`)
      // Released one microtask later, or not at all. This refusal runs synchronously INSIDE the
      // debouncer's commit handler, which arms the write cooldown only after the handler returns; released
      // here directly, the release found nothing armed and the cooldown was then armed for a save that
      // never happened. "Suyo Long", "next" (refused), "3 count", "next" inside 1.5 s had the second
      // "next" swallowed as a duplicate, nothing saved, and the banner said "saved once". The failed-POST
      // release below needs no deferral: it runs after an await, when the cooldown is armed. Token-scoped
      // either way, so only this commit's claim is released.
      queueMicrotask(() => debRef.current?.invalidateLastWrite(token))
      return
    }

    const label = plant.name || plant.variety_ref?.name || 'planting'
    // The slots whose unit the app INFERRED, quantity's first. One list feeds both the metadata below and
    // the saved banner/row, so what he is told and what the server records cannot disagree.
    const assumed = [q, w].filter((s) => s?.assumed)
    // What this POST sends, while it is out (inFlightRef).
    const flight = { plantId: plant.id, slots: [q, w].filter(Boolean), rechosen: false }
    inFlightRef.current = [...inFlightRef.current, flight]
    const land = () => { inFlightRef.current = inFlightRef.current.filter((f) => f !== flight) }
    // This record is being sent, so nothing is left queued for it.
    pendingSaveRef.current = null
    // The "next" queued behind this POST goes through now, as a spoken one would, through the command path
    // so a held number is placed as usual. Only when the record holds something this POST did not send;
    // otherwise it is dropped without a word. Run last, after this POST's own answer has settled the
    // record.
    const settleQueuedNext = () => {
      const pending = pendingSaveRef.current
      if (!pending || pending.flight !== flight) return
      pendingSaveRef.current = null
      const fresh = [qtyRef.current, weightRef.current].some((s) => s && !flight.slots.includes(s)) || heldNumRef.current != null
      if (!fresh) return
      recordVoiceMark(VOICE_DEBUG_SRC, 'decision', 'queued-next')
      applyOneUtteranceRef.current?.({ kind: 'command', command: 'save_and_advance', transcript: '' }, { atMs: pending.token })
    }
    try {
      const res = await apiFetch('/api/events', {
        method: 'POST',
        // Outwait the Lambda rather than aborting at 15s.
        timeoutMs: HARVEST_WRITE_TIMEOUT_MS,
        body: JSON.stringify({
          // NULL BY DESIGN. The container is derived server-side (deriveEventProjectId); no client is
          // expected to supply one.
          project_id: null,
          event_type: 'harvest',
          event_date: todayLocalISO(),
          notes: null,
          private_notes: null,
          quantity: null,           // harvests use the structured panel; the freetext field is nulled
          plant_id: plant.id,
          // `is_public` is deliberately NOT SENT, and the fix was a deletion rather than a flip to `true`.
          // The Lambda defaults it with `body.is_public ?? true`, and `false ?? true` is `false`, so an
          // explicit false beat the default all the way to the row and hid a voice-logged harvest from the
          // public garden page with no UI to notice or undo it. Sending `true` would drift the moment the
          // default changes; staying silent is the pattern (EventNew.jsx says the same). Guard:
          // src/__tests__/eventIsPublicSilence.test.js.
          has_photo: false,
          // How the row was captured, and which units the app INFERRED rather than heard (quantity's first;
          // [] when both were spoken). ALWAYS SENT, so a row without the key predates this field, never
          // "nothing assumed". Machine provenance: EventDetail.jsx hides it like the key above it.
          metadata: {
            harvest_input_source: 'voice',
            assumed_units: assumed.map((s) => s.unit),
          },
          harvest: {
            quantity: Number(q.value),
            unit: q.unit,
            quality_rating: null,
            ...(w ? { weight: Number(w.value), weight_unit: w.unit } : {}),
          },
        }),
      })
      land()
      // The id is a TOP-LEVEL `id` on the 201 response (the event_log row); there is no `eventId` key and no
      // nested `event`. Reading those left the Undo button (`r.eventId`) never rendered on device while its
      // test stayed green, because the fixture had been written to match the client instead of the producer.
      // `eventId` is kept as a tail read only because CaptureFlow.jsx tolerates both shapes.
      const eventId = res?.id ?? res?.eventId ?? null
      cue(hapticSaveCommitted)
      // A weightless save says so: nearly every harvest carries a weight, so a row with none is far likelier
      // a capture failure (misheard, or the session boundary ate it) than an intention. A NOTE, NEVER A
      // GATE: a genuine count-only harvest must still save cleanly, so this changes no payload, blocks
      // nothing and keeps the `ok` tone. It travels into the ledger row, not only the banner, because the
      // banner is the channel that gets overwritten.
      //
      // An assumed unit is said at the save too. "next" is itself a resolver: when it applies a held number
      // the save follows in the same utterance and would replace the "(… assumed)" note before it is
      // shown ("Suyo Long, three, 231, next" ended on "231 count · no weight was said", which reads like a
      // spoken count). Nothing is assumed SILENTLY. Every assumed slot is named, not only the one "next"
      // resolved, because the row is what he reads later and it has to say which values were guesses.
      const said = `${q.value} ${q.unit}${w ? ` · ${w.value} ${w.unit}` : ' · no weight was said'}`
        + (assumed.length ? ` (${assumed.map(assumedPhrase).join(', ')})` : '')
      // The server kept ONE row: a pick identical to one saved in the last 45 s answers 200 `repeated` with
      // THAT row's id. When the ledger already shows it live, a second row would say "saved" twice, count
      // one harvest too many, and its Undo would 404 after the first's. So no row, and the banner says what
      // happened. An id the ledger does not hold (the first attempt failed here after the server wrote it)
      // is this save's only row.
      const liveSaveOf = (r) => r.some((x) => x.kind === 'save' && !x.undone && x.eventId === eventId)
      const keptOnce = res?.repeated === true && eventId != null && liveSaveOf(rowsRef.current)
      say('ok', keptOnce
        ? `Already saved — ${label} · ${said}. It matched the save just before it, so it is kept once.${switchNote}`
        : `Saved ${label} — ${said}${switchNote}`)
      setRows((r) => (res?.repeated === true && eventId != null && liveSaveOf(r)
        ? r
        : [...r, { kind: 'save', eventId, label, said, at: Date.now() }]))
      for (const s of flight.slots) savedSlotsRef.current.add(s)
      settleSendingLosses()
      // Clear only what was saved. Whatever was said while the POST was out stays: a new amount (even one
      // that reads the same), a held number, another crop, the same crop chosen again, a list or a teach
      // box, and the crop when anything was said for it. Each value sent leaves the record BY IDENTITY; a
      // record holding none of that is cleared whole. Identity, not "is the record unchanged": after
      // "3 count" for the same crop the record still holds the weight just saved, and keeping that would
      // save it twice.
      if (qtyRef.current === q) { qtyRef.current = null; setQty(null) }
      if (w && weightRef.current === w) { weightRef.current = null; setWeight(null) }
      if (aliasUseRef.current === aliasUse) aliasUseRef.current = null
      const movedOn = qtyRef.current != null || weightRef.current != null || heldNumRef.current != null
        || selectedRef.current?.id !== plant.id || flight.rechosen
      if (!movedOn) clearRecord()
      // The note was said on this banner; one set while the POST was out belongs to the record still standing.
      if (switchedRef.current === noteAtSave) switchedRef.current = null
      // A taught alias chose this crop and the harvest it named has landed: count the use. After the save,
      // never awaited, never throwing (recordAliasUse), so counting can cost this save nothing. An Undo
      // does not un-count it.
      if (aliasUse?.plantingId === plant.id) recordAliasUse(apiFetch, [aliasUse])
      settleQueuedNext()
    } catch (err) {
      // The row did not land. Say so on every channel, keep the record so nothing is retyped, and
      // release the cooldown so "next" is a real retry — when nothing has been said since "next".
      land()
      const why = err?.message || 'the save failed'
      cue(hapticSaveFailed)
      // Once anything has been said since "next", the record is what was said since, as when the POST
      // lands: a new amount (even one that reads the same), a held number, another crop or none, or a door
      // that took a sent value off. Kept whole, the record would merge the two at the retry: "stupice 5
      // count 231 grams next", then "3 count", a failed POST and "next" saved Stupice · 3 count · 231 g.
      // So what was sent leaves the record by identity, the row names what did not save, and the banner
      // asks for it again rather than offering "next". The same crop named again changes nothing, and a
      // record that is still exactly what was sent stays whole for the retry.
      const saidSince = [qtyRef.current, weightRef.current].some((s) => s && !flight.slots.includes(s))
        || heldNumRef.current != null || selectedRef.current?.id !== plant.id
        || flight.slots.some((s) => s !== qtyRef.current && s !== weightRef.current)
      const notSaved = saidSince
        ? `NOT SAVED — ${why}. ${label} · ${q.value} ${q.unit}${w ? ` · ${w.value} ${w.unit}` : ''} was not saved; say it again to log it.`
        : `NOT SAVED — ${why}.`
      noteMiss(notSaved)
      if (saidSince) {
        for (const [ref, set, sent] of [[qtyRef, setQty, q], [weightRef, setWeight, w]]) {
          if (sent && ref.current === sent) { ref.current = null; set(null) }
        }
      }
      // A door that took a sent value off the record while it was sending held back its row; it is written
      // now, when it is true, and says why: a crop change ("next" then saves the new crop's record, never
      // this one), a sentence refused and started over, or amounts said again without units, each in its
      // own words. Only a crop change has a crop to carry the note to.
      const lost = settleSendingLosses()
      const here = lost.find((l) => l.planting && l.planting.id === selectedRef.current?.id)
      if (here) {
        const before = switchedRef.current?.plantingId === here.planting.id ? `${switchedRef.current.text}; ` : ''
        switchedRef.current = { plantingId: here.planting.id, text: `${before}${here.note}` }
      }
      say('fail', saidSince ? notSaved : `NOT SAVED — ${why}. Say "next" to try again.`)
      debRef.current?.invalidateLastWrite(token)
      // A "next" queued behind this failed POST goes through for what was said since. It never retries this
      // record: with nothing new said nothing is queued, and a later "next" retries it.
      settleQueuedNext()
    }
  }, [apiFetch, clearRecord, cue, noteMiss, say, settleSendingLosses])

  const undoRow = useCallback(async (idx) => {
    const row = rows[idx]
    if (!row?.eventId) return
    try {
      await apiFetch(`/api/events/${row.eventId}`, { method: 'DELETE' })
      cue(hapticUndoApplied)
      setRows((r) => r.map((x, i) => (i === idx ? { ...x, undone: true } : x)))
      say('warn', `Removed ${row.label} — ${row.said}`)
    } catch (err) {
      cue(hapticSaveFailed)
      say('fail', `Could not remove that row — ${err?.message || 'the delete failed'}`)
    }
  }, [apiFetch, cue, rows, say])

  // ── one settled utterance ───────────────────────────────────────────────────────────────────────
  const applyOneUtterance = useCallback((raw, meta) => {
    let result = resolveCommandCollision(raw, plantingsRef.current)

    // ── Rejoin a value Chrome split across two utterances ──────────────────────────────────────────
    //
    // Chrome ends the recogniser session mid-phrase, so "three count" reaches us as "three" then "count".
    // The debouncer's supersede rule rejoins the two inside ONE session; it cannot across a session
    // boundary, because `onend` flushes data immediately (a data commit is not destructive).
    //
    // Strictly additive, like the fuzzy rescue: both halves are already a failure or a hazard today. The
    // unit half is `unparsed`; the number half falls into the permissive search branch, where "two"
    // silently reselects Brentwood Leaf Lettuce and "four" Marvel of Four Seasons, so the following "next"
    // saves against a plant he never named. No utterance that resolves correctly today reaches this code:
    // classify() answers a complete phrase before it is consulted.
    // The number this utterance THREW AWAY, carried to the announcement. Null on every path that keeps or
    // applies it; set only where the pairing ends unfinished.
    let dropped = null
    // The value a held number RESOLVED TO, carried to the announcement.
    let assumedApplied = null
    // The two notes those carry, built in ONE place because two branches say them: the hold branch
    // (where a second number resolves the first) returns before the shared readback further down.
    const dropNoteNow = () => (dropped != null ? ` (dropped ${dropped} — no unit was said)` : '')
    // The inference, said out loud. DO NOT remove it to shorten the readback: an assumed unit that is never
    // announced is the fabricated-value class.
    const assumedNoteNow = () => (assumedApplied ? ` (${assumedPhrase(assumedApplied)})` : '')
    const noteWarns = () => dropped != null || !!assumedApplied?.implausible

    // The one place a held number is given a slot without its unit. Two doors resolve a hold that way: the
    // resolution site below (a command, or anything else that leaves the record standing) and a SECOND
    // bare number (the hold branch). One function, so the two cannot disagree.
    //
    // Slot order is the inference: the first EMPTY slot, quantity first in the crop's default unit, then
    // weight in grams. That mirrors the order he speaks them and parseValueSequence's ordering for the
    // unit-bearing form.
    //
    // A filled slot is never overwritten by an assumption. With both filled the number is DROPPED and said
    // rather than guessed onto one of them: "3, 231, 4" does not say whether the 4 corrects the count or
    // the weight, and either guess can write over a value he meant ("3 count, 231 grams, 85" would save
    // 85 g). Saying it with a unit replaces a slot.
    //
    // Nor a slot the resolving utterance is about to fill. `fills` is the set of axes that utterance
    // writes itself. Without it "231" then "3 count" assumed 231 COUNT and the quantity branch overwrote
    // it with the spoken 3: 231 was lost and the banner read "3 count (231 count assumed)", an assumption
    // that no longer existed (the same on both axes). The held number goes to the first empty slot the
    // resolving utterance does NOT fill; when it fills the last one the number is dropped and said.
    // `takenBy` is that utterance's own readback, for the miss row.
    const placeHeld = (value, fills = null, takenBy = null) => {
      const qtyOpen = qtyRef.current == null && !fills?.has('quantity')
      const weightOpen = weightRef.current == null && !fills?.has('weight')
      // default_unit comes from crop_types via the ?view=picker projection and CAN BE NULL (there is
      // no cultivar-level column; see lambda/plants/grid-view.test.js:333-337), hence the fallback.
      const unit = qtyOpen
        ? (selectedRef.current?.variety_ref?.default_unit || 'count')
        : weightOpen ? 'g' : null
      const built = unit ? buildValue(value, unit, '') : null
      // The axis comes from buildValue, not from the branch above, so a mass default_unit (legal in
      // the CHECK, absent from prod today) is checked against the slot it would actually land in.
      if (built && (built.kind === 'weight' ? weightOpen : qtyOpen)) {
        // `assumed` RIDES ON THE SLOT VALUE, not beside it, so it cannot outlive the value it describes:
        // every spoken write builds a fresh { value, unit } without it, and clearRecord() nulls it with the
        // record. saveRecord turns it into metadata.assumed_units, the only way the server can tell this
        // unit from a spoken one. A per-record flag would need clearing at every write site.
        fillSlot(built.kind, { value: built.value, unit: built.unit, assumed: true, ...(built.implausible ? { implausible: true } : {}) })
        assumedApplied = built
        recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `assumed-unit ${built.value} ${built.unit} (held number resolved)`)
        return
      }
      // Honest losses rather than guesses, each a permanent miss row: default_unit is outside
      // HARVEST_UNITS (it is a crop_types value and may be), or no empty slot is left (both were filled, or
      // the resolving utterance takes the last one).
      dropped = value
      const takenNow = takenBy && (qtyRef.current == null || weightRef.current == null)
      recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `held-dropped ${value} (${unit && !built ? 'no usable default unit' : takenNow ? `slot taken by ${takenBy}` : 'no empty slot'})`)
      noteMiss(unit && !built
        ? `Dropped ${value} — no unit was said, and this crop has no usable default unit.`
        : takenNow
          ? `Dropped ${value} — no unit was said, and ${takenBy} left no open slot for it.`
          : `Dropped ${value} — no unit was said, and the quantity and weight were already filled.`)
    }

    // The two readers of an `unparsed` utterance, read ONCE, here, because two places need their
    // answer: the hold resolution below (which slots will this utterance fill, and does it change the
    // crop?) and the one-breath branches further down that apply them. A value rejoined from a bare
    // unit is never `unparsed`, so a rejoin cannot make these stale.
    const oneBreath = result.kind === 'unparsed'
      ? resolveOneBreath(plantingsRef.current, segmentCandidates(result.transcript), aliasRef.current, aliasNamesRef.current)
      : null
    const valueSeq = result.kind === 'unparsed' && !oneBreath ? parseValueSequence(result.transcript) : null
    const axesOf = (values) => new Set(values.map((v) => v.kind))
    const readback = (values) => values.map((v) => `${v.value} ${v.unit}`).join(' · ')

    const partial = classifyPartial(result.transcript)
    if (partial?.kind === 'unit' && heldNumRef.current != null) {
      const joined = buildValue(heldNumRef.current, partial.unit, result.transcript)
      heldNumRef.current = null; setHeldNum(null)
      // Falls through to the ordinary quantity/weight branches rather than applying the value here:
      // the implausibility warning, the haptic and the announcement must be identical whether the
      // phrase arrived whole or in halves, and a second copy of them is a second thing to drift.
      if (joined) result = { ...joined, joined: true }
    } else if (partial?.kind === 'number' && selectedRef.current
               && !namesAPlantingExactly(plantingsRef.current, result.transcript)) {
      // Gated on a planting being selected, which is what makes suppressing the search safe: before a
      // plant is chosen a bare number can legitimately be a search term; after one is chosen it can only
      // be an amount.
      //
      // And gated off a number that is a whole planting name. That utterance is the crop, so it falls
      // through to the ordinary search branch (no second copy of the selection, announcement or teach
      // bookkeeping). The bound is whole-key equality on a digit literal, which cannot readmit the
      // substring reselection this gate stops; see namesAPlantingExactly.
      //
      // The unit is ASSUMED, not asked for: asking ("now say the unit: count, or grams") cost a second
      // utterance, and a number followed by anything else was dropped. The slot decides the unit and the
      // inference is announced. His stated tolerance: "I can correct it later if it is
      // wrong."
      //
      // This is not the prefill defect removed further down at the single-hit branch, which invented a
      // VALUE ({ value: 1, unit: default_unit }) so a record looked complete and saved a count never said.
      // Here the NUMBER IS ALWAYS SPOKEN; only its unit is inferred, and announced. A wrong unit is
      // visible in the ledger and correctable before "next".
      //
      // Slot order is the inference; placeHeld is the one place it is decided.
      //
      // THE HOLD STAYS. Applying the assumed unit immediately was tried and is wrong: Chrome routinely
      // splits "231 grams" into "231" then "grams" (every weight in one device trace arrived as "85" then
      // "85 G"), so assuming on arrival put the number in the COUNT slot before its unit landed and turned
      // "231 grams" into 231 count. Holding no longer DEMANDS a unit and no longer ends in the number being
      // thrown away.
      //
      // A held number is resolved by whatever comes next:
      //   unit            -> rejoin
      //   another number  -> the held one takes the next empty slot (placeHeld); the new one is held
      //   the same number -> one number heard twice, not two amounts; it stays held
      //   restated value  -> the same number with its unit; the hold is released, nothing is assumed
      //   a search        -> dropped, and said: the crop is changing
      //   anything else   -> the next empty slot with an assumed unit (placeHeld)
      //
      // A second bare number is the next amount, not a correction. Re-holding it saved "planting 2 165" as
      // 165 count with no weight, because a bare number can now become an amount without its unit, so two
      // of them can be a count and a weight. A correction is still one utterance away: said WITH its unit
      // ("fifteen count", or "fifteen" then "count") it replaces the slot through the ordinary branches.
      //
      // The same number again is one number (equality rule). Chrome re-delivers finals (one measured
      // 274 ms after its twin, against a 16-133 ms re-arm) and the debouncer's only cross-session defence
      // is the write cooldown, so a duplicate "85" arrives as a second utterance; pairing it would save 85
      // count AND 85 g from one spoken number. What this reads wrongly is a real count and weight that
      // share a number: the weight stays empty and the save says "no weight was said".
      const repeat = partial.value === heldNumRef.current
      if (heldNumRef.current != null && !repeat) placeHeld(heldNumRef.current)
      heldNumRef.current = partial.value; setHeldNum(partial.value)
      // No slot left for this one (both filled, spoken or assumed): it will be dropped at the next
      // utterance unless a unit comes with it, and that is said NOW, on the banner and the hand, while he
      // can still act on it.
      const full = qtyRef.current != null && weightRef.current != null
      // Where the held number WILL land if nothing changes it, and whether that looks high. Said now, while
      // the unit can still be given: when the next utterance is "next" the value is placed and saved in the
      // same breath, and a warning at the save alone would come too late.
      const landing = full ? null : buildValue(partial.value, qtyRef.current == null
        ? (selectedRef.current?.variety_ref?.default_unit || 'count') : 'g', '')
      const high = !!landing?.implausible
      cue(full ? hapticDigitRejected : hapticDigitAccepted)
      recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `${repeat ? 'held-repeat' : 'held-number'} ${partial.value} <- ${JSON.stringify(String(result.transcript ?? ''))}`)
      // Reads as a progress line: the number landed, and saying a unit is optional rather than required.
      say(full || high || noteWarns() ? 'warn' : 'ok', (full
        ? `${partial.value} — the quantity and weight are both filled. Say it with a unit to replace one, or it will be dropped.`
        : high
          ? `${partial.value} — as ${landing.unit === 'g' ? 'grams' : landing.unit} that looks high. Say it again to correct it, or say a unit to change it.`
          : `${partial.value} — say a unit to change it, or carry on.`) + dropNoteNow() + assumedNoteNow())
      return
    } else if (heldNumRef.current != null
               && (result.kind === 'quantity' || result.kind === 'weight')
               && result.value === heldNumRef.current) {
      // The same number with its unit is the held number, RESTATED. Chrome delivers a continuous session
      // cumulatively: "87" as one final, then "87 G" as the next final of the SAME session. Once the gap
      // passes the settle window the tick has already committed "87" as held and the debouncer can no
      // longer supersede it, so the resolution site below read "87 G" as a second amount (87 count by slot
      // order, then 87 g) and "next" saved a count nobody said. A person answering the banner with "87
      // grams" reaches the same place across a session boundary, so the rule is not scoped to one session.
      //
      // The utterance carries the number itself, so the hold is released and the ordinary quantity/weight
      // branch applies it as said (no second copy of the announcement or the haptic). Equality is the whole
      // test: a different value with a unit is a different amount, and the resolution site still infers the
      // held number's unit for it. What this reads wrongly is a bare amount followed by the OTHER axis
      // sharing its number; that slot stays visibly empty, and an empty quantity refuses at "next".
      heldNumRef.current = null; setHeldNum(null)
      recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `held-restated ${result.value} ${result.unit} (held number resolved)`)
    } else if (heldNumRef.current != null) {
      // RESOLUTION SITE. Any other utterance ends the pairing, and the held number is APPLIED with an
      // assumed unit rather than thrown away. Dropping was safe only while the alternative was asking for
      // the unit; now the unit is inferred from the slot and the inference is ANNOUNCED. What makes
      // assuming safe is that nothing is assumed SILENTLY.
      //
      // The `dropped` path survives for the cases that can still lose a number, each said out loud: a
      // search (below), a crop whose default_unit is not in this grammar's vocabulary, and a record with no
      // empty slot left (both in placeHeld).
      const heldVal = heldNumRef.current
      heldNumRef.current = null; setHeldNum(null)
      // A search still drops it, deliberately. A search utterance is how the plant gets changed, and a
      // pending number belongs to the record being abandoned: "Suyo Long, three, Brentwood" must not carry
      // a 3 onto Brentwood, and applying it to Suyo Long moments before that record is replaced is the same
      // value in a different grave. So drop it, and SAY so. Assuming is for utterances that leave the
      // record standing: a save command, or something unrecognised.
      //
      // A one-breath sentence naming a DIFFERENT planting is a crop change too. Reaching placeHeld would
      // assume the number onto the OLD record a moment before the one-breath branch cleared it:
      // "Suyo Long", "5", "Marketmore three count 231 grams" announced "(5 count assumed)" for a 5 that no
      // longer existed anywhere. Every other resolving utterance places the number on a slot IT does not
      // fill (see placeHeld).
      const changesCrop = result.kind === 'search'
        || (oneBreath != null && selectedRef.current?.id !== oneBreath.planting.id)
      if (changesCrop) {
        dropped = heldVal
        recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `held-dropped ${heldVal} (crop changed)`)
        noteMiss(`Dropped ${dropped} — no unit was said, and the crop changed before one was.`)
      } else if (result.kind === 'quantity' || result.kind === 'weight') {
        placeHeld(heldVal, axesOf([result]), readback([result]))
      } else if (oneBreath || valueSeq) {
        const values = oneBreath ? oneBreath.values : valueSeq
        placeHeld(heldVal, axesOf(values), readback(values))
      } else {
        placeHeld(heldVal)
      }
    }
    const dropNote = dropNoteNow()
    const assumedNote = assumedNoteNow()

    // ── The whole record in one sentence ───────────────────────────────────────────────────────────
    //
    // "Big Boy, two count, fifteen grams", which is how he actually speaks. Hooked ONLY on `unparsed`, so
    // it is additive in the strictest sense: such an utterance can only have produced "Didn't
    // catch that". classify() answers first and always; this only picks up what it declined.
    if (result.kind === 'unparsed') {
      const one = oneBreath
      if (one) {
        // A DIFFERENT planting means a NEW record, so the old one is cleared rather than merged. Merging
        // would let a weight spoken for the previous crop survive onto this one: the record would look
        // complete and be wrong. The same planting is a correction and keeps whatever axis was not
        // restated. What was said for the old crop is named on the way out.
        let switched = null
        if (selectedRef.current?.id !== one.planting.id) { switched = clearForSwitch(one.planting); clearRecord() }
        heldNumRef.current = null; setHeldNum(null)
        setSelected(one.planting); selectedRef.current = one.planting
        noteAliasUse(one.name, one.planting)
        setCandidates([]); setUnmatched(null); unmatchedRef.current = null
        for (const v of one.values) fillSlot(v.kind, { value: v.value, unit: v.unit })
        const label = one.planting.name || one.planting.variety_ref?.name
        const said = one.values.map((v) => `${v.value} ${v.unit}`).join(' · ')
        const implausible = one.values.some((v) => v.implausible)
        cue(hapticDigitAccepted)
        recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `one-breath ${label} ${said} <- ${JSON.stringify(String(result.transcript ?? ''))}`)
        // Read back in full, for the same reason a fuzzy rescue is: the app chose a split point the words
        // did not settle, so he sees the reading it picked before "next" commits it.
        say(implausible || noteWarns() || switched ? 'warn' : 'ok', `${label} — ${said}${implausible ? ' — that looks high. Say it again to correct it.' : ''}${switched ? ` (${switched})` : ''}${dropNote}${assumedNote}`)
        return
      }

      // Both amounts, no name: "three count, two thirty one grams". segmentCandidates() refuses a nameless
      // run by design, so this shape had no reader and lost BOTH values. It is a common case: he says the
      // crop, pauses, then says the numbers together, and Chrome ends the session at that pause.
      //
      // Not gated on a planting being selected. The rule that a bare number before a plant is chosen may be
      // a search belongs to the hold above and cannot reach here: parseValueSequence accepts only two or
      // more groups that each END IN A UNIT WORD, and this branch runs only on an utterance classify()
      // already refused as `unparsed`, so no search is suppressed. Gating it made the pair the one amount
      // that could not be said before the crop ("4 count 4 G" came back "Didn't catch that"). saveRecord
      // still refuses without a crop, so an early pair waits for one exactly as a single amount does.
      const seq = valueSeq
      if (seq && seq.length) {
        for (const v of seq) fillSlot(v.kind, { value: v.value, unit: v.unit })
        const said = seq.map((v) => `${v.value} ${v.unit}`).join(' · ')
        const implausible = seq.some((v) => v.implausible)
        cue(hapticDigitAccepted)
        recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `value-sequence ${said} <- ${JSON.stringify(String(result.transcript ?? ''))}`)
        // Read back both axes: the utterance set two fields at once, so a mishearing of either is
        // only visible if both are spoken back before "next" commits them.
        say(implausible || noteWarns() ? 'warn' : 'ok', `${said}${implausible ? ' — that looks high. Say it again to correct it.' : ''}${dropNote}${assumedNote}`)
        return
      }
    }

    // One line per SETTLED utterance saying which branch it took, so "three counts -> quantity 3 count"
    // and "three -> search" are distinguishable in the log. The raw event stream alone cannot tell: two
    // runs can deliver the same words and diverge on what the app made of them.
    recordVoiceMark(VOICE_DEBUG_SRC, 'decision', describeResult(result))

    if (result.kind === 'search') {
      // `rescued` is the alias a FUZZY match landed on, or null when the strict matcher answered. It is said
      // out loud: a rescue that stays silent is a guess wearing the costume of a clean match, so a wrong
      // rescue is caught before "next" rather than after the save.
      const { hits, rescued } = matchPlantingsWithRescue(
        plantingsRef.current, result.text, aliasRef.current,
      )
      // What a tap would teach. Recorded for EVERY non-strict outcome (total miss, ambiguous list, fuzzy
      // rescue), all cases where the user is about to tell us what they meant. Cleared on a strict match:
      // there is nothing to learn from a phrase that already resolved exactly.
      unmatchedRef.current = rescued === null && hits.length === 1 ? null : result.text
      if (hits.length === 0) {
        cue(hapticDigitRejected)
        // A failed re-selection must not leave the old crop selected. "Suyo Long" selects, "Marketmore" is
        // misheard and matches nothing, the banner says so, then "three count" and "next" each overwrite
        // that one message and the row lands against Suyo Long announced as a clean success: a save against
        // a plant the user never confirmed.
        //
        // Clears the SELECTION only, not the record. The count and weight stay, so re-saying the name is
        // one utterance, and until a name lands saveRecord's "still need a crop" refusal makes `next` fail
        // loudly. Chosen over marking it stale or blocking the save because it needs no new state to drift
        // and it reuses a refusal that is already tested.
        setSelected(null); selectedRef.current = null
        aliasUseRef.current = null
        // The phrase survives into the candidate-less state so the manual picker below can still teach it;
        // otherwise a total miss, the case most worth learning from, could not be taught.
        setCandidates([])
        setUnmatched(result.text)
        say('fail', `Nothing matched “${result.text}”. Say it again, or pick it below to teach me.${dropNote}${assumedNote}`)
        noteMiss(`Nothing matched “${result.text}”.`)
        return
      }
      setUnmatched(null)
      if (hits.length === 1) {
        // A guess must not feel like a match. This branch auto-selects on a single hit whether the strict
        // matcher answered or the fuzzy/learned/folded rescue scored its way there. The banner says which,
        // but the hand could not tell, so a rescue onto the WRONG plant delivered the success cue.
        // `rescued` is the flag that distinguishes them.
        if (rescued !== null) cue(hapticMatchUncertain)
        else cue(hapticDigitAccepted)
        const switched = clearForSwitch(hits[0])
        setSelected(hits[0]); selectedRef.current = hits[0]
        noteAliasUse(result.text, hits[0])
        setCandidates([])
        // NO DEFAULT QUANTITY IS SEEDED HERE. Pre-filling `{ value: 1, unit: variety_ref.default_unit }`
        // made the record LOOK complete, so "Suyo Long" then "next", with no count ever spoken, saved a
        // harvest of 1 count and announced success: the silent wrong save this flow exists to prevent. It
        // also bought nothing, because the grammar parses a quantity only from a number carrying a trailing
        // unit, so a bare "three" is `unparsed` either way. A quantity exists only if it was said.
        const chosen = hits[0].name || hits[0].variety_ref?.name
        say(noteWarns() || switched ? 'warn' : 'ok', (rescued
          // The heard text is quoted back verbatim so the swap is legible at a glance; without it a rescue
          // of the WRONG planting reads like a correct match.
          ? `Heard “${result.text}” — matched ${chosen}${switched ? `, ${switched}` : ''}. Say the count, or say it again to change it.`
          : `${chosen} — ${switched ? `${switched}. Now say` : 'now say'} the count or the weight.`) + dropNote + assumedNote)
        return
      }
      cue(hapticDigitRejected)
      // AMBIGUOUS IS ALSO UNCONFIRMED, so the previous crop goes here too. A list on screen is a question,
      // not an answer, and leaving the old plant selected behind it is the same silent-wrong-save route as
      // the miss above.
      setSelected(null); selectedRef.current = null
      aliasUseRef.current = null
      // THE WHOLE HIT LIST, not the eight that fit. The render caps the buttons; holding the full list lets
      // the card say how many it is hiding (a crop-type utterance reaches 46 live tomato plantings), so a
      // cap the user can see is not a truncation they cannot.
      setCandidates(hits)
      say('warn', `${hits.length} match “${result.text}” — say more of the name, or tap one.${dropNote}${assumedNote}`)
      return
    }

    // A joined value is announced as one, like a fuzzy rescue: the app assembled it from two utterances
    // rather than hearing it, and a silent rejoin is a guess wearing the costume of a clean parse. He sees
    // "3 count (heard in two parts)" and can correct it before "next".
    const joinNote = result.joined ? ' (heard in two parts)' : ''

    if (result.kind === 'quantity') {
      cue(hapticDigitAccepted)
      fillSlot('quantity', { value: result.value, unit: result.unit })
      say(result.implausible || noteWarns() ? 'warn' : 'ok',
        result.implausible ? `${result.value} ${result.unit}${joinNote}${assumedNote} — that looks high. Say it again to correct it.${dropNote}`
          : `${result.value} ${result.unit}${joinNote}${assumedNote}${dropNote}`)
      return
    }

    if (result.kind === 'weight') {
      cue(hapticDigitAccepted)
      fillSlot('weight', { value: result.value, unit: result.unit })
      say(result.implausible || noteWarns() ? 'warn' : 'ok',
        result.implausible ? `${result.value} ${result.unit}${joinNote}${assumedNote} — that looks high. Say it again to correct it.${dropNote}`
          : `${result.value} ${result.unit}${joinNote}${assumedNote}${dropNote}`)
      return
    }

    if (result.kind === 'command') {
      if (result.command === 'save_and_advance' || result.command === 'save') {
        saveRecord(meta?.atMs)
        return
      }
      if (result.command === 'clear_field') {
        cue(hapticDigitAccepted)
        clearRecord()
        say('warn', 'Cleared. Say a crop to start the next one.')
        return
      }
      if (result.command === 'finish') {
        stopRef.current = true
        try { recRef.current?.stop() } catch { /* already stopping */ }
        say('warn', 'Stopped listening.')
        return
      }
    }

    // unparsed, INCLUDING a near-miss of a command word. The grammar routes "text" (a measured 1-in-9
    // mishear of "next") here rather than to search, so it cannot perform a different action that looks
    // like it worked. Costs one repeated word; says so out loud.
    //
    // `ambiguous-number` needs its OWN sentence: it fires when the utterance carried more than one number,
    // the shape of a planting NAMED after a number said with its amount ("1884 two count"). A bare "Didn't
    // catch that" is a dead end there: the recogniser heard him perfectly, so he repeats it, gets the same
    // refusal, and cannot discover the name is being read as part of the count.
    cue(hapticDigitRejected)
    const hint = result.reason === 'near-command' ? ' — say "next" again'
      : result.reason === 'ambiguous-number' ? ' — say the planting, then the amount separately'
      : ''
    say('warn', `Didn't catch that${hint}.${dropNote}${assumedNote}`)
    // The heard text goes in the row, not just the refusal: recovering from a mishear means knowing WHAT
    // it heard, and "Didn't catch that" alone asks him to remember which of forty utterances it was.
    noteMiss(`Didn't catch that — heard “${String(result.transcript ?? '')}”.`)
  }, [clearForSwitch, clearRecord, cue, fillSlot, noteAliasUse, noteMiss, saveRecord, say])
  // For the "next" a save queues behind a POST (saveRecord is declared first, so it reaches this by ref).
  applyOneUtteranceRef.current = applyOneUtterance

  // ── Apply a one-breath record said without its units ───────────────────────────────────────────
  //
  // The parts go through the ordinary path, in the order spoken, so "Suyo Long 2 165 next" does exactly
  // what "Suyo Long", "2", "165", "next" does: the bare-number pairing, the hold that lets a unit in the
  // next final still rejoin, the equality rule, the axis rule and every announcement are reused, not
  // copied. Only the NAME is applied here, because it was resolved under stricter rules than a search
  // (resolveBareOneBreath) and must not be re-resolved by the looser ones.
  //   * a DIFFERENT planting starts a new record, and a held number from the old one is dropped, said;
  //   * BOTH amounts, for the same planting or with no name at all, restate the record: nothing is lost
  //     that the sentence does not say again. With one amount it continues the record, as a bare number
  //     would.
  // The nameless pair restates too, so applying it twice is applying it once. Chrome delivers the same
  // pair twice in two shapes: a growing phrase whose partial a tick commits ("2 165", then "2 165 next"
  // in one session) and a re-delivered final 274 ms later. Continuing the record the second time found
  // both slots filled and wrote two FALSE "Dropped …" rows ("1 saved · 2 not captured" for a record
  // saved exactly right).
  // A restatement never erases a spoken amount silently. placeHeld never overwrites a filled slot and the
  // restatement gets round it by clearing the slots first: "Suyo Long", "3 count", "2 165", "next" saved
  // 2 count · 165 g with no word about the 3 count he had SAID. It still restates (a second "2 165" must
  // stay a no-op), but every spoken slot it replaces with an assumed value, or with nothing, gets a miss
  // row and a banner note. A slot the sentence says again WITH its unit is a correction, as on the
  // ordinary path, and an unchanged amount is not a replacement.
  const applyBareOneBreath = useCallback((d, heard, meta) => {
    const planting = d.planting
    const label = planting ? (planting.name || planting.variety_ref?.name) : null
    let droppedNote = ''
    let spoken = []
    if (planting && selectedRef.current?.id !== planting.id) {
      const held = heldNumRef.current
      if (held != null) {
        noteMiss(`Dropped ${held} — no unit was said, and the crop changed before one was.`)
        droppedNote = ` (dropped ${held} — no unit was said)`
      }
      const switched = clearForSwitch(planting)
      if (switched) droppedNote += ` (${switched})`
      clearRecord()
    } else if (d.groups.length === 2) {
      const held = heldNumRef.current
      if (held != null && !d.groups.some((g) => g.value === held)) {
        noteMiss(`Dropped ${held} — no unit was said, and the record was said again without it.`)
        droppedNote = ` (dropped ${held} — no unit was said)`
      }
      spoken = [['quantity', qtyRef.current], ['weight', weightRef.current]].filter(([, v]) => v && !v.assumed)
      setQty(null); qtyRef.current = null; setWeight(null); weightRef.current = null
      heldNumRef.current = null; setHeldNum(null)
    }
    if (planting) {
      setSelected(planting); selectedRef.current = planting
      noteAliasUse(d.name, planting)
      setCandidates([]); setUnmatched(null); unmatchedRef.current = null
    }
    recordVoiceMark(VOICE_DEBUG_SRC, 'decision',
      `one-breath-bare ${label ?? '(selected crop)'} ${d.groups.map((g) => g.text).join(' | ')}${d.command ? ` + ${d.command}` : ''} <- ${JSON.stringify(heard)}`)
    for (const g of d.groups) applyOneUtterance(classify(g.text), { ...(meta ?? {}), fromOneBreath: true })
    for (const [axis, was] of spoken) {
      // What that slot holds now — or, still held, the value the next word or "next" will put there.
      const landing = heldLandingOf(heldNumRef.current, qtyRef.current, weightRef.current, selectedRef.current)
      const now = (axis === 'weight' ? weightRef.current : qtyRef.current)
        ?? (landing?.axis === axis ? { value: landing.value, unit: landing.unit, assumed: true } : null)
      if (now && (!now.assumed || (now.value === was.value && now.unit === was.unit))) continue
      const words = {
        note: now ? `replaced ${was.value} ${was.unit} with ${now.value} ${now.unit}` : `cleared ${was.value} ${was.unit}`,
        row: `${now ? `Replaced ${was.value} ${was.unit} with ${now.value} ${now.unit} (assumed)` : `Cleared ${was.value} ${was.unit}`} — the amounts were said again without units.`,
        mark: `restated ${was.value} ${was.unit}${now ? ` -> ${now.value} ${now.unit}` : ''}`,
      }
      // A value a POST is still sending was not erased: it is on its way.
      if (holdBackSending([was], () => words).length) continue
      noteMiss(words.row)
      droppedNote += ` (${words.note})`
    }

    if (d.nearCommand) {
      cue(hapticDigitRejected)
      say('warn', 'Kept that. Didn\'t catch the last word — say "next" again.')
      noteMiss(`Kept the amount; didn't catch the command — heard “${heard}”.`)
      return
    }
    // The command resolves the last held number through the same resolution site a separate "next"
    // would. Empty transcript: a trailing command is never a planting name (resolveCommandCollision
    // guards a WHOLE-utterance command only, as the unit-bearing trailing split already assumes).
    if (d.command) { applyOneUtterance({ kind: 'command', command: d.command, transcript: '' }, meta); return }
    // No command: read the planting back in front of what the last part said, as every other one-breath
    // reading is. The app chose the split, so he sees which one before "next".
    if (label || droppedNote) {
      const last = statusRef.current
      say(droppedNote ? 'warn' : (last?.tone ?? 'ok'), `${label ? `${label} — ` : ''}${last?.text ?? ''}${droppedNote}`)
    }
  }, [applyOneUtterance, clearForSwitch, clearRecord, cue, holdBackSending, noteAliasUse, noteMiss, say])

  // The one-breath sentence whose ONE amount may be two numbers run together ("Suyo Long 2165 next"). The
  // name was read cleanly, so it is applied as the one-breath would apply it (a different planting starts
  // a new record); only the amount is refused (reject haptic, banner, miss row) and nothing is written.
  const refuseMergedAmount = useCallback((d, heard) => {
    const n = d.groups[0].value
    let switched = null
    if (d.planting && selectedRef.current?.id !== d.planting.id) {
      const held = heldNumRef.current
      if (held != null) noteMiss(`Dropped ${held} — no unit was said, and the crop changed before one was.`)
      switched = clearForSwitch(d.planting)
      clearRecord()
      setSelected(d.planting); selectedRef.current = d.planting
      noteAliasUse(d.name, d.planting)
      setCandidates([]); setUnmatched(null); unmatchedRef.current = null
    }
    cue(hapticDigitRejected)
    recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `one-breath-bare refused (merged ${n}) <- ${JSON.stringify(heard)}`)
    const label = d.planting ? `${d.planting.name || d.planting.variety_ref?.name} — ` : ''
    say('warn', `${label}heard ${n} as one number. If that was a count and a weight, say them with a pause between, or say it with its unit.${switched ? ` (${switched})` : ''}`)
    noteMiss(`Not kept — heard “${heard}”: ${n} may be two numbers run together.`)
  }, [clearForSwitch, clearRecord, cue, noteAliasUse, noteMiss, say])

  // A one-breath sentence whose split is not unique, whose name is too vague, or whose numbers cannot be
  // read is refused LOUDLY: reject haptic, a banner saying why, a miss row quoting what was heard. A
  // refused sentence of numbers only changes nothing.
  //
  // One that named a planting clears the WHOLE record and says what went. Unselecting the old crop but
  // KEEPING the amounts is the trap, so "Suyo Long", "3 count", "danvers 126 200" (refused), "danvers 126", "next"
  // saved Danvers 126 Carrot · 3 count: a count said for Suyo Long under a crop named afterwards. Clearing
  // is the option that cannot save them under a different crop at all, and what is cleared is said on the
  // banner and in a miss row.
  const refuseBareOneBreath = useCallback((d, info, heard) => {
    cue(hapticDigitRejected)
    let droppedNote = ''
    if (!info.nameless) {
      const crop = selectedRef.current ? (selectedRef.current.name || selectedRef.current.variety_ref?.name) : null
      const restarted = (vs) => {
        const amounts = vs.map((v) => `${v.value} ${v.unit}`).join(' · ')
        return {
          note: `cleared ${amounts}`,
          row: `Cleared ${amounts}${crop ? ` for ${crop}` : ''} — the record was started over after a sentence that could not be read.`,
          mark: `restart-cleared ${amounts}`,
        }
      }
      // Values a POST is still sending leave with the record but were not lost: their row waits for that
      // POST (holdBackSending), and only the rest is said now.
      const values = [qtyRef.current, weightRef.current].filter(Boolean)
      const sending = holdBackSending(values, restarted)
      const unsent = values.filter((v) => !sending.includes(v))
      const held = heldNumRef.current
      if (held != null) {
        noteMiss(`Dropped ${held} — no unit was said, and the crop changed before one was.`)
        droppedNote += ` (dropped ${held} — no unit was said)`
      }
      if (unsent.length) {
        const words = restarted(unsent)
        noteMiss(words.row)
        droppedNote += ` (${words.note})`
      }
      clearRecord()
    }
    recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `one-breath-bare refused (${d.reason}) <- ${JSON.stringify(heard)}`)
    if (d.reason === 'crowded') {
      setCandidates(d.hits); setUnmatched(null); unmatchedRef.current = null
      say('warn', `${d.hits.length} match “${d.name}” — tap one, then say the amounts again.${droppedNote}`)
      noteMiss(`Not kept — “${heard}”: “${d.name}” matches ${d.hits.length} plantings.`)
      return
    }
    const why = d.reason === 'run' ? 'two numbers ran together — say them with a pause, or with their units'
      : d.reason === 'numbers' ? 'more amounts than one record holds — say the count and the weight again'
      // the taught names did not load, so a name and a number cannot be told apart; the planting's own
      // name still works, and so does saying the parts separately.
      : d.reason === 'names' ? 'the names you taught me have not loaded, so I cannot tell a name from an amount — say the planting, then the amounts'
      : 'the name and the numbers could be split more than one way — say the planting, then the amounts'
    say('warn', `Didn't catch that — ${why}.${droppedNote}`)
    noteMiss(`Didn't catch that — heard “${heard}”.`)
  }, [clearRecord, cue, holdBackSending, noteMiss, say])

  // ── A trailing command rides on the record it follows ───────────────────────────────────────────
  //
  // "cucumber, three count, two thirty one grams, next" in ONE breath. Appending "next" flips
  // classify() from `unparsed` to `search`, which skips the one-breath reader and searched for the whole
  // literal sentence, discarding the count and weight in silence. That, not a recogniser miss, is why
  // "next" seemed often not heard.
  //
  // The split is refused unless the head is ALREADY a record on its own terms, so "cucumber next" and
  // "next to the fence" cannot conjure a save (see splitTrailingCommand). A trailing MISHEARD command
  // ("231 grams text") applies the record and refuses the save: the values were spoken clearly and
  // dropping them is the lost-log failure, while committing on a near-miss is the silent wrong write.

  // Does the UNIT reader — classify()'s value branch, the unit one-breath (resolveOneBreath over
  // segmentCandidates) or the nameless unit pair (parseValueSequence) — read this text as ONE record?
  // The same three readers applyOneUtterance runs, asked in the same order with the same vocabulary,
  // so "it reads" here means "applying it will not end in Didn't catch that".
  const unitReaderReads = useCallback((text) => {
    const r = classify(text)
    if (r.kind === 'quantity' || r.kind === 'weight') return true
    if (r.kind !== 'unparsed') return false
    return resolveOneBreath(plantingsRef.current, segmentCandidates(text), aliasRef.current, aliasNamesRef.current) != null
      || parseValueSequence(text) != null
  }, [])

  const applyCommitted = useCallback((raw, meta) => {
    // The debouncer hands us a CLASSIFIED RESULT, not a string — it calls classify() itself to
    // decide the commit path. So the split reads `transcript`, and the head is re-classified before
    // it goes downstream, because applyOneUtterance's whole contract is "a result object".
    const heard = typeof raw === 'string' ? raw : String(raw?.transcript ?? '')
    // A record said without (all of) its units, in one breath. Asked first: when it answers the sentence
    // is its; when it does not, nothing below changes.
    const info = oneBreathReadings(heard)
    const bare = resolveBareOneBreath(plantingsRef.current, info, {
      selected: selectedRef.current, aliasIndex: aliasRef.current, aliasNames: aliasNamesRef.current,
      aliasesKnown: aliasStateRef.current === 'ready',
    })
    // A one-breath final ending in a save word CLAIMS the debouncer's one-write cooldown when it commits
    // (splitTrailingCommand marks it `bare`), which stops a re-delivered final saving twice. When it
    // turns out NOT to write (refused here, or declined and read the ordinary way) the claim is released,
    // or a genuine "next" said straight after would be swallowed as a duplicate. The debouncer arms the
    // claim only after this handler returns, so the release waits one microtask.
    const releaseUnwritten = () => {
      if (info?.command !== 'save_and_advance' && info?.command !== 'save') return
      const token = meta?.atMs
      queueMicrotask(() => debRef.current?.invalidateLastWrite(token))
    }
    if (bare?.kind === 'apply') {
      // One big number where a count goes may be two numbers run together: Chrome writes "two, one
      // sixty-five" as "2165" at times, and a lone 4+ digit amount with no unit landed in the COUNT slot as
      // 2165 count, under MAX_PLAUSIBLE so nothing warned. The narrowest rule that covers it: in a
      // one-breath final, a LONE amount, said as 4+ digits, with no unit, that would land in the count slot
      // is refused out loud. A 4-digit number landing in the weight slot is left alone (a count was already
      // said, so it is grams), as is one said with its unit or in words. The planting it named is still
      // selected.
      const lone = bare.groups.length === 1 ? bare.groups[0] : null
      const intoCount = lone != null && lone.unit == null && /^\d{4,}$/.test(lone.text)
        && ((bare.planting != null && bare.planting.id !== selectedRef.current?.id)
          || (qtyRef.current == null && (heldNumRef.current == null || heldNumRef.current === lone.value)))
      if (intoCount) { refuseMergedAmount(bare, heard); releaseUnwritten(); return }
      applyBareOneBreath(bare, heard, meta)
      return
    }
    const split = splitTrailingCommand(heard)
    // A bare refusal never pre-empts the unit reader. The bare reader sees only splits that leave an
    // amount WITHOUT a unit, so for "cherry rescue 1 3 count" its one reading is "cherry rescue" + 1,
    // 3 count, refused because 1 is the planting's own number; the unit reader finds "cherry rescue 1" +
    // 3 count, which saves. Measured on 200 real-name sentences, 58 were refused where the unit reader
    // would save them (names ending in their number with one unit amount, word-form names, "1884 3 count
    // 231 grams next" with another crop selected). So a refusal stands only when the unit reader has no
    // reading of its own.
    const unitHead = split ? split.head : heard
    const unitReads = unitReaderReads(unitHead)
    if (bare?.kind === 'refuse' && !unitReads) {
      refuseBareOneBreath(bare, info, heard); releaseUnwritten(); return
    }
    // A `bare` head is only ever the reader's above. Sent down the split path it would be SEARCHED and the
    // standing record then saved, so when the reader declines, the whole sentence goes the ordinary way.
    if (!split || split.bare) {
      applyOneUtterance(raw, meta)
      if (split?.bare) releaseUnwritten()
      return
    }

    recordVoiceMark(VOICE_DEBUG_SRC, 'decision',
      `trailing-command ${split.command ?? 'near-miss'} <- ${JSON.stringify(heard)}`)
    // The head runs through the ORDINARY path, so every announcement, haptic, implausibility warning and
    // debug row is the one that utterance would have produced alone.
    applyOneUtterance(classify(split.head), { ...(meta ?? {}), fromTrailingSplit: true })

    if (split.nearCommand) {
      cue(hapticDigitRejected)
      say('warn', 'Kept that. Didn\'t catch the last word — say "next" again.')
      noteMiss(`Kept the amount; didn't catch the command — heard “${heard}”.`)
      return
    }
    if (split.command === 'save_and_advance' || split.command === 'save') {
      // The save word saves only what the sentence SET. The head above was just refused ("Didn't catch
      // that"), so the record standing is the one from BEFORE this sentence, and saving it would announce a
      // success for a sentence that named something else: with "Suyo Long", "5 count" standing, "danvers 12 three count 231
      // grams next" saved Suyo Long · 5 count. Only the save is withheld: "clear" and "stop" after a
      // refused head still act, because they write nothing and a dropped "stop" would leave a live mic he
      // asked to stop. The claim on the write cooldown is given back so the "next" he says after
      // correcting himself is not swallowed.
      if (!unitReads) {
        say('warn', `${statusRef.current?.text ?? "Didn't catch that."} Nothing was saved.`)
        const token = meta?.atMs
        queueMicrotask(() => debRef.current?.invalidateLastWrite(token))
        return
      }
      saveRecord(meta?.atMs)
      return
    }
    if (split.command === 'clear_field') { cue(hapticDigitAccepted); clearRecord(); say('warn', 'Cleared. Say a crop to start the next one.'); return }
    if (split.command === 'finish') {
      stopRef.current = true
      try { recRef.current?.stop() } catch { /* already stopping */ }
      say('warn', 'Stopped listening.')
    }
  }, [applyBareOneBreath, applyOneUtterance, clearRecord, cue, noteMiss, refuseBareOneBreath, refuseMergedAmount, saveRecord, say, unitReaderReads])
  applyCommittedRef.current = applyCommitted

  // ── Nothing is read before the taught names are known, for a moment ─────────────────────────────
  //
  // The list is fetched when the page opens and usually lands long before the first utterance. If it has
  // not, what he says is HELD (every utterance, commands included, so a "next" never overtakes the name
  // it belongs to) and read the moment the list answers, or after ALIAS_WAIT_MS at most. Once per visit:
  // when the wait runs out the rest of the visit is read at once with the names unknown, so a list that
  // never loads cannot slow every sentence by the same wait. Reading "cucumber one" before the list lands
  // is the defect: Suyo Long plus an amount of 1. Waiting reads it as taught, and "cucumber 3" is only
  // ever late by the wait, never lost.
  //
  // The banner says why nothing has happened yet; the outcome is announced when the words are read. A
  // write held here has already claimed the debouncer's cooldown (it arms on a handler that returned) and
  // releases or keeps that claim with the same token when read; see saveRecord.
  const releaseHeld = useCallback(() => {
    const held = heldRef.current
    if (!held) return
    heldRef.current = null
    clearTimeout(held.timer)
    waitSpentRef.current = true
    recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `aliases-${aliasStateRef.current} read ${held.items.length} held`)
    for (const [result, meta] of held.items) applyCommittedRef.current?.(result, meta)
  }, [])
  releaseHeldRef.current = releaseHeld

  const commitWhenNamesKnown = useCallback((result, meta) => {
    const held = heldRef.current
    if (!held && (aliasStateRef.current !== 'loading' || waitSpentRef.current)) {
      applyCommitted(result, meta)
      return
    }
    if (held) held.items.push([result, meta])
    else heldRef.current = { items: [[result, meta]], timer: setTimeout(releaseHeld, ALIAS_WAIT_MS) }
    const said = String(result?.transcript ?? '')
    recordVoiceMark(VOICE_DEBUG_SRC, 'decision', `held-for-aliases <- ${JSON.stringify(said)}`)
    say('warn', `Heard “${said}” — one moment, loading the names you taught me.`)
  }, [applyCommitted, releaseHeld, say])

  // ── the recogniser ──────────────────────────────────────────────────────────────────────────────
  const scheduleTickRef = useRef(null)
  const scheduleTick = useCallback(() => {
    if (tickRef.current) { clearTimeout(tickRef.current); tickRef.current = null }
    const deb = debRef.current
    if (!deb) return
    const due = deb.dueAt()
    if (due == null) return
    tickRef.current = setTimeout(() => {
      tickRef.current = null
      debRef.current?.tick(Date.now())
      scheduleTickRef.current?.()
    }, Math.max(0, due - Date.now()))
  }, [])
  useEffect(() => { scheduleTickRef.current = scheduleTick }, [scheduleTick])

  const arm = useCallback(() => {
    const C = ctor()
    if (!C) { say('fail', 'This browser has no speech recognition.'); setRunning(false); return }
    const rec = new C()
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.lang = 'en-US'
    recRef.current = rec

    // Recorded FIRST in the handler, before the debouncer sees the event, so the log shows what the
    // browser delivered rather than what survived our own filtering. The recorder (src/lib/voiceDebug.js)
    // is flag-gated in localStorage, off by default, and returns on the flag check before touching the
    // event, so a disabled recorder never reads the live SpeechRecognitionResultList.
    rec.onstart = () => { recordVoiceMark(VOICE_DEBUG_SRC, 'start') }

    // `nomatch` is the engine saying it heard speech and could make nothing of it. It fires on Chrome
    // Android (SpeechRecognitionImpl.java maps ERROR_NO_MATCH to it), so wiring it is load-bearing:
    // unhandled, "the recogniser gave up on that phrase" is indistinguishable from "he said nothing" in
    // the UI and the trace.
    //
    // Routed to the soft-reject family, not the terminal-error one: `nomatch` arrives with a null results
    // list and does NOT end capture, so it is "say it again", not "the mic is dead". Claiming the mic died
    // when it did not would be its own dishonesty.
    rec.onnomatch = () => {
      recordVoiceMark(VOICE_DEBUG_SRC, 'nomatch')
      cue(hapticDigitRejected)
      say('warn', 'Heard something but could not make it out — say it again.')
      noteMiss('Heard something but could not make it out.')
    }

    rec.onresult = (ev) => {
      recordVoiceEvent(VOICE_DEBUG_SRC, ev)
      const results = ev.results || []
      for (let i = ev.resultIndex || 0; i < results.length; i++) {
        const r = results[i]
        if (!r || !r[0] || !r.isFinal) continue
        debRef.current?.final(r[0].transcript || '', Date.now())
        scheduleTick()
      }
    }
    // Mic death is the one event with unbounded loss, so it gets a haptic as well as the banner: every
    // branch below stops capture for good, and a banner on a screen he is not looking at leaves him
    // talking into a dead recogniser. `saveFailed` is reused rather than given its own symbol: to the hand
    // these carry the same message ("something you believe is happening is not") and the screen says which.
    //
    // These fire from an async callback, so Chrome may refuse the vibration for want of user activation
    // (haptics.js ACTIVATION RISK). That is why the banner stays: this is a second channel on the worst
    // failure, not a replacement.
    rec.onerror = (ev) => {
      recordVoiceMark(VOICE_DEBUG_SRC, 'error', ev?.error)
      const e = ev?.error
      if (e === 'not-allowed' || e === 'service-not-allowed') {
        stopRef.current = true
        cue(hapticSaveFailed)
        say('fail', 'Microphone permission was refused. Allow the mic, then tap Start.')
        noteMiss('The microphone was refused — capture stopped there.')
      } else if (e === 'audio-capture') {
        stopRef.current = true
        cue(hapticSaveFailed)
        say('fail', 'No microphone available.')
        noteMiss('No microphone available — capture stopped there.')
      } else if (e === 'aborted' && isHidden()) {
        // 'aborted' is ordinary when WE aborted (stop, unmount, the visibility release below) and NOT
        // ordinary when the page is hidden and we did not ask: that is Chrome ending the session because
        // the screen went off, which it does unconditionally on Android. Swallowing it as routine is what
        // let `onend` re-arm into the dark.
        noteScreenSleep()
      }
      // 'no-speech', and a VISIBLE 'aborted', are ordinary in a continuous session — onend re-arms.
    }
    rec.onend = () => {
      // Marked BEFORE sessionEnd() flushes, because the session boundary is the evidence for the count-split
      // defect: whether it lands between "three" and "count" decides whether the count registers, and a log
      // that records the flush without the boundary cannot tell those runs apart.
      recordVoiceMark(VOICE_DEBUG_SRC, 'end')
      // A DATA utterance flushes at the session boundary; a WRITE deliberately does not, and waits
      // out the settle window on a tick. That asymmetry is the whole reason a bare "next" can be
      // superseded by "next to the fence" instead of having already saved.
      debRef.current?.sessionEnd(Date.now())
      scheduleTick()
      if (stopRef.current) { releaseWakeLock(); setRunning(false); return }
      // NEVER RE-ARM AGAINST A HIDDEN DOCUMENT. Chrome aborts the session on every hide, so re-arming burned
      // the restart budget until "session limit reached", a message for a failure that was no time budget.
      // `running` deliberately stays true: the user never tapped Stop, and the visibility handler re-arms
      // the moment the page comes back.
      if (isHidden()) { noteScreenSleep(); return }
      if (restartsRef.current >= RUN_BUDGET.restarts) {
        releaseWakeLock()
        setRunning(false)
        cue(hapticSaveFailed)
        say('warn', 'Stopped — session limit reached. Tap Start to carry on.')
        noteMiss('Stopped — session limit reached.')
        return
      }
      restartsRef.current += 1
      // Gesture-free re-arm (16–133 ms on a device, no permission re-prompt). If it ever throws, hands-free
      // is off the table and the message says so rather than leaving a dead mic that looks live.
      try { rec.start() } catch {
        releaseWakeLock()
        setRunning(false)
        cue(hapticSaveFailed)
        say('fail', 'The mic could not restart on its own. Tap Start to keep going.')
        noteMiss('The mic could not restart on its own — capture stopped there.')
      }
    }
    try { rec.start() } catch {
      releaseWakeLock()
      setRunning(false)
      cue(hapticSaveFailed)
      say('fail', 'The mic would not start. Tap Start again.')
      noteMiss('The mic would not start.')
    }
  }, [cue, noteMiss, noteScreenSleep, releaseWakeLock, say, scheduleTick])

  const start = useCallback(() => {
    stopRef.current = false
    restartsRef.current = 0
    hiddenRef.current = false
    runningRef.current = true
    setRunning(true)
    // The mic hold spans the RUN, not the recogniser: arm() builds a fresh recogniser on every re-arm
    // (15-22 ms apart), so a per-recogniser hold would open a window on each in which a picker on another
    // surface could take the mic mid-sentence. Evicting DETACHES before aborting (releaseRecogniser), so a
    // final in flight cannot commit into a run already abandoned, and it is announced because a capture
    // flow that goes quiet looks like a dead mic.
    micTokenRef.current = acquireMic('VoiceHarvest', () => {
      stopRef.current = true
      runningRef.current = false
      if (wallRef.current) { clearTimeout(wallRef.current); wallRef.current = null }
      setEndsAt(null)
      releaseRecogniser()
      releaseWakeLock()
      setRunning(false)
      cue(hapticSaveFailed)
      say('warn', 'Another microphone took over — capture stopped.')
      noteMiss('Another microphone took over.')
    })
    setRows((r) => r)   // the ledger persists across a stop/start within the visit
    say('ok', 'Listening — say a crop.')
    // Asked for HERE rather than in an effect because this is the tap: the request descends from a user
    // gesture and the sentinel keeps the whole cue stack alive. Not awaited, so a slow or refused lock
    // cannot delay the mic; the outcome lands on the persistent screen note either way.
    requestWakeLock()

    // A FRESH DEBOUNCER PER RUN: resetSession() would clear duplicate-suppression memory while a pending
    // utterance from the previous run might still be held, which its own docstring warns against.
    // A list that failed to load is asked for again with each run.
    reloadAliasesRef.current?.()
    debRef.current = createCommitDebouncer({
      onCommit: commitWhenNamesKnown,
      onPending: (r) => setHeard(r),
      onSuppressed: (r, reason) => {
        // A swallowed command with no signal is indistinguishable from a dead mic. Say which.
        // Only STALE leaves a miss row: a cooldown suppression means the save happened once and
        // correctly, so counting it as "not captured" would be false.
        if (reason === 'cooldown') say('warn', 'Heard "next" twice in a moment — saved once.')
        else if (reason === 'stale') {
          say('warn', 'That "next" went stale and was not saved. Say it again.')
          noteMiss('A "next" went stale and did not save.')
        }
      },
    })

    arm()
    const until = Date.now() + RUN_BUDGET.runMs
    setEndsAt(until)
    wallRef.current = setTimeout(() => {
      stopRef.current = true
      try { recRef.current?.stop() } catch { /* ignore */ }
      // The sibling of the restart-budget stop in onend, cued the same way: the run ends on a timer while
      // he is mid-sentence in a bed, the shape of loss the cue exists for. The user-initiated stop() below
      // stays silent; he just tapped it.
      cue(hapticSaveFailed)
      say('warn', `Stopped after ${RUN_BUDGET.label}. Tap Start to carry on.`)
      noteMiss(`Stopped after ${RUN_BUDGET.label}.`)
      releaseWakeLock()
    }, RUN_BUDGET.runMs)
  }, [arm, commitWhenNamesKnown, cue, noteMiss, releaseWakeLock, requestWakeLock, say])

  const stop = useCallback(() => {
    stopRef.current = true
    hiddenRef.current = false
    if (wallRef.current) { clearTimeout(wallRef.current); wallRef.current = null }
    setEndsAt(null)
    try { recRef.current?.stop() } catch { /* ignore */ }
    // Released here as well as in onend: a stop() that throws, or one with no recogniser to stop,
    // must not leave the screen pinned awake for the rest of the visit.
    releaseWakeLock()
    say('idle', 'Stopped.')
  }, [releaseWakeLock, say])

  // RELEASE THE MIC ON UNMOUNT, however the page is left. abort() rather than stop(): stop() is the
  // graceful shutdown that asks the engine to FINALISE, and a final dispatched into an unmounted
  // component would commit against nothing.
  useEffect(() => () => {
    stopRef.current = true
    if (wallRef.current) clearTimeout(wallRef.current)
    if (tickRef.current) clearTimeout(tickRef.current)
    // Words held for the alias list die with the page, like a pending utterance in the debouncer below.
    if (heldRef.current) { clearTimeout(heldRef.current.timer); heldRef.current = null }
    releaseRecogniser()
    releaseWakeLock()
    releaseMic(micTokenRef.current)
    micTokenRef.current = null
    debRef.current = null
  }, [releaseRecogniser, releaseWakeLock])

  // Hand the mic back whenever the run stops, HOWEVER it stopped (tap, wall-clock budget, restart budget,
  // any error path). Six sites set stopRef.current = true and share no exit, so keying on the state they
  // all converge on is the only single point that covers them. Not an acquire: mounting must not take the
  // mic; only tapping Start may.
  useEffect(() => {
    if (running) return
    releaseMic(micTokenRef.current)
    micTokenRef.current = null
  }, [running])

  // ── Screen visibility ───────────────────────────────────────────────────────────────────────────
  //
  // The platform releases a screen wake lock whenever the document hides (spec behaviour), so coming back
  // always needs a fresh request; a lock acquired once and assumed to persist stops working the first
  // time he takes a call. Registered unconditionally, not only while running, so the refused-cue report
  // can be delivered on the next visible moment even if the run has ended.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onVisibility = () => {
      if (isHidden()) {
        wakeRef.current = null          // already released by the platform; nothing of ours to free
        if (!runningRef.current) return
        // Release the mic rather than leave one armed behind a dark screen. On Android Chrome has
        // already aborted it; on every other platform this is what stops a live recogniser that
        // nobody can see is running.
        releaseRecogniser()
        noteScreenSleep()
        return
      }
      if (runningRef.current) requestWakeLock()
      const resumed = hiddenRef.current
      if (resumed) {
        hiddenRef.current = false
        // The miss row was written when the interruption happened; this is the recovery. Re-arming without
        // a fresh tap is the same gesture-free re-arm `onend` does (sticky user activation from the Start
        // tap survives for the document's lifetime), and it makes "the screen went off" recoverable rather
        // than the end of the weigh-in.
        if (runningRef.current) {
          arm()
          say('warn', 'The screen went off — listening stopped. Listening again now.')
        }
      }
      const refused = reportRefusedCues()
      // The banner is one slot: the resume message is the more urgent of the two, and the refused-cue
      // report is durable in the strip either way, so it only takes the banner when nothing else needs it.
      if (refused && !resumed) {
        say('warn', `Your phone did not buzz for ${refused} cue${refused === 1 ? '' : 's'} — check the list below.`)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [arm, noteScreenSleep, releaseRecogniser, reportRefusedCues, requestWakeLock, say])

  const tone = TONE[status.tone] ?? TONE.idle
  // Where a held number will land if nothing changes it (heldLandingOf), shown in that slot.
  const heldLanding = useMemo(() => {
    const landing = heldLandingOf(heldNum, qty, weight, selected)
    return landing && { axis: landing.axis, text: `${heldNum} ${landing.unit} (assumed unless you say a unit)` }
  }, [heldNum, qty, weight, selected])
  const savedCount = rows.filter((r) => r.kind === 'save' && !r.undone).length
  const missCount  = rows.filter((r) => r.kind === 'miss').length
  // One line that answers "did everything I said get logged?": "12 saved · 3 not captured". The banner
  // said each miss once and was overwritten, so without a count they are unrecoverable. The second half
  // appears only when there IS one, so a clean session keeps the bare "12 saved".
  const totalLabel = useMemo(() => {
    if (!savedCount && !missCount) return null
    const saved = `${savedCount} saved`
    return missCount ? `${saved} · ${missCount} not captured` : saved
  }, [savedCount, missCount])

  const card = { background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }

  return (
    <div style={{ padding: 16, maxWidth: 680, margin: '0 auto' }} data-testid="voice-harvest">
      {!embedded && (
        <h1 style={{ fontSize: '1.15rem', fontWeight: 700, color: P.dark, margin: '0 0 4px' }}>
          Harvest by voice
        </h1>
      )}
      {/* The copy has to describe the doors that exist: the manual form is one tap away in the selector
          above when embedded. */}
      <p style={{ fontSize: '0.82rem', color: P.light, lineHeight: 1.5, margin: '0 0 14px' }}>
        Say the crop, then the count, then the weight, then <strong>“next”</strong> to save and start
        the following one.{' '}
        {embedded ? 'Prefer to type it? Switch to Manual above.' : 'The manual harvest form is under Log a harvest.'}
      </p>

      {!supported && (
        <div style={{ ...card, background: P.alert, borderColor: P.alertBorder }} role="alert">
          This browser has no speech recognition. Use Log an event instead.
        </div>
      )}
      {loadError && (
        <div style={{ ...card, background: P.alert, borderColor: P.alertBorder }} role="alert">
          {loadError}
        </div>
      )}

      {/* THE LOUD CHANNEL. aria-live so it is announced, role=status so it never steals focus, and large
          enough to read at arm's length with wet hands: a failed capture must be impossible to miss. */}
      <div
        data-testid="voice-harvest-status"
        role="status"
        aria-live="assertive"
        style={{
          ...card, background: tone.bg, borderColor: tone.border, color: tone.fg,
          fontSize: '1.05rem', fontWeight: 600, lineHeight: 1.4, minHeight: 62,
          display: 'flex', alignItems: 'center',
        }}
      >
        {status.text}
      </div>

      {/* The record under construction. Rendered as three named slots rather than a sentence, so a
          missing one is visible as a gap instead of having to be inferred from prose. */}
      <div style={card} data-testid="voice-harvest-record">
        <Slot label="Crop"     value={selected ? (selected.name || selected.variety_ref?.name) : null} />
        {/* Every value in these slots was SPOKEN. Nothing is pre-filled, so a slot reading "—" means the
            words have not been said yet, the only reading that lets a glance at this card be trusted. */}
        {/* A held number is shown in the slot it will land in, with the unit it will get, marked as not
            final ("assumed unless you say a unit", the banner's own words). Hiding it left "—" for words
            that HAVE been said, which breaks the one reading this card promises; shown bare it would look
            like a filled slot. With both slots filled it has nowhere to land; the banner says it will be
            dropped. */}
        <Slot label="Quantity"
              value={qty ? `${qty.value} ${qty.unit}` : heldLanding?.axis === 'quantity' ? heldLanding.text : null} />
        <Slot label="Weight"
              value={weight ? `${weight.value} ${weight.unit}` : heldLanding?.axis === 'weight' ? heldLanding.text : null} />
        <div style={{ marginTop: 6, fontSize: '0.78rem', color: P.light, fontStyle: 'italic' }} data-testid="voice-harvest-heard">
          hearing: {heard ? (heard.transcript || '—') : '—'}
        </div>
      </div>

      {candidates.length > 0 && (
        <div style={card} data-testid="voice-harvest-candidates">
          <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 6, color: P.dark }}>
            {/* THE CAP IS SAID OUT LOUD. The list is capped at CANDIDATE_LIMIT buttons because a crop-type
                utterance can match 46 plantings, but a cap with nothing admitting it reads as "these are
                all of them" and a plant that IS in the list looks absent. */}
            Which one?
            {candidates.length > CANDIDATE_LIMIT
              ? <span style={{ fontWeight: 400, color: P.light }}>
                  {` showing ${CANDIDATE_LIMIT} of ${candidates.length} — say more of the name`}
                </span>
              : null}
          </div>
          {candidates.slice(0, CANDIDATE_LIMIT).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pickPlanting(c)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', minHeight: 44, padding: '10px 12px',
                marginBottom: 6, borderRadius: 8, border: `1px solid ${P.border}`, background: P.cream,
                fontSize: '0.95rem', fontFamily: 'inherit', color: P.dark, cursor: 'pointer',
              }}
            >
              {c.name || c.variety_ref?.name}
              {c.variety_ref?.crop_type_slug ? <span style={{ color: P.light }}> · {c.variety_ref.crop_type_slug}</span> : null}
            </button>
          ))}
        </div>
      )}

      {/* The teach surface. A phrase that matched NOTHING otherwise leaves no way to say what it meant,
          making the case most worth learning from the one that cannot be taught. Typing here is the
          escape hatch from a name the recogniser will never get right AND the moment the correction is
          captured. */}
      {unmatched && (
        <TeachPicker
          phrase={unmatched}
          plantings={plantings}
          onPick={pickPlanting}
          onDismiss={() => { setUnmatched(null); unmatchedRef.current = null }}
        />
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <button
          type="button"
          onClick={running ? stop : start}
          disabled={!supported}
          data-testid="voice-harvest-toggle"
          style={{
            flex: 1, minHeight: 56, borderRadius: 10, border: 'none',
            background: running ? P.terra : P.green, color: P.white,
            fontSize: '1.05rem', fontWeight: 700, fontFamily: 'inherit',
            cursor: supported ? 'pointer' : 'not-allowed', opacity: supported ? 1 : 0.5,
          }}
        >
          {running ? 'Stop listening' : 'Start listening'}
        </button>
      </div>
      {running && endsAt && (
        <p style={{ fontSize: '0.75rem', color: P.light, margin: '0 0 12px' }}>
          The mic stops on its own after {RUN_BUDGET.label}.
        </p>
      )}
      {/* Whether the screen is being held awake, stated rather than assumed: a refused wake lock and a
          holding one look identical from inside the app, and everything else here depends on which it is. */}
      {screenNote && (
        <p data-testid="voice-harvest-screen" style={{ fontSize: '0.75rem', color: P.light, margin: '0 0 12px' }}>
          {screenNote}
        </p>
      )}

      <div style={card} data-testid="voice-harvest-ledger">
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: P.dark, marginBottom: 6 }}>
          {totalLabel ?? 'Nothing saved yet'}
        </div>
        {rows.map((r, i) => (r.kind === 'save' ? (
          <div
            key={`${r.at}-${i}`}
            data-testid="voice-harvest-row"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
              borderTop: i === 0 ? 'none' : `1px solid ${P.border}`,
              opacity: r.undone ? 0.45 : 1,
              textDecoration: r.undone ? 'line-through' : 'none',
            }}
          >
            <span style={{ flex: 1, fontSize: '0.9rem', color: P.dark }}>
              {r.label} <span style={{ color: P.light }}>· {r.said}</span>
            </span>
            {!r.undone && r.eventId && (
              <button
                type="button"
                onClick={() => undoRow(i)}
                aria-label={`Undo ${r.label} ${r.said}`}
                style={{
                  minHeight: 44, padding: '0 14px', borderRadius: 8,
                  border: `1px solid ${P.border}`, background: P.white,
                  fontSize: '0.85rem', fontFamily: 'inherit', color: P.terra, cursor: 'pointer',
                }}
              >
                Undo
              </button>
            )}
          </div>
        ) : (
          // A miss row, and a refused-cue note, share the strip with the saves: the strip is the only thing
          // here still true a minute later, and a reconciliation surface listing only successes reconciles
          // nothing. Informational: never blocking or dismissable. A note is styled like a miss but NOT
          // counted in the header: nothing was lost, a channel was.
          <div
            key={`${r.at}-${i}`}
            data-testid={r.kind === 'note' ? 'voice-harvest-note' : 'voice-harvest-miss'}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
              borderTop: i === 0 ? 'none' : `1px solid ${P.border}`,
            }}
          >
            <span style={{ flex: 1, fontSize: '0.85rem', color: P.light, fontStyle: 'italic' }}>
              {r.text}
            </span>
          </div>
        )))}
      </div>
    </div>
  )
}

// Resolve a phrase the recogniser mangled beyond matching, and teach it.
//
// A plain text input, deliberately not the PlantingSelect combobox: that owns its own microphone, and
// mounting it here would put a second recogniser on a page that already has one running (the collision
// micArbiter exists to prevent). This filters the plantings already in memory: no fetch, no mic.
//
// Typing is the point: the user reaches this because speech failed, so the input opens with the keyboard
// available, the opposite default from the voice-first pickers.
function TeachPicker({ phrase, plantings, onPick, onDismiss }) {
  const [q, setQ] = useState('')
  const matches = useMemo(() => {
    const query = q.trim()
    if (!query) return []
    return plantings
      .filter((p) => plantingAliases(p).some((a) => looseIncludes(a, query)))
      .slice(0, 8)
  }, [q, plantings])

  return (
    <div
      data-testid="voice-harvest-teach"
      style={{
        background: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
        padding: 12, marginBottom: 12,
      }}
    >
      <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 2, color: P.dark }}>
        What did you mean by “{phrase}”?
      </div>
      <div style={{ fontSize: '0.78rem', color: P.light, marginBottom: 8, lineHeight: 1.4 }}>
        Type it and pick one — I’ll remember that “{phrase}” means that from now on.
      </div>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Start typing a crop or variety"
        aria-label={`What did you mean by ${phrase}`}
        style={{
          width: '100%', minHeight: 44, padding: '8px 10px', boxSizing: 'border-box',
          borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '1rem',
          fontFamily: 'inherit', color: P.dark, background: P.cream, marginBottom: 8,
        }}
      />
      {matches.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onPick(m)}
          style={{
            display: 'block', width: '100%', textAlign: 'left', minHeight: 44, padding: '10px 12px',
            marginBottom: 6, borderRadius: 8, border: `1px solid ${P.border}`, background: P.cream,
            fontSize: '0.95rem', fontFamily: 'inherit', color: P.dark, cursor: 'pointer',
          }}
        >
          {m.name || m.variety_ref?.name}
          {m.variety_ref?.crop_type_slug
            ? <span style={{ color: P.light }}> · {m.variety_ref.crop_type_slug}</span> : null}
        </button>
      ))}
      <button
        type="button"
        onClick={onDismiss}
        style={{
          minHeight: 44, padding: '0 14px', borderRadius: 8, border: `1px solid ${P.border}`,
          background: P.white, fontSize: '0.85rem', fontFamily: 'inherit', color: P.light,
          cursor: 'pointer',
        }}
      >
        Skip — just say it again
      </button>
    </div>
  )
}

function Slot({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '4px 0', fontSize: '0.95rem' }}>
      <span style={{ width: 76, flex: '0 0 auto', color: P.light }}>{label}</span>
      <span style={{ color: value ? P.dark : P.light, fontWeight: value ? 600 : 400 }}>
        {value ?? '—'}
      </span>
    </div>
  )
}
