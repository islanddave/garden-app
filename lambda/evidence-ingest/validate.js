// Pure validator for the evidence-ingest write path (DRG-ENGINE-003, slice 7). No DB/Clerk/AWS
// imports -> unit-testable in jsdom. The accepted enums MIRROR lambda/findings/engine/config.js
// (SCHEMA_VERSION + TIERS) — duplicated because the per-dir Lambda zip cannot import ../findings/engine.
// Keep in sync with the engine contract; findings/engine/config.js is the source of truth.
export const EXPECTED_SCHEMA_VERSION = 1;
export const TIERS = ['dave_confirmed', 'first_party_log', 'corroborated_general', 'claude_distilled', 'transferable_prior'];
export const AXES = ['local', 'transferable'];
export const POLARITIES = ['supporting', 'contradicting'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns { ok:true, value:{normalized} } or { ok:false, status, error }. Never throws.
export function validateEvidenceInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'body must be a JSON object' };
  const { entity_id, schema_version, tier, axis, polarity, observed_at, finding_type, note, photo_ref, source } = body;
  if (schema_version !== EXPECTED_SCHEMA_VERSION) return { ok: false, status: 400, error: `schema_version must be ${EXPECTED_SCHEMA_VERSION}` };
  if (typeof entity_id !== 'string' || !UUID_RE.test(entity_id)) return { ok: false, status: 400, error: 'entity_id must be a uuid' };
  if (!TIERS.includes(tier)) return { ok: false, status: 400, error: 'tier invalid' };
  if (!AXES.includes(axis)) return { ok: false, status: 400, error: 'axis invalid' };
  if (!POLARITIES.includes(polarity)) return { ok: false, status: 400, error: 'polarity invalid' };
  let ts = null;
  if (observed_at != null) {
    ts = new Date(observed_at);
    if (Number.isNaN(ts.getTime())) return { ok: false, status: 400, error: 'observed_at must be an ISO timestamp' };
  }
  for (const [k, val] of [['finding_type', finding_type], ['note', note], ['photo_ref', photo_ref], ['source', source]]) {
    if (val != null && typeof val !== 'string') return { ok: false, status: 400, error: `${k} must be a string` };
  }
  return {
    ok: true,
    value: {
      entity_id, schema_version,
      tier, axis, polarity,
      finding_type: finding_type ?? null,
      observed_at: (ts ?? new Date()).toISOString(),
      note: note ?? null, photo_ref: photo_ref ?? null, source: source ?? null,
    },
  };
}
