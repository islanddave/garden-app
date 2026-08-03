// Undo-after-log contract guard (V3-LOGMANY undo fix, 2026-06-10). Static-source per
// L-072 house style (DB-free; integration lives in tests/smoke + Neon-branch backlog).
//
// ROOT CAUSE pinned here: DELETE /api/events/:id was NEVER implemented in the events
// Lambda (verified across full git history, 2.0.x initial import -> 2.2.x) — only the
// CORS header advertised DELETE. The Dashboard 5s undo toast, EventDetail delete, and
// ProjectDetail delete were all written against that assumed contract and hit the
// /:id route's trailing 405 Method not allowed; clients catch + console.warn, so the
// failure was silent and the event survived. Batch undo (DELETE /api/events/batch/:id)
// was wired correctly and is guarded below.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('events Lambda — DELETE /api/events/:id (single-event undo)', () => {
  it('routes DELETE on /:id and soft-deletes by eventId (deleted_at, never hard-delete)', () => {
    expect(SRC).toMatch(/UPDATE event_log SET deleted_at = NOW\(\), updated_at = NOW\(\)\s*WHERE id = \$\{eventId\} AND deleted_at IS NULL/);
  });

  it('Soft-Delete-Only rule: no hard DELETE FROM event_log anywhere', () => {
    expect(SRC).not.toMatch(/DELETE\s+FROM\s+event_log/i);
  });

  it('ownership pre-check is household-widened (event-entity op) and 404s when not owned', () => {
    const idx = SRC.indexOf('/api/events/:id \u2014 single-event undo');
    expect(idx).toBeGreaterThan(-1);
    // Window widened 2600 -> 4000 (2026-08-03, BUG-EVTCASCADE-001): the child-row cascade added ~2KB
    // of code+rationale inside this route, leaving the old slice ~70 chars from a false failure. These
    // fixed-offset windows are the fragile part of the L-072 static-source style — size them for the
    // section, not for today's byte count.
    const block = SRC.slice(idx, idx + 4000);
    expect(block).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
    expect(block).toMatch(/resp\(404, \{ error: 'Not found' \}\)/);
  });

  it('returns 200 { undone: true, id } (clients ignore body today; contract pinned)', () => {
    expect(SRC).toMatch(/resp\(200, \{ undone: true, id: eventId \}\)/);
  });

  it('watering undo recomputes entity_memory from surviving events (parity with batch undo)', () => {
    const idx = SRC.indexOf('/api/events/:id \u2014 single-event undo');
    const block = SRC.slice(idx, idx + 6000);   // widened 4200 -> 6000, same reason as above
    expect(block).toMatch(/last_watered_at = surv\.mw/);
    expect(block).toMatch(/next_water_at = CASE WHEN surv\.mw IS NULL THEN NULL/);
  });

  it('regression guard: batch undo route (DELETE /api/events/batch/:id) still soft-deletes', () => {
    expect(SRC).toMatch(/UPDATE event_log SET deleted_at = NOW\(\), updated_at = NOW\(\)\s*WHERE metadata->>'batch_id' = \$\{batchId\} AND deleted_at IS NULL/);
  });
});
