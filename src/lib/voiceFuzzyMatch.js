// src/lib/voiceFuzzyMatch.js
//
// V5-VOICEFUZZYMATCH-001 — closed-vocabulary rescue for the /log/voice planting chooser.
//
// THE BUG THIS EXISTS FOR (Dave, 2026-08-30, verbatim): "Saying suyo long in the app is getting
// transcribed as studio long. I don't understand why even though I said it very clearly and tried it
// multiple times, and it still picked up studio long. This is a full stop on that work."
//
// WHY SAYING IT CLEARLY CANNOT HELP, which is the whole reason this module is a MATCHER and not a
// recogniser setting. Chrome's Web Speech on Android decodes audio and then re-ranks the candidate
// words by how likely they are in general English. "Suyo" carries essentially no prior; "studio" is
// common and acoustically adjacent. The substitution is driven by the word prior, not by the audio,
// so better diction improves the side that was never losing. It is structural, it is not Dave's
// diction, and it will recur on every uncommon cultivar he grows.
//
// THE REFRAME THAT MAKES IT SOLVABLE. This is not open dictation — it is selection from a list the
// user owns. The right question is not "did the recogniser get it right" but "which of my plantings
// is this closest to". A scorer that would be reckless against open text is safe against ~239 known
// rows, and the shipped design already says so at the search branch in voiceHarvestGrammar.js: "a
// wrong search shows the wrong list, which Dave sees and corrects, whereas a wrong command or a wrong
// number is committed silently." This module lives ENTIRELY inside that permissive branch. It never
// sees a command and never sees a number.
//
// MEASURED BEFORE IT WAS WRITTEN, against the real 590-name variety+crop vocabulary pulled from prod
// (a deliberate SUPERSET of the live-planting set the matcher actually sees, so these are the
// pessimistic numbers):
//   "studio long"  ->  Suyo Long 0.700  |  runner-up Ping Tung Long 0.429  |  margin 0.271
//   self-recall: 587/590 names spoken correctly rank themselves first.
// The 3 that do not are reversed-word DUPLICATE ROWS in the data, not matcher failures:
// Yellow Brandywine/Brandywine Yellow, Green Cherokee/Cherokee Green, Black Hungarian/Hungarian
// Black. They score 1.000 against each other and are genuinely ambiguous to a human too.
//
// WHAT IT DOES NOT FIX, stated so nobody assumes otherwise. 90 pairs in that vocabulary score >0.70
// against EACH OTHER, so an absolute threshold alone is not a safe auto-select rule — hence the
// MARGIN gate below, which is the load-bearing guard. And it does not rescue spoken number words
// against digit-named plantings ("eighteen eighty four" ranks helichrysum 0.353 against a planting
// literally named 1884); edit distance cannot bridge that in principle, and that case needs
// number-word digitisation in the key, owned separately.
//
// WHY NO PHONETIC CODING (metaphone/soundex), which is the obvious reach. It does not help the case
// that was actually measured: soundex("studio")=S330 vs soundex("suyo")=S000, metaphone likewise
// splits them. Adding an unmeasured second signal to a safety-relevant scorer is how thresholds stop
// meaning anything. Edit distance alone is what the data supports, so edit distance alone is what
// ships. Revisit only with device evidence.

// ── tuning constants, all three load-bearing ────────────────────────────────────────────────────
// Nothing below MIN_SCORE is ever offered, not even as a candidate. Set under the measured 0.700 of
// the real failure with room to spare, and well above the 0.429 noise floor that same query produced.
export const MIN_SCORE = 0.62

// The top hit must beat the best score from a DIFFERENT planting by this much to be auto-selected.
// This, not MIN_SCORE, is the guard that makes auto-selection safe: 90 vocabulary pairs score >0.70
// against each other, so "scored high" is not evidence of "scored uniquely". The measured margin for
// studio->suyo is 0.271, so this sits at less than half the real case.
export const AUTO_MARGIN = 0.12

// Fuzzy refuses to run on a short utterance. A 2-3 character fragment scores noisily against
// everything, and the cost of refusing is the honest "nothing matched" the user already knows how to
// answer. "studiolong" is 10.
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

// Split on the same separators looseKey() collapses, so tokenisation and keying agree about what a
// word boundary is. Disagreement between the two would make the whole-string floor below incoherent.
//
// BUG-LOOSEKEYREPEAT-001 (A) put '_' into looseKey's separator class, so a snake_case crop-type slug
// finally keys the same as the words a human says for it. Without the matching '_' here the two
// disagreed: 'bunching_onion' stayed ONE token while "bunching onion" arrives as two.
//
// WHAT THAT ACTUALLY COST, swept rather than argued (all 10 underscore crop types × 72 utterances,
// scored under the post-merge looseKey with only this line differing):
//   * the EXACT phrase is unaffected — "bunching onion" vs 'bunching_onion' scores 1.000 either way,
//     because the whole-string floor takes it. Anyone reasoning only from that case would conclude
//     this line does not matter.
//   * a REORDERED utterance flips outright. "onion bunching" -> fuzzyMatch 'none' before, 'one' at
//     1.000 after, and identically for all ten (potato sweet, balm bee, plant spider, maple japanese,
//     cactus christmas, verbena lemon, raspberry red, melon bitter, mix flower). One token cannot be
//     re-ordered against two; that is precisely what the consumption rule (property 2) exists to do,
//     and mis-tokenising the alias disables it.
//   * every other decision in the sweep is unchanged — the only movement is 'none' -> the correct
//     row, never a new or different auto-select.
// So the floor covers the utterance that IS the whole alias, and the token half carries every reading
// that is reordered or padded. The agreement is load-bearing exactly as the paragraph above claimed.
//
// THE INVARIANT IS ONE-DIRECTIONAL, and voiceFuzzyMatch.agreement.test.js pins that direction rather
// than string-comparing the two regexes: every character looseKey REMOVES must also be a boundary
// here. The converse is harmless — splitting on something looseKey keeps only makes tokens finer, and
// the floor still compares whole keys — which is why this correction is safe to land before, with, or
// after the looseKey change itself.
//
// Defect (B), the digit-scoped repeat-collapse, needs NO matching edit here and that was checked
// rather than assumed: this function only SPLITS. Every collapse happens inside the injected `keyOf`,
// which is applied to each token and to the whole string alike, so both sides of every comparison
// move together whatever the collapse does.
export function tokens(s) {
  return String(s ?? '').toLowerCase().split(/[\s\-'’._]+/).filter(Boolean)
}

/**
 * Token-aware similarity of a spoken phrase against one alias string, 0..1.
 *
 * WHY TOKEN-AWARE AND NOT JUST WHOLE-STRING. Cultivar names are multi-word and the recogniser mangles
 * the RARE word while getting the common one right — "Suyo Long" comes back as "studio long", with
 * "long" perfectly intact. Scoring per token lets the intact word carry real evidence instead of
 * being averaged away by the damaged one.
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

  // WHOLE-STRING FLOOR. The recogniser disagrees with the stored name about word boundaries as often
  // as about letters ("Sunray" -> "sun ray", "brandy wine" -> "Brandywine"). Comparing the collapsed
  // keys is immune to that, so the better of the two readings wins rather than the tokenisation
  // accident deciding. Both are similarities on the same 0..1 scale, so max() is meaningful.
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
  // THE MARGIN IS MEASURED AGAINST THE FULL RANKING, NOT THE FILTERED ONE, and that distinction is
  // the difference between a working guard and a decorative one.
  //
  // Measuring it against the filtered list means that when only ONE planting clears minScore there is
  // no rival to compare against, the margin degenerates to "infinity", and a barely-passing score
  // auto-selects with nothing checking it. That is not hypothetical — it is the single wrong
  // auto-select in the 750-utterance adversarial sweep: "goldeersgold" selected Goldenrod at 0.636
  // (threshold 0.62) reporting a margin of 1.000, because the row it was actually derived from,
  // Gatherer's Gold, had been filtered out from underneath the comparison.
  //
  // It also made the threshold NON-MONOTONIC, which is how the bug announced itself: raising minScore
  // from 0.64 to 0.68 made results WORSE (0 wrong -> 2 wrong), because a higher floor removes more
  // rivals and hands out more free passes. A guard that gets weaker as you tighten it is not a guard.
  //
  // Comparing against the unfiltered ranking fixes both: a near neighbour is real evidence of
  // ambiguity whether or not it cleared the bar, so the runner-up a mishearing was derived FROM now
  // acts as its own guard.
  //
  // The rival must be a DIFFERENT planting. Two aliases of the SAME row scoring alike is agreement,
  // not ambiguity — refusing there would make a planting whose name and variety_ref.name are
  // identical permanently unselectable, which is the ordinary case rather than an edge one.
  const rival = all.find((r) => r.planting !== top.planting)
  const margin = rival ? top.score - rival.score : 1

  if (margin >= autoMargin) {
    return { kind: 'one', planting: top.planting, score: top.score, alias: top.alias, margin }
  }
  return { kind: 'many', hits: ranked }
}
