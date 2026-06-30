// DRG-BACKBONE-001 P1 (§9 hybrid serving) — findings MATERIALIZE-ON-WRITE writer.
//
// Builds + executes the idempotent UPSERT that persists a computed finding into the `findings` table, and
// the soft-delete that retires a resolved finding. CLIENT-INJECTED by design: this module imports NO
// Pool/ws/neon — the caller passes an already-connected, transaction-capable client (Pool+ws). Rationale
// (regression review): keeping the new connection mode OUT of this module means it can be fully unit-tested
// + COW-dry-run-exercised with zero bundle/connection-leak risk, and it carries no L-089 module-load-502
// hazard while UNWIRED. The Pool+ws lifecycle + the event-write transaction that calls these live in the
// DEFERRED gated wiring slice, NOT here.
//
// The multi-row write (event row + this finding UPSERT) MUST run inside ONE transaction on the injected
// client (§9). This module provides the finding half; the caller owns BEGIN/COMMIT/ROLLBACK + client.release.
import { toPersistRow } from './engine/persist.js';

// Column order for the INSERT (matches the $1..$23 value order below).
const COLS = [
  'schema_version', 'engine_version', 'record_version', 'garden_node_id', 'entity_id',
  'finding_type', 'finding_kind', 'statement', 'recommended_action', 'severity',
  'confidence_local', 'confidence_transferable', 'confidence_band', 'tier',
  'corroborator_count', 'assertion_mode', 'decay_state', 'trend', 'channel',
  'urgency_level', 'source_room', 'confidence_basis', 'computed_at',
];

// Fields whose change should bump record_version + rewrite the row (the DO UPDATE WHERE predicate makes an
// unchanged re-materialization a true no-op: no record_version inflation, no updated_at churn).
const SEMANTIC = [
  'engine_version', 'schema_version', 'statement', 'recommended_action', 'finding_kind', 'severity',
  'confidence_local', 'confidence_transferable', 'confidence_band', 'tier', 'corroborator_count',
  'assertion_mode', 'decay_state', 'trend', 'channel', 'urgency_level', 'source_room', 'confidence_basis',
];

// Build the idempotent UPSERT on the partial natural-key index
// (garden_node_id, entity_id, finding_type) WHERE deleted_at IS NULL. Returns {text, values}.
export function buildUpsertFinding(row) {
  const placeholders = COLS.map((_, i) => `$${i + 1}`).join(', ');
  const setClause = SEMANTIC.map((c) => `${c} = EXCLUDED.${c}`).join(',\n    ');
  const changed = SEMANTIC.map((c) => `findings.${c} IS DISTINCT FROM EXCLUDED.${c}`).join('\n    OR ');
  const text = `
INSERT INTO public.findings (${COLS.join(', ')})
VALUES (${placeholders})
ON CONFLICT (garden_node_id, entity_id, finding_type) WHERE deleted_at IS NULL
DO UPDATE SET
    ${setClause},
    computed_at = EXCLUDED.computed_at,
    record_version = findings.record_version + 1,
    deleted_at = NULL
WHERE ${changed}
RETURNING id, record_version, (xmax = 0) AS inserted`;
  const values = COLS.map((c) => row[c]);
  return { text, values };
}

// Soft-delete (NEVER hard delete — §9) the live finding for a resolved natural key. Returns {text, values}.
export function buildSoftDeleteResolved({ garden_node_id, entity_id, finding_type }, now) {
  const computed = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    text: `
UPDATE public.findings
   SET deleted_at = $4, record_version = record_version + 1
 WHERE garden_node_id = $1 AND entity_id = $2 AND finding_type = $3 AND deleted_at IS NULL
RETURNING id`,
    values: [garden_node_id, entity_id, finding_type, computed],
  };
}

// Execute the UPSERT on an INJECTED transaction-capable client (caller owns the surrounding transaction).
export async function materializeFinding(client, raw, composed, now) {
  const row = toPersistRow(raw, composed, now);
  const { text, values } = buildUpsertFinding(row);
  const res = await client.query(text, values);
  return res?.rows?.[0] ?? null; // {id, record_version, inserted} | null (no-op when nothing changed)
}

// Execute the soft-delete on an INJECTED client.
export async function softDeleteResolvedFinding(client, key, now) {
  const { text, values } = buildSoftDeleteResolved(key, now);
  const res = await client.query(text, values);
  return res?.rows?.[0]?.id ?? null;
}
