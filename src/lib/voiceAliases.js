// src/lib/voiceAliases.js
// V5-VOICEALIAS-001: the learned-mishearing layer for the /log/voice planting chooser.
//
// WHERE THIS SITS. Three layers answer "which planting did the user just say", in strict order:
//   1. matchPlantings  - exact/substring on the collapsed key. Unchanged, still first.
//   2. THIS FILE       - a mishearing the user has already corrected, once, by hand.
//   3. voiceFuzzyMatch - closed-set scoring, for a mishearing nobody has taught yet.
// Learned beats fuzzy deliberately: a human said so, and no score outranks that (fuzzy is a guess; an
// alias is a fact).
//
// WHY IT IS NOT MERGED INTO voiceFuzzyMatch. That module is pure, synchronous and network-free, which is
// what let its thresholds be measured offline. This layer fetches, caches and fails soft, so keeping
// them apart means a network problem here can never change a matching decision there.
//
// EVERYTHING HERE FAILS SOFT, and that asymmetry is the design:
//   * a failed READ degrades the chooser to fuzzy only. Voice harvest keeps working; the user loses only
//     the corrections they had taught.
//   * a failed WRITE must be LOUD. A teach that silently did nothing would let the user believe it was
//     fixed and meet the same failure tomorrow. So teachAlias REJECTS and the caller says so.
//   * a failed USE COUNT is SILENT (recordAliasUse). It is bookkeeping about a write that already landed,
//     so it may never cost the user anything.
//
// BUG-VOICEALIASFAILSOFT-001: A FAILED READ IS null, NOT []. "Nothing taught" and "taught names could not
// be read" were the same empty list, and the harvest page's one-breath reader acts on the difference:
// with the list loaded, "cucumber one" is a taught NAME; with it missing, the same words read as the
// crop "cucumber" plus an amount of 1, and a following "next" saved a 1 count nobody said. Soft still
// means never rejecting; the caller decides what "unknown" costs.

// The client's normalisation contract, imported rather than re-derived: heard_key must be exactly
// what looseKey produces, or a stored alias can never match a live utterance. The server enforces the
// same shape (voice_alias_heard_key_normalised_chk) so a drift is a 400, not silent nonsense.
import { looseKey } from './comboboxInput.js'

// Mirrors voiceFuzzyMatch.MIN_QUERY_CHARS. A shorter phrase is refused by the matcher anyway, so
// teaching one could only ever create a row nothing reads.
export const MIN_ALIAS_CHARS = 4

// The most taught names one use count may carry — the PATCH /api/varieties/voice-aliases limit
// (lambda/varieties/index.js), which refuses the whole request past it. One number on both sides:
// lambda/varieties/voice-alias-use.test.js runs the handler at exactly this and at one more.
export const MAX_ALIAS_USES = 20

/**
 * Index the server's alias rows for lookup. Pure — no fetch, so the resolver is testable alone.
 * Returns a Map from heard_key to variety_id.
 *
 * Later rows win on a duplicate key. The server's UNIQUE (user_id, heard_key) means that cannot
 * happen today; this is here so that if it ever does, the behaviour is defined rather than
 * whichever-came-first.
 */
export function indexAliases(rows) {
  const byKey = new Map()
  for (const r of rows ?? []) {
    const key = String(r?.heard_key ?? '')
    const varietyId = r?.variety_id
    if (!key || !varietyId) continue
    byKey.set(key, varietyId)
  }
  return byKey
}

/**
 * Resolve a spoken phrase to the plantings of a learned variety.
 *
 * Returns [] when nothing is learned for the phrase, so the caller falls through to fuzzy: an empty
 * result here is "no opinion", never "no match".
 *
 * AN ALIAS NAMES A VARIETY, NOT A PLANTING, so this returns EVERY live planting of that variety and the
 * caller still disambiguates. Plantings are seasonal, so a planting-scoped alias would expire every
 * winter. Where a variety has several live plantings the existing "Which one?" list handles it as for a
 * strict match: the alias narrows the field, which is all it claims to do.
 */
export function resolveAlias(aliasIndex, spoken, plantings) {
  if (!aliasIndex || !aliasIndex.size) return []
  const key = looseKey(spoken)
  if (key.length < MIN_ALIAS_CHARS) return []
  const varietyId = aliasIndex.get(key)
  if (!varietyId) return []
  return (plantings ?? []).filter((p) => p?.variety_ref?.id === varietyId)
}

/**
 * Fetch the caller's aliases. FAILS SOFT: never rejects, because a chooser that refuses to work because
 * a cache could not load is worse than one that has forgotten a few corrections. `apiFetch` is injected
 * so this is testable without the Clerk-authenticated wrapper.
 *
 * Returns the rows when the list LOADED ([] means nothing taught) and null when it did not: any error,
 * or a payload with no `aliases` array (the GET always sends one). null is "unknown"; a caller that
 * treats it as [] guesses the taught names away.
 */
export async function fetchAliases(apiFetch) {
  try {
    const res = await apiFetch('/api/varieties/voice-aliases')
    return Array.isArray(res?.aliases) ? res.aliases : null
  } catch {
    return null
  }
}

/**
 * BUG-VOICEALIASHITCOUNT-001: count a USE of taught aliases. `uses` is [{ heard_key, variety_id }], sent
 * after the write each alias led to has landed. It feeds voice_alias.hit_count and last_used_at, which
 * say which aliases are load-bearing and which are one-off noise worth pruning.
 *
 * FIRE AND FORGET, by contract: nothing awaits it, it never rejects and never throws, so a failed or
 * slow count cannot block, delay or fail the write it follows. The variety rides along so the server
 * credits the meaning that was used (a phrase re-taught to another variety in between is not credited
 * for the old one).
 *
 * PATCH on the existing route, not a new one: the varieties Lambda owns voice_alias, and a new endpoint
 * is the four-wiring hazard lambda/varieties/index.js records above these routes.
 *
 * AT MOST MAX_ALIAS_USES KEYS, DISTINCT FIRST. The server refuses a longer list outright (a 400 for the
 * whole request, which this function swallows by contract), so an uncapped list of 21 would count
 * NOTHING, silently. A repeated phrase is one use and must not take a slot, so duplicates go first (the
 * first occurrence wins), then the list stops at the cap. This is the one place a count is sent from, so
 * it caps the harvest page and Log many alike.
 */
export function recordAliasUse(apiFetch, uses) {
  const seen = new Set()
  const used = []
  for (const u of uses ?? []) {
    if (!u?.heard_key || !u?.variety_id) continue
    const key = String(u.heard_key)
    if (seen.has(key)) continue
    seen.add(key)
    used.push({ heard_key: key, variety_id: String(u.variety_id) })
    if (used.length === MAX_ALIAS_USES) break
  }
  if (!used.length) return
  try {
    Promise.resolve(apiFetch('/api/varieties/voice-aliases', {
      method: 'PATCH',
      body: JSON.stringify({ used }),
    })).catch(() => {})
  } catch { /* a count is never worth a thrown error */ }
}

/**
 * Teach one correction. DOES NOT SWALLOW ERRORS (see the header): a silent no-op is indistinguishable
 * from success to the person who just corrected the app and is about to trust it again.
 *
 * Returns the stored row. Throws on validation failure or transport failure.
 */
export async function teachAlias(apiFetch, { heardText, varietyId }) {
  const heardKey = looseKey(heardText)
  // Checked here as well as server-side so the common failure is a clear local refusal rather than a
  // round trip that returns 400 — and so a caller that wires this up wrong finds out immediately.
  if (heardKey.length < MIN_ALIAS_CHARS) {
    throw new Error(`Too short to remember (${MIN_ALIAS_CHARS} characters minimum)`)
  }
  if (!varietyId) throw new Error('No variety to remember it against')

  return apiFetch('/api/varieties/voice-aliases', {
    method: 'POST',
    body: JSON.stringify({
      heard_key: heardKey,
      heard_text: String(heardText),
      variety_id: varietyId,
    }),
  })
}
