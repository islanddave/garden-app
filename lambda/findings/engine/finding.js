// Finding composer — assembles the full §2 contract from a raw finding + its evidence set.
// PURE + IDEMPOTENT: composeFinding(raw, now) is a byte-stable function of (raw, now, ENGINE_VERSION).
// No Date.now(), no randomness, fixed key insertion order → JSON.stringify is stable across calls.
import { SCHEMA_VERSION, ENGINE_VERSION } from './config.js';
import { computeConfidence, deriveBand } from './confidence.js';
import { computeDecayState, deriveTrend } from './decay.js';
import { classifyChannel, deriveUrgency } from './channel.js';
import { resolveAssertionMode } from './assertion.js';
import { renderConfidenceBasis, renderStatement } from './render.js';

// raw shape:
//   { finding_id, entity_id, source_room, finding_type, subject_label,
//     evidence: [ { tier, axis:'local'|'transferable', observed_at, polarity:'supporting'|'contradicting',
//                   severity_at_observation? } ],
//     severity: 'low'|'moderate'|'high',
//     harm: { horizon_hours, external, irreversible, is_cadence_miss },
//     record_version?, entity_role?, source_group_id?, scope?, guide_ref?, correlation_refs?, confidence_log? }
export function composeFinding(raw, now) {
  const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  const severity = raw.severity ?? 'low';

  const conf = computeConfidence(evidence);
  const decay_state = computeDecayState(evidence, severity, now);
  const assertion_mode = resolveAssertionMode({
    confidence_local: conf.confidence_local,
    corroborator_count: conf.corroborator_count,
    decay_state,
  });
  const confidence_band = deriveBand(conf);
  const trend = deriveTrend(evidence, decay_state, severity);
  const channel = classifyChannel(raw.harm);
  const urgency_level = deriveUrgency(channel, severity, decay_state);
  const confidence_basis = renderConfidenceBasis({
    evidence, tier: conf.tier, corroborator_count: conf.corroborator_count,
  });
  const statement = renderStatement({
    finding_type: raw.finding_type, subject_label: raw.subject_label, assertion_mode, decay_state,
  });

  // Fixed key order = CONTRACT_FIELDS order → stable serialization.
  return {
    // envelope
    schema_version: SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    finding_id: raw.finding_id,
    record_version: typeof raw.record_version === 'number' ? raw.record_version : 1,
    // identity
    entity_id: raw.entity_id,
    entity_role: raw.entity_role ?? null,          // RESERVED — single-entity collapse in V1.
    source_room: raw.source_room,
    source_group_id: raw.source_group_id ?? null,  // RESERVED — V2 correlated-evidence dedup.
    // confidence
    confidence_local: conf.confidence_local,
    confidence_transferable: conf.confidence_transferable,
    confidence_band,
    tier: conf.tier,
    corroborator_count: conf.corroborator_count,
    confidence_basis,
    // assertion / decay
    assertion_mode,
    decay_state,
    trend,
    channel,
    urgency_level,
    // correlation / future (RESERVED — nullable/empty, additive-ready)
    correlation_refs: Array.isArray(raw.correlation_refs) ? raw.correlation_refs : [],
    scope: raw.scope ?? 'planting',
    guide_ref: raw.guide_ref ?? null,
    confidence_log: Array.isArray(raw.confidence_log) ? raw.confidence_log : [],
    // render
    statement,
  };
}
