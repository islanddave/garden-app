// src/lib/voiceFuzzyMatch.js
//
// V5-VOICEFUZZYMATCH-001: closed-vocabulary rescue for the /log/voice planting chooser.
//
// WHY THIS IS A MATCHER AND NOT A RECOGNISER SETTING. Chrome's Web Speech on Android re-ranks candidate
// words by how likely they are in general English: "Suyo" carries essentially no prior, "studio" is common
// and acoustically adjacent, so "suyo long" comes back as "studio long" however clearly it is said. The
// substitution is driven by the word prior, not the audio, and recurs for every uncommon cultivar.
//
// THE REFRAME: this is not open dictation but selection from a list the user owns. The question is not
// "did the recogniser get it right" but "which of my plantings is this closest to". A scorer that would be
// reckless against open text is safe against a few hundred known rows, and this module lives ENTIRELY
// inside the permissive search branch of voiceHarvestGrammar.js (a wrong search shows the wrong list,
// which is visible and correctable). It never sees a command and never sees a number.
//
// MEASURED against the real 590-name variety+crop vocabulary (a deliberate superset of the live
// plantings, so pessimistic): "studio long" -> Suyo Long 0.700, runner-up Ping Tung Long 0.429, margin
// 0.271. Self-recall is 587/590; the 3 misses are reversed-word DUPLICATE ROWS in the data (Yellow
// Brandywine / Brandywine Yellow, Green Cherokee / Cherokee Green, Black Hungarian / Hungarian Black),
// which score 1.000 against each other and are ambiguous to a human too.
//
// WHAT IT DOES NOT FIX. 90 pairs in that vocabulary score >0.70 against EACH OTHER, so an absolute
// threshold alone is not a safe auto-select rule: the MARGIN gate below is the load-bearing guard. And it
// does not rescue spoken number words against digit-named plantings ("eighteen eighty four" vs 1884); edit
// distance cannot bridge that, so foldNumberWords in voiceHarvestGrammar.js owns it.
//
// NO PHONETIC CODING (metaphone/soundex): it does not help the measured case (soundex splits "studio"
// from "suyo"), and an unmeasured second signal is how thresholds stop meaning anything. Revisit only
// with device evidence.

// ── tuning constants, all three load-bearing ────────────────────────────────────────────────────
// Nothing below MIN_SCORE is ever offered, not even as a candidate. Set under the measured 0.700 of the
// real failure and well above the 0.429 noise floor of that same query.
export const MIN_SCORE = 0.62

// The top hit must beat the best score from a DIFFERENT planting by this much to be auto-selected. This,
// not MIN_SCORE, makes auto-selection safe: "scored high" is not evidence of "scored uniquely" (90
// vocabulary pairs score >0.70 against each other). The measured margin for studio->suyo is 0.271; this
// sits at less than half of it.
export const AUTO_MARGIN = 0.12

// Fuzzy refuses to run on a short utterance: a 2-3 character fragment scores noisily against everything,
// and the honest "nothing matched" is an answer the user already knows how to handle.
export const MIN_QUERY_CHARS = 4

// Levenshtein. Two rolling rows rather than a full matrix: the inputs are short (a cultivar name and
// a phrase) and this runs across every alias of every live planting on each utterance.
export function editDistance(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

export function similarity(a, b) {
  const longest = Math.max(a.length, b.length)
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest
}

// Split on the same separators looseKey() collapses, so tokenisation and keying agree about what a word
// boundary is; disagreement would make the whole-string floor below incoherent.
//
// BUG-LOOSEKEYREPEAT-001 (A) put '_' into looseKey's separator class so a snake_case crop-type slug keys
// the same as the words a human says for it. Without the matching '_' here 'bunching_onion' stayed ONE
// token while "bunching onion" arrives as two. The exact phrase is unaffected (the whole-string floor
// takes it), but a REORDERED utterance ("onion bunching") flips from 'none' to the correct row: one token
// cannot be re-ordered against two, which is what the consumption rule (property 2) exists to do. So the
// floor covers the utterance that IS the whole alias, and the token half carries every reading that is
// reordered or padded.
//
// THE INVARIANT IS ONE-DIRECTIONAL, and voiceFuzzyMatch.agreement.test.js pins that direction: every
// character looseKey REMOVES must also be a boundary here. The converse is harmless (splitting on
// something looseKey keeps only makes tokens finer, and the floor still compares whole keys).
//
// The digit-scoped repeat-collapse in looseKey needs no matching edit here: this function only SPLITS,
// and every collapse happens inside the injected `keyOf`, applied to each token and to the whole string
// alike.
export function tokens(s) {
  return String(s ?? '').toLowerCase().split(/[\s\-'’._]+/).filter(Boolean)
}

/**
 * WHY TOKEN-AWARE AND NOT JUST WHOLE-STRING. Cultivar names are multi-word and the recogniser mangles the
 * RARE word while getting the common one right ("Suyo Long" -> "studio long", "long" intact). Per-token
 * scoring lets the intact word carry real evidence instead of being averaged away by the damaged one.
 *
 * Three properties that each exist to stop a specific wrong answer:
 *   1. LENGTH WEIGHTING — a matched "long" (4) must not outvote a mangled "suyo" (4→studio). Tokens
 *      contribute in proportion to their length, so a short exact hit cannot carry a long miss.
 *   2. CONSUMPTION — an alias token is used at most once, so a spoken phrase cannot satisfy two of
 *      its own tokens against the same word ("long long" scoring full marks against "Suyo Long").
 *   3. UNMATCHED ALIAS TOKENS ARE PENALISED — without this, "cucumber" scores 1.000 against
 *      "Cucumber Beetle Trap Crop" and a one-word utterance drags in every long name containing it.
 *      The strict matcher already handles genuine substring hits; fuzzy must not out-rank them.
 *
 * `keyOf` is injected rather than imported so this module has no dependency on the picker cluster and
 * the tests can pin the scorer without a DOM. Callers pass comboboxInput's looseKey.
 */
export function scoreAlias(spoken, alias, keyOf) {
  const spokenToks = tokens(spoken)
  const aliasToks = tokens(alias)
  if (!spokenToks.length || !aliasToks.length) return 0

  const pool = aliasToks.map(keyOf)
  let matched = 0
  let total = 0

  for (const t of spokenToks) {
    const key = keyOf(t)
    if (!key) continue
    let best = 0
    let bestIdx = -1
    for (let i = 0; i < pool.length; i++) {
      if (pool[i] == null) continue
      const s = similarity(key, pool[i])
      if (s > best) { best = s; bestIdx = i }
    }
    if (bestIdx >= 0) pool[bestIdx] = null      // consume — property 2
    matched += best * key.length                 // property 1
    total += key.length
  }
  for (const leftover of pool) {
    if (leftover != null) total += leftover.length   // property 3
  }

  const tokenScore = total ? matched / total : 0

  // WHOLE-STRING FLOOR. The recogniser disagrees with the stored name about word boundaries as often as
  // about letters ("Sunray" -> "sun ray", "brandy wine" -> "Brandywine"). Comparing the collapsed keys is
  // immune to that, so the better of the two readings wins (both are similarities on the same 0..1
  // scale, so max() is meaningful).
  return Math.max(tokenScore, similarity(keyOf(spoken), keyOf(alias)))
}

/**
 * Rank every planting by its best-scoring alias. Pure, and sorted best-first.
 * Returns [{ planting, score, alias }].
 */
export function rankPlantings(plantings, spoken, aliasesOf, keyOf) {
  const out = []
  for (const planting of plantings ?? []) {
    let best = 0
    let bestAlias = null
    for (const alias of aliasesOf(planting)) {
      const s = scoreAlias(spoken, alias, keyOf)
      if (s > best) { best = s; bestAlias = alias }
    }
    if (bestAlias != null) out.push({ planting, score: best, alias: bestAlias })
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * The decision. Returns one of:
 *   { kind: 'none' }                                    — refuse; caller says "nothing matched"
 *   { kind: 'one',  planting, score, alias, margin }    — confident enough to select
 *   { kind: 'many', hits: [{planting,score,alias}] }    — offer the "Which one?" list
 *
 * A 'one' NEVER saves anything by itself — it fills the Crop slot, and the caller announces the
 * correction out loud ("Heard X, matched Y") so a wrong rescue is visible and correctable before any
 * "next". That announcement is the difference between this and a silent wrong save; do not drop it.
 */
export function fuzzyMatch(plantings, spoken, aliasesOf, keyOf, opts = {}) {
  const minScore = opts.minScore ?? MIN_SCORE
  const autoMargin = opts.autoMargin ?? AUTO_MARGIN
  const minChars = opts.minChars ?? MIN_QUERY_CHARS

  if (keyOf(spoken).length < minChars) return { kind: 'none' }

  const all = rankPlantings(plantings, spoken, aliasesOf, keyOf)
  const ranked = all.filter((r) => r.score >= minScore)
  if (!ranked.length) return { kind: 'none' }

  const top = ranked[0]
  // THE MARGIN IS MEASURED AGAINST THE FULL RANKING, NOT THE FILTERED ONE; otherwise the guard is decorative.
  //
  // Against the filtered list, when only ONE planting clears minScore there is no rival, the margin
  // degenerates to "infinity", and a barely-passing score auto-selects unchecked (the single wrong
  // auto-select in the 750-utterance adversarial sweep: "goldeersgold" selected Goldenrod at 0.636, margin
  // 1.000, because Gatherer's Gold, the row it derived from, had been filtered out). It also made the
  // threshold NON-MONOTONIC: raising minScore from 0.64 to 0.68 made results worse (0 wrong -> 2 wrong),
  // because a higher floor removes rivals and hands out free passes.
  //
  // Against the unfiltered ranking, a near neighbour is evidence of ambiguity whether or not it cleared
  // the bar, so the runner-up a mishearing was derived FROM acts as its own guard.
  //
  // The rival must be a DIFFERENT planting: two aliases of the SAME row scoring alike is agreement, not
  // ambiguity, and refusing there would make a planting whose name and variety_ref.name are identical
  // permanently unselectable.
  const rival = all.find((r) => r.planting !== top.planting)
  const margin = rival ? top.score - rival.score : 1

  if (margin >= autoMargin) {
    return { kind: 'one', planting: top.planting, score: top.score, alias: top.alias, margin }
  }
  return { kind: 'many', hits: ranked }
}
