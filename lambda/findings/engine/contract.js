// The unified V1 findings contract (spec §2). Field tally: 12 BUILT · 5 DERIVED · 5 RESERVED.
// validateFinding() is the single shape gate — used by tests AND by the future evidence-ingest
// endpoint (slice 7), which must validate against schema_version even when UI-unwired (C-risk #4).
import {
  SCHEMA_VERSION, BANDS, DECAY_STATES, TRENDS, CHANNELS, URGENCY_LEVELS, SOURCE_ROOMS, TIER_NAMES,
} from './config.js';

// Ordered field list of the envelope (also documents BUILT/DERIVED/RESERVED status).
export const CONTRACT_FIELDS = {
  // envelope
  schema_version: 'BUILT', engine_version: 'BUILT', finding_id: 'BUILT', record_version: 'BUILT',
  // identity
  entity_id: 'BUILT', entity_role: 'RESERVED', source_room: 'BUILT', source_group_id: 'RESERVED',
  // confidence
  confidence_local: 'BUILT', confidence_transferable: 'BUILT', confidence_band: 'DERIVED',
  tier: 'BUILT', corroborator_count: 'BUILT', confidence_basis: 'DERIVED',
  // assertion / decay
  assertion_mode: 'BUILT', decay_state: 'BUILT', trend: 'DERIVED', channel: 'BUILT', urgency_level: 'BUILT',
  // correlation / future (reserved)
  correlation_refs: 'RESERVED', scope: 'RESERVED', guide_ref: 'RESERVED', confidence_log: 'RESERVED',
  // render
  statement: 'DERIVED',
};

const inEnum = (v, list) => list.includes(v);

export function validateFinding(f) {
  const errors = [];
  const req = (k) => { if (f?.[k] === undefined || f?.[k] === null) errors.push(`missing ${k}`); };

  if (!f || typeof f !== 'object') return { valid: false, errors: ['finding is not an object'] };

  if (f.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  for (const k of ['engine_version', 'finding_id', 'entity_id', 'source_room', 'statement', 'confidence_basis']) req(k);
  if (typeof f.record_version !== 'number') errors.push('record_version must be a number');

  if (!inEnum(f.source_room, SOURCE_ROOMS)) errors.push(`source_room invalid: ${f.source_room}`);
  if (!inEnum(f.assertion_mode, ['assert', 'ask'])) errors.push(`assertion_mode invalid: ${f.assertion_mode}`);
  if (!inEnum(f.decay_state, DECAY_STATES)) errors.push(`decay_state invalid: ${f.decay_state}`);
  if (!inEnum(f.trend, TRENDS)) errors.push(`trend invalid: ${f.trend}`);
  if (!inEnum(f.channel, CHANNELS)) errors.push(`channel invalid: ${f.channel}`);
  if (!inEnum(f.confidence_band, BANDS)) errors.push(`confidence_band invalid: ${f.confidence_band}`);
  if (!inEnum(f.urgency_level, URGENCY_LEVELS)) errors.push(`urgency_level invalid: ${f.urgency_level}`);
  if (f.tier !== null && !inEnum(f.tier, TIER_NAMES)) errors.push(`tier invalid: ${f.tier}`);

  if (typeof f.confidence_local !== 'number' || f.confidence_local < 0 || f.confidence_local > 1)
    errors.push('confidence_local out of [0,1]');
  if (typeof f.confidence_transferable !== 'number' || f.confidence_transferable < 0 || f.confidence_transferable > 1)
    errors.push('confidence_transferable out of [0,1]');
  if (!Number.isInteger(f.corroborator_count) || f.corroborator_count < 0)
    errors.push('corroborator_count must be a non-negative integer');
  if (!Array.isArray(f.correlation_refs)) errors.push('correlation_refs must be an array');

  return { valid: errors.length === 0, errors };
}
