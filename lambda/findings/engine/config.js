// DRG Care Knowledge Engine V1 — tunable configuration (the "strength_priors as config" requirement, spec §2).
// Everything a future tuning pass would touch lives HERE, not as inline constants in the math modules.
// All values are deliberately COARSE (spec ruling: "build the math coarse and the surface plain").
// Changing any number here changes engine behavior; bump ENGINE_VERSION when the change should
// invalidate the byte-stable recompute contract (idempotency is keyed on evidence-set + ENGINE_VERSION).

export const SCHEMA_VERSION = 1;        // contract envelope shape; bump on any field-shape change.
export const ENGINE_VERSION = '1.0.0';  // stamped per record; recompute = pure fn of (evidence-set + this).

// ── Evidence tiers (5-tier ladder) ─────────────────────────────────────────────
// RANK encodes the strength ORDER. The crucible's "inversion FIXED" lock (C4): dave_confirmed
// MUST outrank claude_distilled. Higher rank = stronger. The two weakest tiers
// (claude_distilled, transferable_prior) are NON-corroborating: a finding resting only on
// them is clamped and asks rather than asserts.
export const TIERS = {
  dave_confirmed:       { rank: 5, prior: 1.00, corroborating: true  }, // Dave explicitly confirmed (top).
  first_party_log:      { rank: 4, prior: 0.70, corroborating: true  }, // a logged event/photo/observation on THIS planting.
  corroborated_general: { rank: 3, prior: 0.50, corroborating: true  }, // general knowledge backed by ≥1 cited/library source.
  claude_distilled:     { rank: 2, prior: 0.25, corroborating: false }, // AI-distilled from chats, uncorroborated — CLAMPED.
  transferable_prior:   { rank: 1, prior: 0.10, corroborating: false }, // cross-variety/crop transfer, no local evidence (cold-start floor).
};
export const TIER_NAMES = Object.keys(TIERS);
// Corroborator = any supporting evidence item whose tier is corroborating:true. Reaching `assert`
// (and any band above `low`) requires corroborator_count ≥ this many.
export const CORROBORATION_MIN = 1;

// ── Band derivation (coarse additive + cap → 3 bands) ──────────────────────────
export const BANDS = ['low', 'moderate', 'high'];
export const CONFIDENCE_CAP = 1.0;        // per-axis sum is capped here.
export const TRANSFERABLE_WEIGHT = 0.5;   // transferable confidence is discounted vs local when combined.
export const BAND_HIGH_CUT = 0.70;        // combined ≥ → high (only if corroborated).
export const BAND_MODERATE_CUT = 0.35;    // combined ≥ → moderate (only if corroborated).
export const CONFIDENCE_DECIMALS = 3;     // round stored axes to N decimals → byte-stable idempotent recompute.

// ── Decay (5-state machine, compute-at-read, asymmetric) ───────────────────────
// Thresholds are in DAYS since the most recent first-party (local) supporting evidence.
// Asymmetry lives in the resolution rule below, not these cutoffs: easy to WARN (short fresh
// window), hard to DISMISS (resolved needs contradicting evidence, never age).
export const DECAY_STATES = ['fresh', 'decaying', 'stale_unverified', 'dormant', 'resolved'];
export const DECAY_FRESH_DAYS = 7;     // ≤ → fresh
export const DECAY_DECAYING_DAYS = 21; // ≤ → decaying
export const DECAY_STALE_DAYS = 60;    // ≤ → stale_unverified (also flips assertion_mode → ask); > → dormant
// Resolution (the "resolved ONLY via positive contradicting evidence — never decay alone" lock, C4).
// A high base-severity finding will NOT auto-resolve on a single contradicting signal: it needs either
// ≥ this many contradicting signals, or one dave_confirmed contradiction.
export const HIGH_SEVERITY_RESOLVE_MIN_SIGNALS = 2;

// ── Trend (DERIVED — the single documented decay_state→trend mapping, spec §6.1) ─
// trend is a pure function of (decay_state, polarity recency, severity). The mapping:
//   resolved                                              → improving
//   most-recent signal is a contradiction (corrective)    → improving
//   decay_state ∈ {fresh,decaying} AND severity≥moderate
//     AND a recent supporting local signal exists          → worsening
//   otherwise                                              → steady
export const TRENDS = ['improving', 'steady', 'worsening'];

// ── Channel gate (objective operational-vs-ambient classifier) ─────────────────
// `operational` requires ALL THREE of {imminent, external, irreversible} AND must NOT be a missed
// cadence. Missed cadence → ALWAYS ambient (binding may-interrupt-rule boundary protecting
// interrupt-sensitive Jen; a fuzzy boundary is a Reward-UX-rule violation).
export const CHANNELS = ['ambient', 'operational'];
export const IMMINENT_CEIL_HOURS = 48;  // harm horizon at/under this many hours counts as "imminent".

export const URGENCY_LEVELS = ['low', 'moderate', 'high']; // emitted but DE-PRIVILEGED — never an ordering key.
export const SEVERITIES = ['low', 'moderate', 'high'];

export const SOURCE_ROOMS = ['Knowledge', 'Garden', 'Critters']; // Garden emits 0 findings in V1 (C2).

// ── Statement / basis templating (deterministic, NO serve-time LLM — C4) ───────
// Per finding_type ask/assert templates. {subject} is the entity label. Unknown types fall back to GENERIC.
export const FINDING_TYPE_TEMPLATES = {
  water_need:    { ask: '{subject}: any sign it needs water? No recent watering logged.',
                   assert: '{subject} likely needs water.' },
  light_deficit: { ask: '{subject}: getting enough light where it is? Nothing logged recently.',
                   assert: '{subject} may be light-starved in its current spot.' },
  pest_pressure: { ask: '{subject}: seen any pests lately? No recent inspection logged.',
                   assert: '{subject} is showing pest pressure.' },
  nutrient_need: { ask: '{subject}: due for feeding? No recent feeding logged.',
                   assert: '{subject} is likely due for feeding.' },
  repot_due:     { ask: '{subject}: outgrowing its container? Nothing logged recently.',
                   assert: '{subject} is likely due to be potted up.' },
  open_issue:    { ask: '{subject}: is the flagged issue still going on? Nothing logged since.',
                   assert: '{subject} has an open issue you logged.' },
  GENERIC:       { ask: '{subject}: worth a look? No recent log to confirm.',
                   assert: '{subject} may need attention.' },
};

// Resolved findings render ONE decay-aware statement regardless of finding_type, so the headline never
// contradicts a resolved decay_state (fixes the "{subject} has an open issue" template bug where a
// resolved finding still asserted it was open). Templated, no serve-time LLM (C4).
export const RESOLVED_STATEMENT = '{subject}: the issue you logged looks resolved.';
