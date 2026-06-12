// Confidence engine core (spec §2 Confidence, slice 3). Two STORED axes + DERIVED band.
// Pure + deterministic: output depends only on the evidence set and config. No clocks, no randomness.
import {
  TIERS, CORROBORATION_MIN, CONFIDENCE_CAP, TRANSFERABLE_WEIGHT,
  BAND_HIGH_CUT, BAND_MODERATE_CUT, CONFIDENCE_DECIMALS,
} from './config.js';

function round(n) {
  const f = 10 ** CONFIDENCE_DECIMALS;
  return Math.round(n * f) / f;
}

const supporting = (ev) => ev.polarity !== 'contradicting';

// Strongest tier present among supporting evidence (by rank). This is the "inversion fixed" surface:
// because TIERS.dave_confirmed.rank > TIERS.claude_distilled.rank, a finding with both reports
// dave_confirmed. Returns null when there is no supporting evidence.
export function dominantTier(evidence) {
  let best = null;
  for (const ev of evidence) {
    if (!supporting(ev)) continue;
    const t = TIERS[ev.tier];
    if (!t) continue;
    if (best === null || t.rank > TIERS[best].rank) best = ev.tier;
  }
  return best;
}

export function corroboratorCount(evidence) {
  let n = 0;
  for (const ev of evidence) {
    if (supporting(ev) && TIERS[ev.tier]?.corroborating) n += 1;
  }
  return n;
}

// confidence_local  = capped sum of priors of supporting LOCAL evidence (specific to this entity).
// confidence_transferable = capped sum of priors of supporting TRANSFERABLE evidence (general/cross-entity).
// Cold-start is representable: high transferable, zero local.
export function computeConfidence(evidence) {
  let local = 0, transferable = 0;
  for (const ev of evidence) {
    if (!supporting(ev)) continue;
    const prior = TIERS[ev.tier]?.prior ?? 0;
    if (ev.axis === 'local') local += prior;
    else transferable += prior;
  }
  const confidence_local = round(Math.min(CONFIDENCE_CAP, local));
  const confidence_transferable = round(Math.min(CONFIDENCE_CAP, transferable));
  const corroborator_count = corroboratorCount(evidence);
  const tier = dominantTier(evidence);
  return { confidence_local, confidence_transferable, corroborator_count, tier };
}

// confidence_band [DERIVED]: coarse additive + cap → 3 bands. The CLAMP (C4): a finding with zero
// corroborators (resting only on claude_distilled / transferable_prior) can never exceed `low`.
export function deriveBand({ confidence_local, confidence_transferable, corroborator_count }) {
  if (corroborator_count < CORROBORATION_MIN) return 'low'; // uncorroborated-distilled clamp.
  const combined = Math.min(CONFIDENCE_CAP, confidence_local + TRANSFERABLE_WEIGHT * confidence_transferable);
  if (combined >= BAND_HIGH_CUT) return 'high';
  if (combined >= BAND_MODERATE_CUT) return 'moderate';
  return 'low';
}
