// BUG-QTYSPLITBRAIN-001 — the guard for the class that let event_log.quantity_numeric drift.
//
// WHAT HAPPENED: migrations/v1-2a-2/0a-additive-ddl.sql §3.2 declares the pairing invariant in so
// many words — "Convention (Lambda-enforced): every harvest_log row has a paired event_log row
// (event_id FK, event_type='harvest', quantity_numeric=harvest_log.quantity)". The single-event POST
// honours it: the CTE writes quantity_numeric and harvest_log.quantity from the same bound value.
// The PUT does not. It updates harvest_log.quantity and leaves event_log.quantity_numeric at
// whatever the INSERT wrote, so editing a harvest amount silently breaks the invariant. Prod carries
// exactly one live violation today (event 98ffe6ed, quantity_numeric=35 vs harvest_log.quantity=1,
// created and edited the same day) — small only because quantity_numeric has no reader yet, which is
// the reason nothing surfaced it, not a reason it is safe.
//
// THE INVARIANT: every column the single-event INSERT writes must also be maintained by the edit
// UPDATE, unless it is a column the edit surface deliberately does not own — and that exemption has
// to be written down with a reason rather than left as an absence.
//
// Structural and cheap, the same posture as upsert-symmetry.test.js, and it catches the family (any
// future column added to the INSERT and forgotten in the UPDATE) rather than this one instance.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — see upsert-symmetry.test.js for the full
// account of why every raw-source guard here runs against decommented source.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Columns the INSERT writes and the edit UPDATE legitimately never touches.
//
// quantity_numeric is deliberately ABSENT from this list. It was the one entry that would have
// belonged here on a reading of clearFields.js ("No edit surface owns them") and it is precisely the
// column the DDL says the Lambda must keep in step with harvest_log. Exempting it is what the bug
// looked like from the inside.
const NOT_EDITABLE = {
  logged_by:  'authorship of the original write — an edit never reassigns who logged the event',
  created_by: 'authorship of the original write — an edit never reassigns the owner',
  source:     'V4-EVENTSOURCE-001 provenance of the WRITE, not of the current values; an edit must ' +
              'not relabel a batch row as a single one',
};

// The single-event POST INSERT. `[^)]` stops at the close of the column list, which also skips the
// batch `INSERT INTO event_log (...) SELECT` above it — that one has no VALUES and never writes
// quantity_numeric (a batch event is never a harvest).
function insertCols(src) {
  const m = src.match(/INSERT INTO event_log\s*\(([^)]*?)\)\s*VALUES/);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

// The edit UPDATE, anchored on `SET event_type` so it cannot match the PATCH resolve route
// (`UPDATE event_log el SET resolved_at = ...`) or either soft-delete statement.
function editSetCols(src) {
  const m = src.match(/UPDATE event_log el\s+SET\s+event_type([\s\S]*?)\n\s*WHERE el\.id/);
  if (!m) return null;
  return [...`event_type${m[1]}`.matchAll(/^\s*([a-z_]+)\s*=/gm)].map((x) => x[1]);
}

describe('event_log single-event INSERT and edit UPDATE must agree on columns', () => {
  const ins = insertCols(SRC);
  const set = editSetCols(SRC);

  it('finds both statements (guards against an empty match)', () => {
    // Without this, a reformat that breaks either regex turns the whole file into a vacuous pass.
    // Assert the shape of the world before asserting anything about it.
    expect(ins, 'single-event INSERT INTO event_log ... VALUES not found').toBeTruthy();
    expect(set, 'edit UPDATE event_log el SET event_type ... not found').toBeTruthy();
    expect(ins.length).toBeGreaterThanOrEqual(20);
    expect(set.length).toBeGreaterThanOrEqual(18);
    expect(ins).toContain('quantity_numeric');
    expect(ins).toContain('event_type');
    expect(set).toContain('event_type');
  });

  it('the edit UPDATE maintains every column the INSERT writes', () => {
    const missing = ins.filter((c) => !set.includes(c)).filter((c) => !(c in NOT_EDITABLE));
    expect(missing,
      `the single-event INSERT writes [${missing.join(', ')}] but the edit UPDATE never maintains ` +
      'them, so the value the POST stored survives every later edit. Add the column to the SET ' +
      'list, or add a reasoned NOT_EDITABLE entry.')
      .toEqual([]);
  });

  it('the edit UPDATE maintains quantity_numeric', () => {
    // The specific regression, pinned by name. The generic assertion above also catches it, but
    // this one says the column out loud so a failure explains itself without re-deriving the class.
    expect(set,
      'event_log.quantity_numeric is not in the edit UPDATE SET list. migrations/v1-2a-2/' +
      '0a-additive-ddl.sql §3.2 makes quantity_numeric=harvest_log.quantity a Lambda-enforced ' +
      'invariant; an edit that moves harvest_log.quantity without it re-opens BUG-QTYSPLITBRAIN-001.')
      .toContain('quantity_numeric');
  });

  it('quantity_numeric is bound from the same value as the harvest_log UPDATE', () => {
    // Symmetry of the column LIST is not symmetry of the VALUE — a SET arm that wrote some other
    // expression would satisfy the assertions above and still diverge. Both writes must trace to
    // harvest_log's own quantity binding, which in the edit route is `hq`.
    const m = SRC.match(/quantity_numeric\s*=([\s\S]{0,240}?),\n/);
    expect(m, 'no quantity_numeric assignment found in the edit UPDATE').toBeTruthy();
    expect(m[1], 'quantity_numeric must be bound from hq, the same local the harvest_log UPDATE ' +
      'binds its own quantity from').toMatch(/\$\{hq\}/);
    expect(SRC, 'the harvest_log UPDATE must still bind quantity from hq')
      .toMatch(/UPDATE harvest_log h\s+SET quantity\s*=\s*\$\{hq\}::numeric/);
  });

  it('every NOT_EDITABLE entry names a real INSERT column and carries a real reason', () => {
    for (const [col, why] of Object.entries(NOT_EDITABLE)) {
      expect(ins,
        `NOT_EDITABLE['${col}'] names no INSERT column — a stale exemption silently pre-authorizes ` +
        'whatever column drifts into matching it next').toContain(col);
      expect(set,
        `NOT_EDITABLE['${col}'] is exempt but the UPDATE sets it anyway — drop the exemption`)
        .not.toContain(col);
      expect(typeof why === 'string' && why.trim().length > 20,
        `NOT_EDITABLE['${col}'] needs a real reason`).toBe(true);
    }
  });
});
