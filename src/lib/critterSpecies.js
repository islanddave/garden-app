// MVP-Critter species pool — frozen const + pure pickSpecies function.
// Canonical spec: mvp-critter-pre-build-revision-V001-20260528.md §4 (pool) + §3.29 (pickSpecies).
// Probabilistic-awarding refactor 2026-05-30 (Dave directive): pickSpecies now returns null
// for some seeds (variable-ratio reward schedule). Per-species base_probability + extensible
// speciesMultipliers parameter bakes in per-critter variability for future season/milestone
// modulation (V4 blocker).
//
// Namespace contract (sibling-thread non-merge per project CLAUDE.md):
//   MVP-Critter species_id 1-8 = THIS file (pinned pool)
//   IDs 9-99    = reserved for "MVP expansion" species (never assigned without explicit entry)
//   IDs 100+    = V3 roster (`zealous-stoic-rubin` thread; legacy/cryptid tiers)
//   ID 255      = smoke-test sentinel (per §2.6; out-of-MVP-range so CHECK constraint
//                 catches accidental smoke-row leakage)
//
// Sprite filenames are V3 art-pipeline output (C{NNN}-{slug}.svg) but this file consumes
// ART ASSETS ONLY, not V3 roster content organization (tier/lore/legacy). The mapping
// table below is the namespace boundary.
//
// Earned pool (V101 2026-06-01 — baseline residents RETIRED per Dave owner-override, L-102):
//   species_id 1-8 = earned pool (drawn by pickSpecies on action-completion).
//   Robin(1) + honeybee(2) were Day-1 baseline residents (always-present, never persisted);
//   they are now earnable common species like any other critter. There are NO baselines.
//
// Distribution (V101 — reward-ux-guideline-V101-20260601.1359.md §0.1):
//   common (1-5)   = 0.07 base_probability each (35% sum)
//   uncommon (6-7) = 0.05 base_probability each (10% sum)
//   rare (8)       = 0.025 base_probability
//   Total ≈ 47.5% chance per plant event → variable-ratio reward (was 33.5% pre-retirement).
//   Tier base_weights when a critter fires: common 100 / uncommon 30 / rare 10 (sum 140).
// NO rarity UI — invisible mechanism (V100 §8 anti-pattern on rarity-chase pressure).
//
// base_weight kept for back-compat callers; new code reads base_probability.

export const SPECIES_POOL = Object.freeze([
  Object.freeze({
    species_id: 1, name: 'American robin',
    sprite_filename: 'C013-american-robin.svg', aria_announce_name: 'an American robin',
    tier: 'common', base_weight: 20, base_probability: 0.07,
    note: 'Earnable common species (V101 2026-06-01 — baseline residents retired per Dave owner-override L-102; robin earned like any critter). Year-round W. MA backyard staple.',
  }),
  Object.freeze({
    species_id: 2, name: 'Honeybee',
    sprite_filename: 'C001-honeybee.svg', aria_announce_name: 'a honeybee',
    tier: 'common', base_weight: 20, base_probability: 0.07,
    note: 'Earnable common species (V101 2026-06-01 — baseline residents retired per Dave owner-override L-102; earned like any critter).',
  }),
  Object.freeze({
    species_id: 3, name: 'Blue jay',
    sprite_filename: 'C050-blue-jay.svg', aria_announce_name: 'a blue jay',
    tier: 'common', base_weight: 20, base_probability: 0.07,
  }),
  Object.freeze({
    species_id: 4, name: 'American goldfinch',
    sprite_filename: 'C029-american-goldfinch.svg', aria_announce_name: 'an American goldfinch',
    tier: 'common', base_weight: 20, base_probability: 0.07,
  }),
  Object.freeze({
    species_id: 5, name: 'Mourning dove',
    sprite_filename: 'C049-mourning-dove.svg', aria_announce_name: 'a mourning dove',
    tier: 'common', base_weight: 20, base_probability: 0.07,
  }),
  Object.freeze({
    species_id: 6, name: 'Black-capped chickadee',
    sprite_filename: 'C012-black-capped-chickadee.svg', aria_announce_name: 'a chickadee',
    tier: 'uncommon', base_weight: 15, base_probability: 0.05,
  }),
  Object.freeze({
    species_id: 7, name: 'Northern cardinal',
    sprite_filename: 'C011-northern-cardinal.svg', aria_announce_name: 'a cardinal',
    tier: 'uncommon', base_weight: 15, base_probability: 0.05,
  }),
  Object.freeze({
    species_id: 8, name: 'Ruby-throated hummingbird',
    sprite_filename: 'C007-ruby-throated-hummingbird.svg', aria_announce_name: 'a hummingbird',
    tier: 'rare', base_weight: 10, base_probability: 0.025,
  }),
])

// Convenience subsets — computed once at module load.
export const BASELINE_RESIDENTS = Object.freeze(SPECIES_POOL.filter(s => s.tier === 'baseline'))
export const EARNED_POOL = Object.freeze(SPECIES_POOL.filter(s => s.tier !== 'baseline'))
export const BY_ID = Object.freeze(Object.fromEntries(SPECIES_POOL.map(s => [s.species_id, s])))

// Smoke-test sentinel (per revision §2.6). Out-of-pool; NEVER use in real flows.
export const SMOKE_SENTINEL_SPECIES_ID = 255

// Sum of base_probability across earned pool — informational; useful in tests / docs.
// Note: real total at award-time may differ once prefs/multipliers are applied.
export const TOTAL_BASE_PROBABILITY = EARNED_POOL.reduce((a, s) => a + (s.base_probability ?? 0), 0)

// ─── pickSpecies ─────────────────────────────────────────────────────────────
// Deterministic, pure. Given the same (seed, prefs, opts) tuple, returns the same result.
//
// Inputs:
//   seed  — string — typically `${source_event_id}|${event_log.created_at}|${householdId}`.
//   prefs — { [species_id]: weight } — from critter_species_prefs PATCH'd rows (D-INV-1).
//           Missing species_ids default to 1.0. Weight 2.0 = love, 0.5 = meh (per §3.29).
//   opts  — { speciesMultipliers?: { [species_id]: number } } — future season/milestone
//           multipliers. Each multiplier modulates base_probability (cap effective total
//           at 1.0). Today: pass {} or omit; V4 blocker will source from DB/config.
//
// Output: species_id in [1, 8] (earned pool only — V101 retired baselines), OR null = "no critter awarded this event."
//   The null path is intentional (variable-ratio reward — Dave directive 2026-05-30).
//
// Algorithm:
//   1) Per-species effective_prob = base_probability × prefs_weight × multiplier.
//   2) total = sum(effective_probs), clamped to 1.0 to defend against runaway multipliers.
//   3) r = FNV-1a hash of seed → uniform in [0, 1).
//   4) If r >= total → return null (no critter this time).
//   5) Else: walk cumulative distribution, return first species whose cumulative reaches r.

export function pickSpecies(seed, prefs = {}, opts = {}) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('pickSpecies: seed must be a non-empty string')
  }
  const speciesMultipliers = opts && opts.speciesMultipliers ? opts.speciesMultipliers : {}
  const probabilities = EARNED_POOL.map(s => {
    const pref = (prefs && Number.isFinite(prefs[s.species_id]) && prefs[s.species_id] > 0)
      ? prefs[s.species_id]
      : 1.0
    const mult = (Number.isFinite(speciesMultipliers[s.species_id]) && speciesMultipliers[s.species_id] >= 0)
      ? speciesMultipliers[s.species_id]
      : 1.0
    const base = Number.isFinite(s.base_probability) ? s.base_probability : 0
    return base * pref * mult
  })
  const total = probabilities.reduce((a, b) => a + b, 0)
  const totalClamped = Math.min(Math.max(total, 0), 1.0)
  const r = fnv1aUniform(seed)
  if (r >= totalClamped) return null  // no critter for this event (variable-ratio gate)
  let cum = 0
  for (let i = 0; i < EARNED_POOL.length; i++) {
    cum += probabilities[i]
    if (r < cum) return EARNED_POOL[i].species_id
  }
  return EARNED_POOL[EARNED_POOL.length - 1].species_id  // numeric edge (r ≈ totalClamped)
}

// pickCopyVariant — deterministic seed → integer in [0, poolSize) for Stage 1 variant selection.
// Pool size is the count of variants in the Stage 1 single-action set (default 10 per packet).
// Pure JS; identical on Node + browser. (Unchanged from pre-probabilistic refactor.)
export function pickCopyVariant(seed, poolSize) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('pickCopyVariant: seed must be a non-empty string')
  }
  if (!Number.isInteger(poolSize) || poolSize <= 0) {
    throw new Error('pickCopyVariant: poolSize must be a positive integer')
  }
  // Use a different hash domain so copy-variant index doesn't trivially correlate with species.
  const r = fnv1aUniform(seed + '|copy')
  return Math.floor(r * poolSize)
}

// FNV-1a 32-bit hash → uniform in [0, 1). Pure JS, no deps, identical on Node + browser.
function fnv1aUniform(s) {
  let h = 0x811c9dc5 // 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 0x100000000
}
