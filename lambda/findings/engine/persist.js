// DRG-BACKBONE-001 P1 (§9 hybrid serving) — findings MATERIALIZATION SEAM (pure).
//
// Reconciles the §2 composed finding (composeFinding output, what GET /api/findings returns) with the
// `findings` TABLE (created additively in migration 0a). The table is a PERSISTENCE PROJECTION of the
// finding, not a 1:1 mirror — three field classes:
//   A — stored & semantic (confidences/bands/tier/decay/trend/channel/severity/...)
//   B — stored, sourced from the RAW finding, absent from composed output (garden_node_id, finding_type,
//       finding_kind, severity, recommended_action, confidence_basis-as-UUID[])
//   C — composed-only, RESERVED + provably constant in V1 (entity_role/source_group_id/correlation_refs/
//       scope/guide_ref/confidence_log) -> NOT stored; re-emitted from RESERVED_DEFAULTS on read.
//
// PURE: no I/O, no ambient clock (the reference clock is the `now` arg already threaded through
// composeFinding, per §9 "clock-as-arg"). This module is UNWIRED in P0 — the GET serving flip and the
// event-write wiring are the DEFERRED gated slice (regression agents: the L-089/L-090/L-104 risks all land
// on the wiring, not the seam). Round-trip + fault-injection proven in persist.test.js.
import { SCHEMA_VERSION, ENGINE_VERSION } from './config.js';

// Class C — provably null/[]/constant in the current §2 output. The round-trip test is the tripwire: if
// composed ever emits a non-constant here, the test fails -> that is the signal to add a JSONB sidecar
// column (do NOT add one now: it would store only nulls/empties).
export const RESERVED_DEFAULTS = Object.freeze({
  entity_role: null,
  source_group_id: null,
  correlation_refs: [],
  scope: 'planting',
  guide_ref: null,
  confidence_log: [],
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uniqueUuids(arr) {
  const seen = new Set();
  for (const v of arr) if (typeof v === 'string' && UUID_RE.test(v)) seen.add(v.toLowerCase());
  return [...seen];
}
const toIso = (now) => (now instanceof Date ? now : new Date(now)).toISOString();

// (raw finding + composed §2 finding + clock) -> a findings-table INSERT row (every NOT-NULL column
// resolved). `now` is the same ms/Date passed to composeFinding(raw, now).
export function toPersistRow(raw, composed, now) {
  if (!raw || typeof raw !== 'object') throw new Error('toPersistRow: raw required');
  if (!composed || typeof composed !== 'object') throw new Error('toPersistRow: composed required');
  // FLAG-2: V1 emits no action-kind findings -> recommended_action null -> kind 'diagnostic'
  // (satisfies the table CHECK: finding_kind<>'action' OR recommended_action IS NOT NULL). When ingest
  // begins supplying raw.recommended_action, DERIVE-KIND promotes it to 'action'.
  const recommended_action = raw.recommended_action ?? null;
  const finding_kind = recommended_action ? 'action' : 'diagnostic';
  return {
    schema_version: composed.schema_version ?? SCHEMA_VERSION,
    engine_version: composed.engine_version ?? ENGINE_VERSION,
    record_version: typeof composed.record_version === 'number' ? composed.record_version : 1,
    // FLAG-1: garden_node_id = the planting FK. composed output has no plant id; assembleIssueFindings now
    // surfaces raw.plant_id (the event_log.plant_id already in scope). NOT-NULL: throw if missing so the
    // gap is loud, never a silent NULL INSERT failure at the DB.
    garden_node_id: requireField(raw.plant_id, 'raw.plant_id (garden_node_id)'),
    entity_id: composed.entity_id,
    finding_type: requireField(raw.finding_type, 'raw.finding_type'),
    finding_kind,
    statement: composed.statement,
    recommended_action,
    severity: raw.severity ?? 'low',
    confidence_local: composed.confidence_local,
    confidence_transferable: composed.confidence_transferable,
    confidence_band: composed.confidence_band,
    tier: composed.tier ?? null,
    corroborator_count: composed.corroborator_count,
    assertion_mode: composed.assertion_mode,
    decay_state: composed.decay_state,
    trend: composed.trend,
    channel: composed.channel,
    urgency_level: composed.urgency_level ?? null,
    source_room: composed.source_room ?? null,
    // FLAG-3: table confidence_basis is UUID[] (evidence ids), NOT the composed rendered-text basis. Map
    // from raw.evidence[].evidence_id; '{}' when V1 evidence carries no ids (the column default permits it).
    // The rendered basis text is reconstructed on the recompute path, never stored.
    confidence_basis: uniqueUuids((raw.evidence ?? []).map((e) => e && e.evidence_id)),
    computed_at: toIso(now),
  };
}

function requireField(v, label) {
  if (v === undefined || v === null || v === '') throw new Error(`toPersistRow: ${label} is required (NOT NULL column)`);
  return v;
}

// findings-table row -> the §2 finding shape GET returns. Class C re-emitted from RESERVED_DEFAULTS.
// KNOWN SEAM GAPS (documented for the deferred wiring slice, NOT closed here):
//   - finding_id: the V1 table has no natural finding_id column (PK is a generated UUID `id`); the §2
//     finding_id is `issue:<event_id>`. fromPersistRow returns row.finding_id ?? row.id as a placeholder.
//     The serving-flip slice must add a natural-id column or reconstruct it deterministically.
//   - confidence_basis: returned as the stored UUID[]; the rendered-text form is a recompute-path concern.
export function fromPersistRow(row) {
  if (!row || typeof row !== 'object') throw new Error('fromPersistRow: row required');
  const n = (v) => (v === null || v === undefined ? v : Number(v)); // pg NUMERIC -> string; coerce.
  return {
    schema_version: row.schema_version,
    engine_version: row.engine_version,
    finding_id: row.finding_id ?? row.id ?? null,
    record_version: row.record_version,
    entity_id: row.entity_id,
    entity_role: RESERVED_DEFAULTS.entity_role,
    source_room: row.source_room ?? null,
    source_group_id: RESERVED_DEFAULTS.source_group_id,
    confidence_local: n(row.confidence_local),
    confidence_transferable: n(row.confidence_transferable),
    confidence_band: row.confidence_band,
    tier: row.tier ?? null,
    corroborator_count: row.corroborator_count,
    confidence_basis: Array.isArray(row.confidence_basis) ? row.confidence_basis : [],
    assertion_mode: row.assertion_mode,
    decay_state: row.decay_state,
    trend: row.trend,
    channel: row.channel,
    urgency_level: row.urgency_level ?? null,
    correlation_refs: [...RESERVED_DEFAULTS.correlation_refs],
    scope: RESERVED_DEFAULTS.scope,
    guide_ref: RESERVED_DEFAULTS.guide_ref,
    confidence_log: [...RESERVED_DEFAULTS.confidence_log],
    statement: row.statement,
  };
}

// §9 read-time hybrid resolver (PURE, clock-as-arg). For each materialized row: serve it iff its
// engine_version matches the current engine, otherwise RECOMPUTE (a stale-engine row must NEVER be served
// as-is — that would silently return wrong care advice). Cold nodes (no materialized row) are computed by
// the caller. UNWIRED in P0: findings/index.js stays compute-on-read (byte-identical to today); the flip is
// the deferred gated slice and must guard on table-existence + assert byte-identity while the table is empty.
export function resolveHybrid({ materializedRows = [], recomputeFn, currentEngineVersion = ENGINE_VERSION, now }) {
  if (typeof recomputeFn !== 'function') throw new Error('resolveHybrid: recomputeFn required');
  const out = [];
  for (const row of materializedRows) {
    if (row && row.engine_version === currentEngineVersion && (row.deleted_at == null)) {
      out.push({ served: fromPersistRow(row), source: 'materialized' });
    } else {
      out.push({ served: recomputeFn(row, now), source: 'recomputed' }); // stale engine / soft-deleted -> recompute
    }
  }
  return out;
}
