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
//   * a failed USE COUNT is SILENT (recordAliasUse). It is bookkeeping about a write that already
//     landed; nothing the user did depends on it, so it may never cost them anything.
//
// BUG-VOICEALIASFAILSOFT-001 — A FAILED READ IS null, NOT []. "He has taught nothing" and "his taught
// names could not be read" were the same empty list, and the harvest page's one-breath reader acts on
// the difference: with his list loaded, "cucumber one" is a NAME (taught 2026-09-15 for Suyo Long);
// with it missing, the same words read as the crop "cucumber" plus an amount of 1, and "cucumber one",
// "next" saved a 1 count he never said. Soft still means never rejecting — the caller decides what
// "unknown" costs.

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
 * Fetch the caller's aliases. FAILS SOFT — never rejects, because a chooser that refuses to work
 * because a cache could not load is worse than one that has forgotten a few corrections.
 * `apiFetch` is injected so this is testable without the Clerk-authenticated wrapper.
 *
 * Returns the rows when the list LOADED — [] means he has taught nothing — and null when it did not:
 * any error, or a payload with no `aliases` array (the GET always sends one, so anything else is not
 * an answer). null is "unknown", and a caller that treats it as [] is guessing his taught names away.
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
 * BUG-VOICEALIASHITCOUNT-001 — count a USE of taught aliases. `uses` is [{ heard_key, variety_id }],
 * sent after the write each alias led to has landed. voice_alias.hit_count and last_used_at were read
 * and reset but never written, so every learned alias read 0 and nothing could say which ones are
 * load-bearing and which were one-off noise worth pruning — the column's stated purpose.
 *
 * FIRE AND FORGET, and that is the contract rather than a shortcut: nothing awaits it, it never rejects
 * and never throws, so a failed or slow count cannot block, delay or fail the write it follows. The
 * variety rides along so the server credits the meaning that was used — a phrase re-taught to another
 * variety in between (which resets its count) is not credited for the old one.
 *
 * PATCH on the route that already exists, not a new one: the varieties Lambda owns voice_alias, and a
 * new endpoint is the four-wiring hazard lambda/varieties/index.js records above these routes.
 */
export function recordAliasUse(apiFetch, uses) {
  const used = (uses ?? []).filter((u) => u?.heard_key && u?.variety_id)
    .map((u) => ({ heard_key: String(u.heard_key), variety_id: String(u.variety_id) }))
  if (!used.length) return
  try {
    Promise.resolve(apiFetch('/api/varieties/voice-aliases', {
      method: 'PATCH',
      body: JSON.stringify({ used }),
    })).catch(() => {})
  } catch { /* a count is never worth a thrown error */ }
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
