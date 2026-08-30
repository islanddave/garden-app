// src/lib/voiceAliases.js
// V5-VOICEALIAS-001 — the learned-mishearing layer for the /log/voice planting chooser.
//
// WHERE THIS SITS. Three layers now answer "which planting did he just say", in strict order:
//   1. matchPlantings          — exact/substring on the collapsed key. Unchanged, still first.
//   2. THIS FILE               — a mishearing the user has already corrected, once, by hand.
//   3. voiceFuzzyMatch         — closed-set scoring, for a mishearing nobody has taught yet.
// Learned beats fuzzy deliberately: a human said so, and no score outranks that. Fuzzy is a guess
// that is right 77% of the time; an alias is a fact.
//
// WHY IT IS NOT MERGED INTO voiceFuzzyMatch. That module is pure, synchronous and network-free,
// which is what let its thresholds be measured over 750 adversarial utterances offline. This layer
// is none of those things — it fetches, it caches, it fails soft. Keeping them apart means a network
// problem here can never change a matching decision there.
//
// EVERYTHING HERE FAILS SOFT, and that asymmetry is the design:
//   * a failed READ degrades the chooser to exactly its v4.78.0 behaviour (fuzzy only). Voice harvest
//     keeps working; the user loses only the corrections they had taught.
//   * a failed WRITE must be LOUD. The moment someone teaches a correction is the moment they have
//     already been let down once, and a teach that silently did nothing would let them believe it was
//     fixed and meet the same failure tomorrow. So teachAlias REJECTS and the caller says so.

// The client's normalisation contract, imported rather than re-derived: heard_key must be exactly
// what looseKey produces, or a stored alias can never match a live utterance. The server enforces the
// same shape (voice_alias_heard_key_normalised_chk) so a drift is a 400, not silent nonsense.
import { looseKey } from './comboboxInput.js'

// Mirrors voiceFuzzyMatch.MIN_QUERY_CHARS. A shorter phrase is refused by the matcher anyway, so
// teaching one could only ever create a row nothing reads.
export const MIN_ALIAS_CHARS = 4

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
 * Returns [] when nothing is learned for the phrase, so the caller falls through to fuzzy — an empty
 * result here is "no opinion", never "no match".
 *
 * AN ALIAS NAMES A VARIETY, NOT A PLANTING, so this returns EVERY live planting of that variety and
 * the caller still disambiguates. That is not a weakness of the storage choice, it is the point of
 * it: plantings are seasonal and a planting-scoped alias would expire every winter. Where a variety
 * has several live plantings (46 tomato, 38 pepper on prod) the existing "Which one?" list handles it
 * exactly as it does for a strict match — the alias narrows the field from 239 to a handful, which is
 * all it ever claimed to do.
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
 * Fetch the caller's aliases. FAILS SOFT — returns [] on any error, because a chooser that refuses to
 * work because a cache could not load is worse than one that has forgotten a few corrections.
 * `apiFetch` is injected so this is testable without the Clerk-authenticated wrapper.
 */
export async function fetchAliases(apiFetch) {
  try {
    const res = await apiFetch('/api/varieties/voice-aliases')
    return Array.isArray(res?.aliases) ? res.aliases : []
  } catch {
    return []
  }
}

/**
 * Teach one correction. DOES NOT SWALLOW ERRORS — see the header. The caller must surface a failure,
 * because a silent no-op here is indistinguishable from success to the person who just corrected the
 * app and is about to trust it again.
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
