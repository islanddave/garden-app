import { describe, it, expect } from 'vitest';
import {
  composeFinding, validateFinding,
  computeConfidence, deriveBand, dominantTier, corroboratorCount,
  computeDecayState, deriveTrend, isResolvedByContradiction,
  classifyChannel, deriveUrgency, resolveAssertionMode,
  renderConfidenceBasis,
} from './engine/index.js';

const NOW = Date.parse('2026-06-12T00:00:00Z');
const DAY = 86_400_000;
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const ev = (tier, axis, daysAgo, polarity = 'supporting') =>
  ({ tier, axis, observed_at: iso(daysAgo), polarity });

const raw = (over = {}) => ({
  finding_id: 'f-1', entity_id: 'e-1', source_room: 'Knowledge',
  finding_type: 'water_need', subject_label: 'Genovese Basil (back bench)',
  severity: 'low', harm: {}, evidence: [], ...over,
});

describe('confidence — two axes, cap, tier ordering', () => {
  it('separates local and transferable axes', () => {
    const c = computeConfidence([ev('first_party_log', 'local', 2), ev('claude_distilled', 'transferable', 5)]);
    expect(c.confidence_local).toBe(0.7);
    expect(c.confidence_transferable).toBe(0.25);
  });
  it('caps each axis at 1.0', () => {
    const c = computeConfidence([
      ev('dave_confirmed', 'local', 1), ev('first_party_log', 'local', 2), ev('first_party_log', 'local', 3),
    ]);
    expect(c.confidence_local).toBe(1); // 1.0 + 0.7 + 0.7 capped to 1
  });
  it('dominantTier picks the strongest — dave_confirmed OUTRANKS claude_distilled (inversion fixed)', () => {
    expect(dominantTier([ev('claude_distilled', 'transferable', 1), ev('dave_confirmed', 'local', 1)]))
      .toBe('dave_confirmed');
  });
  it('counts only corroborating tiers', () => {
    expect(corroboratorCount([ev('claude_distilled', 'transferable', 1), ev('transferable_prior', 'transferable', 1)]))
      .toBe(0);
    expect(corroboratorCount([ev('first_party_log', 'local', 1), ev('claude_distilled', 'transferable', 1)]))
      .toBe(1);
  });
  it('contradicting evidence does not raise confidence', () => {
    const c = computeConfidence([ev('first_party_log', 'local', 2, 'contradicting')]);
    expect(c.confidence_local).toBe(0);
  });
});

describe('band derivation — corroboration clamp (C4)', () => {
  it('clamps claude_distilled-only findings to low regardless of magnitude', () => {
    const c = computeConfidence([ev('claude_distilled', 'transferable', 1), ev('transferable_prior', 'transferable', 2)]);
    expect(deriveBand(c)).toBe('low');
  });
  it('reaches high only with a corroborator', () => {
    const c = computeConfidence([ev('first_party_log', 'local', 2), ev('claude_distilled', 'transferable', 2)]);
    expect(deriveBand(c)).toBe('high'); // 0.7 + 0.5*0.25 = 0.825
  });
  it('moderate band in the mid range', () => {
    const c = computeConfidence([ev('corroborated_general', 'local', 2)]); // local 0.5, corroborator 1
    expect(deriveBand(c)).toBe('moderate');
  });
});

describe('assertion mode — cold-start is the primary ask path (slice 2)', () => {
  it('asks on cold-start (no local evidence)', () => {
    expect(resolveAssertionMode({ confidence_local: 0, corroborator_count: 1, decay_state: 'fresh' })).toBe('ask');
  });
  it('asks when uncorroborated', () => {
    expect(resolveAssertionMode({ confidence_local: 0.25, corroborator_count: 0, decay_state: 'fresh' })).toBe('ask');
  });
  it('asks when stale_unverified', () => {
    expect(resolveAssertionMode({ confidence_local: 0.7, corroborator_count: 1, decay_state: 'stale_unverified' })).toBe('ask');
  });
  it('asserts when local + corroborated + fresh', () => {
    expect(resolveAssertionMode({ confidence_local: 0.7, corroborator_count: 1, decay_state: 'fresh' })).toBe('assert');
  });
});

describe('decay — 5-state machine + asymmetric resolution (C4)', () => {
  it('ages fresh → decaying → stale_unverified → dormant by local recency', () => {
    expect(computeDecayState([ev('first_party_log', 'local', 2)], 'low', NOW)).toBe('fresh');
    expect(computeDecayState([ev('first_party_log', 'local', 14)], 'low', NOW)).toBe('decaying');
    expect(computeDecayState([ev('first_party_log', 'local', 40)], 'low', NOW)).toBe('stale_unverified');
    expect(computeDecayState([ev('first_party_log', 'local', 90)], 'low', NOW)).toBe('dormant');
  });
  it('cold-start (no local supporting evidence) → stale_unverified', () => {
    expect(computeDecayState([ev('claude_distilled', 'transferable', 3)], 'low', NOW)).toBe('stale_unverified');
  });
  it('NEVER auto-resolves on age alone, even very old high-severity', () => {
    expect(computeDecayState([ev('first_party_log', 'local', 400)], 'high', NOW)).toBe('dormant');
  });
  it('resolves on a single contradicting signal for non-high severity', () => {
    expect(isResolvedByContradiction([ev('first_party_log', 'local', 1, 'contradicting')], 'low')).toBe(true);
    expect(computeDecayState([ev('first_party_log', 'local', 1, 'contradicting')], 'low', NOW)).toBe('resolved');
  });
  it('high-severity needs ≥2 contradicting signals OR a dave_confirmed contradiction', () => {
    expect(isResolvedByContradiction([ev('first_party_log', 'local', 1, 'contradicting')], 'high')).toBe(false);
    expect(isResolvedByContradiction(
      [ev('first_party_log', 'local', 1, 'contradicting'), ev('first_party_log', 'local', 2, 'contradicting')], 'high'
    )).toBe(true);
    expect(isResolvedByContradiction([ev('dave_confirmed', 'local', 1, 'contradicting')], 'high')).toBe(true);
  });
});

describe('trend — single documented mapping (DERIVED)', () => {
  it('resolved → improving', () => {
    expect(deriveTrend([ev('first_party_log', 'local', 1, 'contradicting')], 'resolved', 'low')).toBe('improving');
  });
  it('most-recent signal corrective → improving (even if not yet resolved)', () => {
    const e = [ev('first_party_log', 'local', 10), ev('first_party_log', 'local', 2, 'contradicting')];
    expect(deriveTrend(e, 'decaying', 'high')).toBe('improving');
  });
  it('fresh/decaying + severity≥moderate → worsening', () => {
    expect(deriveTrend([ev('first_party_log', 'local', 2)], 'fresh', 'moderate')).toBe('worsening');
  });
  it('otherwise steady', () => {
    expect(deriveTrend([ev('first_party_log', 'local', 2)], 'fresh', 'low')).toBe('steady');
  });
});

describe('channel — objective 3-way AND, missed-cadence always ambient', () => {
  const imminent = { horizon_hours: 12, external: true, irreversible: true };
  it('operational requires imminent AND external AND irreversible', () => {
    expect(classifyChannel(imminent)).toBe('operational');
  });
  it('any missing leg → ambient', () => {
    expect(classifyChannel({ ...imminent, external: false })).toBe('ambient');
    expect(classifyChannel({ ...imminent, irreversible: false })).toBe('ambient');
    expect(classifyChannel({ ...imminent, horizon_hours: 200 })).toBe('ambient');
    expect(classifyChannel({ ...imminent, horizon_hours: null })).toBe('ambient');
  });
  it('missed cadence is NEVER operational, even with all three legs', () => {
    expect(classifyChannel({ ...imminent, is_cadence_miss: true })).toBe('ambient');
  });
  it('urgency is de-privileged but present', () => {
    expect(deriveUrgency('operational', 'high', 'fresh')).toBe('high');
    expect(deriveUrgency('ambient', 'low', 'resolved')).toBe('low');
  });
});

describe('confidence_basis — principled ask text (no LLM)', () => {
  it('renders the no-log reason on cold-start', () => {
    expect(renderConfidenceBasis({ evidence: [ev('claude_distilled', 'transferable', 3)], tier: 'claude_distilled', corroborator_count: 0 }))
      .toMatch(/No first-party log yet/);
  });
  it('credits Dave confirmation', () => {
    expect(renderConfidenceBasis({ evidence: [ev('dave_confirmed', 'local', 1)], tier: 'dave_confirmed', corroborator_count: 1 }))
      .toMatch(/Confirmed by you/);
  });
});

describe('composeFinding — full contract, idempotency, validity', () => {
  it('cold-start finding is well-formed: ask + low + stale + valid', () => {
    const f = composeFinding(raw({ evidence: [ev('claude_distilled', 'transferable', 3)] }), NOW);
    expect(f.assertion_mode).toBe('ask');
    expect(f.confidence_band).toBe('low');
    expect(f.decay_state).toBe('stale_unverified');
    expect(f.statement).toMatch(/needs water/i);
    expect(validateFinding(f).valid).toBe(true);
  });
  it('asserting finding is well-formed and valid', () => {
    const f = composeFinding(raw({
      severity: 'moderate',
      evidence: [ev('first_party_log', 'local', 2), ev('corroborated_general', 'transferable', 5)],
    }), NOW);
    expect(f.assertion_mode).toBe('assert');
    expect(f.confidence_band).toBe('high');
    expect(validateFinding(f).valid).toBe(true);
  });
  it('is byte-stable idempotent for the same (raw, now)', () => {
    const r = raw({ evidence: [ev('first_party_log', 'local', 2), ev('claude_distilled', 'transferable', 9)] });
    expect(JSON.stringify(composeFinding(r, NOW))).toBe(JSON.stringify(composeFinding(r, NOW)));
  });
  it('defaults RESERVED fields (additive-ready)', () => {
    const f = composeFinding(raw(), NOW);
    expect(f.entity_role).toBe(null);
    expect(f.source_group_id).toBe(null);
    expect(f.correlation_refs).toEqual([]);
    expect(f.guide_ref).toBe(null);
    expect(f.confidence_log).toEqual([]);
    expect(f.scope).toBe('planting');
  });
  it('stamps envelope versions', () => {
    const f = composeFinding(raw(), NOW);
    expect(f.schema_version).toBe(1);
    expect(f.engine_version).toBe('1.0.0');
    expect(typeof f.record_version).toBe('number');
  });
});

describe('validateFinding — rejects malformed envelopes', () => {
  it('rejects schema_version mismatch', () => {
    const f = composeFinding(raw(), NOW); f.schema_version = 99;
    expect(validateFinding(f).valid).toBe(false);
  });
  it('rejects bad enum values', () => {
    const f = composeFinding(raw(), NOW); f.decay_state = 'nonsense';
    expect(validateFinding(f).valid).toBe(false);
  });
  it('rejects a non-object', () => {
    expect(validateFinding(null).valid).toBe(false);
  });
});


describe('resolved findings — decay-aware headline (open-issue template bug regression)', () => {
  it('a resolved open_issue renders a RESOLVED statement, never the open-issue template', () => {
    const f = composeFinding(raw({
      finding_type: 'open_issue', subject_label: 'Manitoba (Tomatoes)', severity: 'moderate',
      evidence: [
        ev('first_party_log', 'local', 5),                 // the logged issue
        ev('dave_confirmed', 'local', 1, 'contradicting'), // explicit user resolve
      ],
    }), NOW);
    expect(f.decay_state).toBe('resolved');
    expect(f.trend).toBe('improving');
    expect(f.statement).toMatch(/resolved/i);
    expect(f.statement).not.toMatch(/open issue/i);
    expect(validateFinding(f).valid).toBe(true);
  });

  it('an UNresolved open_issue still renders the open-issue heads-up', () => {
    const f = composeFinding(raw({
      finding_type: 'open_issue', subject_label: 'Manitoba (Tomatoes)', severity: 'moderate',
      evidence: [ev('first_party_log', 'local', 2)],
    }), NOW);
    expect(f.decay_state).not.toBe('resolved');
    expect(f.statement).toMatch(/open issue/i);
  });
});
