// Decay computation (spec §2 Assertion/decay, slice 4). Compute-at-read, deterministic given `now`.
// Two hard correctness locks from the crucible (C4):
//   1. `resolved` is reachable ONLY via positive contradicting evidence — NEVER by age/decay alone.
//   2. A high base-severity finding never auto-resolves on a single contradicting signal.
import {
  DECAY_FRESH_DAYS, DECAY_DECAYING_DAYS, DECAY_STALE_DAYS,
  HIGH_SEVERITY_RESOLVE_MIN_SIGNALS,
} from './config.js';

const DAY_MS = 86_400_000;
const supporting = (ev) => ev.polarity !== 'contradicting';
const contradicting = (ev) => ev.polarity === 'contradicting';

const ts = (ev) => (ev.observed_at ? Date.parse(ev.observed_at) : NaN);

function latestTs(evidence, pred) {
  let max = null;
  for (const ev of evidence) {
    if (!pred(ev)) continue;
    const t = ts(ev);
    if (Number.isNaN(t)) continue;
    if (max === null || t > max) max = t;
  }
  return max;
}

// Most recent first-party LOCAL supporting evidence — the decay clock. Absence ⇒ no local clock.
export function latestLocalSupportingTs(evidence) {
  return latestTs(evidence, (ev) => supporting(ev) && ev.axis === 'local');
}

// Resolution test (the asymmetric, hard-to-dismiss side). Returns true only when contradicting
// evidence is sufficient to positively resolve the finding given its base severity.
export function isResolvedByContradiction(evidence, severity) {
  const contradictions = evidence.filter(contradicting);
  if (contradictions.length === 0) return false;
  if (severity === 'high') {
    const daveContradiction = contradictions.some((ev) => ev.tier === 'dave_confirmed');
    return daveContradiction || contradictions.length >= HIGH_SEVERITY_RESOLVE_MIN_SIGNALS;
  }
  return true; // non-high severity: a single contradicting signal resolves.
}

// decay_state ∈ {fresh, decaying, stale_unverified, dormant, resolved}.
// Cold-start (no local supporting evidence) ⇒ stale_unverified: we hold a belief but have no fresh
// first-party confirmation, which is exactly the condition that should drive ask-mode. This keeps the
// machine to 5 states while giving cold-start an honest, ask-driving state.
export function computeDecayState(evidence, severity, now) {
  if (isResolvedByContradiction(evidence, severity)) return 'resolved';
  const localTs = latestLocalSupportingTs(evidence);
  if (localTs === null) return 'stale_unverified';
  const ageDays = (now - localTs) / DAY_MS;
  if (ageDays <= DECAY_FRESH_DAYS) return 'fresh';
  if (ageDays <= DECAY_DECAYING_DAYS) return 'decaying';
  if (ageDays <= DECAY_STALE_DAYS) return 'stale_unverified';
  return 'dormant';
}

// trend [DERIVED] — the single documented decay_state→trend mapping (config comment + spec §6.1).
// decay_state already encodes local-evidence recency, so fresh/decaying == "a recent local signal exists."
export function deriveTrend(evidence, decay_state, severity) {
  if (decay_state === 'resolved') return 'improving';
  const latestSupport = latestTs(evidence, supporting);
  const latestContra = latestTs(evidence, contradicting);
  // Most recent signal is corrective → improving.
  if (latestContra !== null && (latestSupport === null || latestContra >= latestSupport)) return 'improving';
  // Active, non-trivial issue with a recent supporting local signal (fresh/decaying) → worsening.
  if ((decay_state === 'fresh' || decay_state === 'decaying') &&
      (severity === 'moderate' || severity === 'high')) {
    return 'worsening';
  }
  return 'steady';
}
