// Pure validators for Lambda 2.2.x POST /api/events.
// Extracted from index.js so unit tests can import without dragging in
// @neondatabase/serverless / @clerk/backend / @aws-sdk/* (which aren't installed
// at the app-level package and would break vitest resolution).
//
// V002 §1.2 (F5, F6, F18, F22 applied). Source of truth for HARVEST_UNITS /
// MAX_PLAUSIBLE values: harvest_log.unit CHECK constraint in
// migrations/v1-2a-2/0a-additive-ddl.sql — vocabulary drift will break the dual-write CTE.

export const HARVEST_UNITS = ['lb', 'oz', 'kg', 'g', 'count', 'bunch', 'cup', 'head'];
export const MAX_PLAUSIBLE = {
  count: 10000, lb: 500, oz: 8000, kg: 500, g: 500000,
  bunch: 1000, cup: 1000, head: 1000,
};

// F22 event_date bounds. Tolerates clock-skew + small client lag.
const PAST_BOUND_MS = 5 * 365 * 24 * 3600 * 1000;
const FUTURE_BOUND_MS = 3600 * 1000;

// Returns null on success, or { status, error } on validation failure.
export function validatePostBody(body) {
  if (!body.event_type) return { status: 400, error: 'event_type is required' };
  if (!body.project_id) return { status: 400, error: 'project_id is required' };

  // F22 — event_date range validation
  if (body.event_date != null) {
    const ed = new Date(body.event_date);
    if (!Number.isFinite(ed.getTime())) return { status: 400, error: 'event_date invalid' };
    const now = Date.now();
    if (ed.getTime() < now - PAST_BOUND_MS) return { status: 400, error: 'event_date too far in past' };
    if (ed.getTime() > now + FUTURE_BOUND_MS) return { status: 400, error: 'event_date in future' };
  }

  // F6 reorder: severity SHAPE check first.
  if (body.severity != null && ![1, 2, 3].includes(body.severity)) {
    return { status: 400, error: 'severity must be 1, 2, or 3' };
  }
  // F5: severity REQUIRED when flagged_as_issue=true
  if (body.flagged_as_issue === true && body.severity == null) {
    return { status: 400, error: 'severity required when flagged_as_issue=true' };
  }
  // severity without flag invalid
  if (body.severity != null && body.flagged_as_issue !== true) {
    return { status: 400, error: 'severity requires flagged_as_issue=true' };
  }

  // Harvest validators
  if (body.event_type === 'harvest') {
    if (!body.harvest || typeof body.harvest !== 'object') {
      return { status: 400, error: 'harvest fields required for event_type=harvest' };
    }
    if (typeof body.harvest.quantity !== 'number'
      || !Number.isFinite(body.harvest.quantity)
      || body.harvest.quantity <= 0) {
      return { status: 400, error: 'harvest.quantity must be a positive finite number' };
    }
    if (!HARVEST_UNITS.includes(body.harvest.unit)) {
      return { status: 400, error: 'harvest.unit invalid' };
    }
    // F18 per-unit upper bound
    if (body.harvest.quantity > MAX_PLAUSIBLE[body.harvest.unit]) {
      return { status: 400, error: `harvest.quantity exceeds max for unit ${body.harvest.unit}` };
    }
    if (body.harvest.quality_rating != null
      && ![1, 2, 3, 4, 5].includes(body.harvest.quality_rating)) {
      return { status: 400, error: 'harvest.quality_rating must be 1-5' };
    }
  }

  // Forbid harvest fields on non-harvest events
  if (body.event_type !== 'harvest' && body.harvest != null) {
    return { status: 400, error: 'harvest fields only valid on event_type=harvest' };
  }

  return null;
}

// F9 UUID regex — applied before any SQL fires so Postgres never sees a malformed UUID.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Bulk "Quick Log" / Unit A (2026-05-24, expanded 2026-05-28) ───────────
// V3-EVENT-008: the batch allowlist is now DERIVED, not hand-listed. It is generated
// from the canonical src/lib/eventTypes.js (EVENT_TYPES − BATCH_EXCLUDED_TYPES) into the
// committed sibling eventTypes.generated.js by scripts/gen-lambda-event-types.mjs, and
// CI (`npm run check:event-types`) fails on any drift. The deployed Lambda is a standalone
// zip with no bundler, so it imports the generated SIBLING (not src/lib/) at runtime.
// Excluded by design (see BATCH_EXCLUDED_TYPES in eventTypes.js):
//   - harvest / first_harvest — require quantity+unit (dual-write to harvest_log)
//   - photo                   — requires a file upload (no bulk semantics)
//   - divided / cutting_taken — HS-1: spawn child plantings (lineage/transaction risk)
//   - hand_pollinated / fruit_set — HS-1: single-plant events, no bulk semantics
import { BATCH_EVENT_TYPES } from './eventTypes.generated.js';
export { BATCH_EVENT_TYPES };

// Returns null on success, or { status, error } on validation failure.
export function validateBatchBody(body) {
  if (body.dry_run !== true && (!body.idempotency_key || typeof body.idempotency_key !== 'string')) {
    return { status: 400, error: 'idempotency_key is required' };
  }
  if (!body.event_type) return { status: 400, error: 'event_type is required' };
  if (!BATCH_EVENT_TYPES.includes(body.event_type)) {
    return { status: 400, error: `event_type must be one of: ${BATCH_EVENT_TYPES.join(', ')} (harvest/first_harvest/photo not supported in batch)` };
  }
  if (body.event_date != null) {
    const ed = new Date(body.event_date);
    if (!Number.isFinite(ed.getTime())) return { status: 400, error: 'event_date invalid' };
    const now = Date.now();
    if (ed.getTime() < now - PAST_BOUND_MS) return { status: 400, error: 'event_date too far in past' };
    if (ed.getTime() > now + FUTURE_BOUND_MS) return { status: 400, error: 'event_date in future' };
  }
  const s = body.scope;
  if (!s || typeof s !== 'object') return { status: 400, error: 'scope is required' };
  if (!['all', 'project', 'space'].includes(s.type)) {
    return { status: 400, error: 'scope.type must be all, project, or space' };
  }
  if (s.type === 'project' && !UUID_RE.test(s.project_id ?? '')) {
    return { status: 400, error: 'scope.project_id must be a UUID when scope.type=project' };
  }
  if (s.type === 'space' && !UUID_RE.test(s.location_id ?? '')) {
    return { status: 400, error: 'scope.location_id must be a UUID when scope.type=space' };
  }
  if (body.exclude_plant_ids != null) {
    if (!Array.isArray(body.exclude_plant_ids)) {
      return { status: 400, error: 'exclude_plant_ids must be an array' };
    }
    if (body.exclude_plant_ids.some((id) => !UUID_RE.test(id))) {
      return { status: 400, error: 'exclude_plant_ids must all be UUIDs' };
    }
  }
  return null;
}


// ── Event-date normalization (2.1.x event-date off-by-one fix) ──────────────
// Date-only values ("YYYY-MM-DD") from the create forms must be NOON-anchored.
// Otherwise `new Date("2026-05-24")` is parsed as MIDNIGHT UTC, which renders a
// day early in behind-UTC timezones (EDT) — the bug Dave hit logging a fert.
// Noon UTC stays the same calendar date across all real-world offsets. Full
// datetimes (the edit path already sends one) pass through unchanged.
// Returns an ISO string, or null for empty/invalid (caller falls back to now()).
export function normalizeEventDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00Z' : s;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
