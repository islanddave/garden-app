// The pure matching and wording logic of the voice harvest screen (src/pages/VoiceHarvest.jsx): planting
// name matching with its rescue layers, the one-breath readers and the sentences the screen announces.
// Nothing here touches React, the DOM or the network. The screen re-exports the names tests import from it.
import { looseKey, looseIncludes } from './comboboxInput.js'
import { fuzzyMatch } from './voiceFuzzyMatch.js'
import { resolveAlias, MIN_ALIAS_CHARS } from './voiceAliases.js'
import {
  buildValue, foldNumberWords, isNumberPhrase, normalise, NUMBER_HOMOPHONES,
} from './voiceHarvestGrammar.js'

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
// `crop_aliases` is attached to each row by the page (VoiceHarvest.jsx). A row without it — no vocabulary
// loaded, or a crop type with no aliases, which is most of them — yields exactly the three terms it
// always did.
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
export const assumedPhrase = (v) => `${v.value} ${v.unit} assumed${v.implausible ? ' — that looks high' : ''}`

// Where a held number will land if nothing changes it: the same slot order placeHeld uses (the crop's
// default unit into an empty quantity, else grams into an empty weight), and the axis from buildValue.
// Shared by the held-number card and the restatement's replaced-value note.
export function heldLandingOf(held, qty, weight, selected) {
  if (held == null) return null
  const unit = qty == null ? (selected?.variety_ref?.default_unit || 'count') : weight == null ? 'g' : null
  const built = unit ? buildValue(held, unit, '') : null
  if (!built || (built.kind === 'weight' ? weight : qty) != null) return null
  return { axis: built.kind, value: built.value, unit: built.unit }
}

// The one wording of amounts a crop change took off the record: the banner note, the strip row and the
// debug mark. Shared by the switch itself, by a failed save that had sent them, and by the other doors
// that take values off the record, so the row reads the same whichever finds it true.
export function switchWords(amountsCleared, planting) {
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
