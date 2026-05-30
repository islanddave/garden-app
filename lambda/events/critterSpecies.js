// MVP-Critter species pool — frozen const + pure pickSpecies function.
// Canonical spec: mvp-critter-pre-build-revision-V001-20260528.md §4 (pool) + §3.29 (pickSpecies).
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
// Baselines vs earned pool:
//   species_id 1,2 = baseline residents (Day-1 ambient, client-side render only, NEVER
//     persisted to critter_state — per revision §3.14)
//   species_id 3-8 = earned pool (drawn by pickSpecies on action-completion)
//
// Distribution (revision §4 — D-INV-1 = A+B+C-as-honest-protocol):
//   common (3-5)   = 60% total (20% each)
//   uncommon (6-7) = 30% total (15% each)
//   rare (8)       = 10%
// NO rarity UI — invisible mechanism (V100 §8 anti-pattern on rarity-chase pressure).

export const SPECIES_POOL = Object.freeze([
  Object.freeze({
    species_id: 1, name: 'American robin',
    sprite_filename: 'C013-american-robin.svg', aria_announce_name: 'an American robin',
    tier: 'baseline', base_weight: 0,
    note: 'Day-1 baseline resident — always present, never enters earned pool. Substituted for V100\'s generic "sparrow" example; year-round W. MA backyard staple, doesn\'t overlap earned pool.',
  }),
  Object.freeze({
    species_id: 2, name: 'Honeybee',
    sprite_filename: 'C001-honeybee.svg', aria_announce_name: 'a honeybee',
    tier: 'baseline', base_weight: 0,
    note: 'Day-1 baseline resident — always present, never enters earned pool. Per V100 §7 "sparrow, bee" example.',
  }),
  Object.freeze({
    species_id: 3, name: 'Blue jay',
    sprite_filename: 'C050-blue-jay.svg', aria_announce_name: 'a blue jay',
    tier: 'common', base_weight: 20,
  }),
  Object.freeze({
    species_id: 4, name: 'American goldfinch',
    sprite_filename: 'C029-american-goldfinch.svg', aria_announce_name: 'an American goldfinch',
    tier: 'common', base_weight: 20,
  }),
  Object.freeze({
    species_id: 5, name: 'Mourning dove',
    sprite_filename: 'C049-mourning-dove.svg', aria_announce_name: 'a mourning dove',
    tier: 'common', base_weight: 20,
  }),
  Object.freeze({
    species_id: 6, name: 'Black-capped chickadee',
    sprite_filename: 'C012-black-capped-chickadee.svg', aria_announce_name: 'a chickadee',
    tier: 'uncommon', base_weight: 15,
  }),
  Object.freeze({
    species_id: 7, name: 'Northern cardinal',
    sprite_filename: 'C011-northern-cardinal.svg', aria_announce_name: 'a cardinal',
    tier: 'uncommon', base_weight: 15,
  }),
  Object.freeze({
    species_id: 8, name: 'Ruby-throated hummingbird',
    sprite_filename: 'C007-ruby-throated-hummingbird.svg', aria_announce_name: 'a hummingbird',
    tier: 'rare', base_weight: 10,
  }),
])

// Convenience subsets — computed once at module load.
export const BASELINE_RESIDENTS = Object.freeze(SPECIES_POOL.filter(s => s.tier === 'baseline'))
export const EARNED_POOL = Object.freeze(SPECIES_POOL.filter(s => s.tier !== 'baseline'))
export const BY_ID = Object.freeze(Object.fromEntries(SPECIES_POOL.map(s => [s.species_id, s])))

// Smoke-test sentinel (per revision §2.6). Out-of-pool; NEVER use in real flows.
export const SMOKE_SENTINEL_SPECIES_ID = 255

// ─── pickSpecies ─────────────────────────────────────────────────────────────
// Deterministic, pure. Given the same (seed, prefs) tuple, returns the same species_id.
// Client (offline-completion safe per V100 §7 / Tension 3) and server (parity assertion)
// produce identical output; if they diverge, client wins for Stage 1 reveal and server logs.
//
// Inputs:
//   seed  — string — typically `${source_event_id}|${event_log.created_at}|${householdId}`.
//   prefs — { [species_id]: weight }  — from critter_species_prefs PATCH'd rows. Missing
//           species_ids default to 1.0. Weight 2.0 = love, 0.5 = meh (per revision §3.29).
//
// Output: species_id in [3, 8] (earned pool only).
//
// Algorithm:
//   1) Compute FNV-1a 32-bit hash of seed → uniform random scalar in [0, 1).
//   2) Build per-species modulated weight = base_weight × (prefs[id] ?? 1.0).
//   3) Walk cumulative distribution, return first species whose cumulative weight >= scalar × total.

export function pickSpecies(seed, prefs = {}) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('pickSpecies: seed must be a non-empty string')
  }
  const weights = EARNED_POOL.map(s => {
    const mod = (prefs && Number.isFinite(prefs[s.species_id]) && prefs[s.species_id] > 0)
      ? prefs[s.species_id]
      : 1.0
    return s.base_weight * mod
  })
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) {
    // Degenerate: all weights zero (shouldn't happen given base_weight > 0).
    return EARNED_POOL[0].species_id
  }
  const r = fnv1aUniform(seed)
  let cum = 0
  for (let i = 0; i < EARNED_POOL.length; i++) {
    cum += weights[i]
    if (r * total < cum) return EARNED_POOL[i].species_id
  }
  // Numeric edge (r ≈ 1.0): fall through to last.
  return EARNED_POOL[EARNED_POOL.length - 1].species_id
}

// FNV-1a 32-bit hash → uniform in [0, 1). Pure JS, no deps, identical on Node + browser.
function fnv1aUniform(s) {
  let h = 0x811c9dc5 // 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // 32-bit FNV prime multiply (Math.imul for 32-bit overflow semantics)
    h = Math.imul(h, 0x01000193)
  }
  // Convert to unsigned, divide by 2^32 → uniform [0, 1)
  return (h >>> 0) / 0x100000000
}

// pickCopyVariant — deterministic copy-variant selector per revision §2.2 step 6.
// Variant pool size is currently 10 (Stage 1 variants packet §2). Resolver lives client-side
// in CritterAnnouncement.jsx; this fn is the seed→index mapping.
export function pickCopyVariant(seed, poolSize = 10) {
  if (!Number.isInteger(poolSize) || poolSize <= 0) return 0
  // Different salt from pickSpecies so the two picks aren't correlated.
  return Math.floor(fnv1aUniform(`copy:${seed}`) * poolSize)
}
