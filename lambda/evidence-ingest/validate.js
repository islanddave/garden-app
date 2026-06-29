// Pure validator for the evidence-ingest write path (DRG-ENGINE-003 -> CARE-ENGINE-P0 V2 dual-write, G-EVID).
// No DB/Clerk/AWS imports -> jsdom-testable. Legacy enums MIRROR findings/engine/config.js TIERS
// (per-dir Lambda zip cannot import ../findings/engine — config.js is source of truth; keep in sync).
//
// V2 ADDITIVE (CARE-ENGINE-P0): every write now ALSO populates the V2 evidence cols, DERIVED from the
// legacy `tier` so OLD bodies (no V2 fields) still validate AND dual-write correctly. New fields are
// optional with derived defaults. The request API contract is UNCHANGED (still schema_version=1); the
// STORED row is schema_version=2 (it carries the full V2 field set). The CONTRACT phase (later migration)
// flips EXPECTED_SCHEMA_VERSION=2 and drops the legacy tier/axis/polarity cols.
//
// Reconciliation (locked): trust_rank + strength_weight MUST match the seeded `evidence_source_tier`
// lookup table (1..5 ordinal) so writer-derived values == backfilled values. evidence_class defaults to
// 'observation' (G-EVID, backfill-consistent). entity_type + claim are REQUIRED (0c SET NOT NULL).
export const EXPECTED_SCHEMA_VERSION = 1; // request-API version gate (unchanged). Stored rows are 2.
export const STORED_SCHEMA_VERSION = 2;   // every V2 dual-write row is stored as schema_version=2.
export const TIERS = ['dave_confirmed', 'first_party_log', 'corroborated_general', 'claude_distilled', 'transferable_prior'];
export const AXES = ['local', 'transferable'];
export const POLARITIES = ['supporting', 'contradicting'];

// V2 closed enums (spec 3.1; mirror the migration CHECK constraints). reject-on-unknown at write.
export const EVIDENCE_CLASSES = ['observation', 'knowledge', 'environment', 'feedback', 'outcome'];
export const ENTITY_TYPES = ['organism', 'condition', 'abiotic', 'action', 'cultivar', 'guide'];
export const SOURCE_TIERS = ['first_party_obs', 'strong_external', 'wikipedia', 'claude_distilled', 'dave_confirmed'];
export const CLAIM_SCOPES = ['crop', 'cultivar', 'planting'];
export const EVIDENCE_KINDS = ['plant_note', 'guide', 'critter_lore', 'event_log', 'photo', 'sensor', 'user_note'];
export const PROVENANCES = ['claude_distilled', 'dave_confirmed', 'user', 'system', 'external'];

// Legacy-tier -> V2 derivation. trust_rank/strength_weight VALUES MUST equal evidence_source_tier
// lookup seeds (migration 0a) so writer-derived == backfilled.
export const TIER_TO_V2 = {
  dave_confirmed:       { source_tier: 'dave_confirmed',   trust_rank: 5, strength_weight: 1.000 },
  first_party_log:      { source_tier: 'first_party_obs',  trust_rank: 4, strength_weight: 0.700 },
  corroborated_general: { source_tier: 'strong_external',  trust_rank: 3, strength_weight: 0.500 },
  claude_distilled:     { source_tier: 'claude_distilled', trust_rank: 2, strength_weight: 0.250 },
  transferable_prior:   { source_tier: 'wikipedia',        trust_rank: 1, strength_weight: 0.100 },
};
const LOOKUP = { dave_confirmed: { trust_rank: 5, strength_weight: 1.000 }, first_party_obs: { trust_rank: 4, strength_weight: 0.700 }, strong_external: { trust_rank: 3, strength_weight: 0.500 }, claude_distilled: { trust_rank: 2, strength_weight: 0.250 }, wikipedia: { trust_rank: 1, strength_weight: 0.100 } };
const CLASS_TO_PROVENANCE = { observation: 'user', knowledge: 'claude_distilled', environment: 'system', feedback: 'user', outcome: 'user' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isStr = (v) => typeof v === 'string';

// Returns { ok:true, value:{...legacy + ...v2} } or { ok:false, status, error }. Never throws.
export function validateEvidenceInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'body must be a JSON object' };
  const {
    entity_id, schema_version, tier, axis, polarity, observed_at, finding_type, note, photo_ref, source,
    evidence_class, entity_type, source_tier, claim, claim_scope, evidence_kind, garden_node_id,
    captured_at, observed_until, provenance, model_provenance, source_record_id, retracted,
  } = body;

  // Legacy validation (UNCHANGED — old bodies must still pass identically)
  if (schema_version !== EXPECTED_SCHEMA_VERSION) return { ok: false, status: 400, error: `schema_version must be ${EXPECTED_SCHEMA_VERSION}` };
  if (!isStr(entity_id) || !UUID_RE.test(entity_id)) return { ok: false, status: 400, error: 'entity_id must be a uuid' };
  if (!TIERS.includes(tier)) return { ok: false, status: 400, error: 'tier invalid' };
  if (!AXES.includes(axis)) return { ok: false, status: 400, error: 'axis invalid' };
  if (!POLARITIES.includes(polarity)) return { ok: false, status: 400, error: 'polarity invalid' };
  let obsTs = null;
  if (observed_at != null) {
    obsTs = new Date(observed_at);
    if (Number.isNaN(obsTs.getTime())) return { ok: false, status: 400, error: 'observed_at must be an ISO timestamp' };
  }
  for (const [k, val] of [['finding_type', finding_type], ['note', note], ['photo_ref', photo_ref], ['source', source]]) {
    if (val != null && !isStr(val)) return { ok: false, status: 400, error: `${k} must be a string` };
  }

  // V2 derivation + validation of explicit overrides (reject-on-unknown)
  const derived = TIER_TO_V2[tier];
  const v2Class      = evidence_class ?? 'observation';
  const v2EntityType = entity_type ?? 'organism';
  const v2SourceTier = source_tier ?? derived.source_tier;
  const v2Scope      = claim_scope ?? 'crop';
  const v2Kind       = evidence_kind ?? 'user_note';
  const v2Provenance = provenance ?? CLASS_TO_PROVENANCE[v2Class] ?? 'system';

  if (!EVIDENCE_CLASSES.includes(v2Class)) return { ok: false, status: 400, error: 'evidence_class invalid' };
  if (!ENTITY_TYPES.includes(v2EntityType)) return { ok: false, status: 400, error: 'entity_type invalid' };
  if (!SOURCE_TIERS.includes(v2SourceTier)) return { ok: false, status: 400, error: 'source_tier invalid' };
  if (!CLAIM_SCOPES.includes(v2Scope)) return { ok: false, status: 400, error: 'claim_scope invalid' };
  if (!EVIDENCE_KINDS.includes(v2Kind)) return { ok: false, status: 400, error: 'evidence_kind invalid' };
  if (!PROVENANCES.includes(v2Provenance)) return { ok: false, status: 400, error: 'provenance invalid' };
  if (retracted != null && typeof retracted !== 'boolean') return { ok: false, status: 400, error: 'retracted must be a boolean' };
  if (claim != null && !isStr(claim)) return { ok: false, status: 400, error: 'claim must be a string' };

  if (garden_node_id != null && (!isStr(garden_node_id) || !UUID_RE.test(garden_node_id)))
    return { ok: false, status: 400, error: 'garden_node_id must be a uuid' };
  if (v2Scope === 'planting' && !garden_node_id)
    return { ok: false, status: 400, error: 'garden_node_id is required when claim_scope=planting' };

  if (v2Provenance === 'claude_distilled' && (model_provenance == null || typeof model_provenance !== 'object'))
    return { ok: false, status: 400, error: 'model_provenance (object) required when provenance=claude_distilled' };

  let capTs = null;
  if (captured_at != null) {
    capTs = new Date(captured_at);
    if (Number.isNaN(capTs.getTime())) return { ok: false, status: 400, error: 'captured_at must be an ISO timestamp' };
  }
  let untilTs = null;
  if (observed_until != null) {
    untilTs = new Date(observed_until);
    if (Number.isNaN(untilTs.getTime())) return { ok: false, status: 400, error: 'observed_until must be an ISO timestamp' };
  }
  if (source_record_id != null && !isStr(source_record_id)) return { ok: false, status: 400, error: 'source_record_id must be a string' };

  const lk = LOOKUP[v2SourceTier];
  const nowIso = new Date().toISOString();
  const claimText = (isStr(claim) && claim.trim()) ? claim
    : (isStr(note) && note.trim()) ? note
    : 'observation logged';

  return {
    ok: true,
    value: {
      entity_id,
      schema_version: STORED_SCHEMA_VERSION,
      tier, axis, polarity,
      finding_type: finding_type ?? null,
      observed_at: (obsTs ?? new Date()).toISOString(),
      note: note ?? null, photo_ref: photo_ref ?? null, source: source ?? null,
      evidence_class: v2Class,
      entity_type: v2EntityType,
      claim: claimText,
      source_tier: v2SourceTier,
      trust_rank: lk.trust_rank,
      strength_weight: lk.strength_weight,
      claim_scope: v2Scope,
      evidence_kind: v2Kind,
      garden_node_id: garden_node_id ?? null,
      captured_at: (capTs ?? new Date(nowIso)).toISOString(),
      observed_until: untilTs ? untilTs.toISOString() : null,
      provenance: v2Provenance,
      model_provenance: model_provenance ?? null,
      retracted: retracted ?? false,
      source_record_id: source_record_id ?? null,
    },
  };
}
