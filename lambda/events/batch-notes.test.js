// V4-EVENTSEL-005 — ONE batch-level note on POST /api/events/batch.
//
// THE DEFECT THIS CLOSES, stated precisely: `notes` was neither validated nor inserted by the batch
// route. validateBatchBody ignores unknown keys, so a `notes` field passed validation silently, and
// the batch INSERT column list did not contain `notes`, so the value went nowhere. A client-only
// fix would therefore have shown the user a green "N plantings watered" screen while discarding
// their note across the ENTIRE batch. Silent loss behind a success screen is strictly worse than a
// missing field, which is why the Lambda half ships FIRST.
//
// Two kinds of assertion here, and the split is deliberate:
//   * PURE      — validateNotes / normalizeNotes, called directly.
//   * SOURCE    — the INSERT itself. There is no DB harness in the unit suite (L-072), and the
//                 claim worth pinning is "the column is in the list AND the value is bound in the
//                 SELECT", which is structural. The behavioural proof that the note reaches every
//                 row lives in tests/integration/batch-notes.int.test.js (written, needs a Neon
//                 branch to run).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateBatchBody, validateNotes, normalizeNotes,
  MAX_NOTES_LEN, NOTES_TYPE_ERROR, NOTES_LENGTH_ERROR,
} from './validators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — assertions run against decommented
// source, or a deleted INSERT column would be found in its own epitaph. Same shape as
// hs2-plant-filter.test.js / batch-order.test.js, the house pattern.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const base = (over = {}) => ({ idempotency_key: 'key-1', event_type: 'watering', scope: { type: 'all' }, ...over });

describe('validateNotes — the batch note is checked at the edge', () => {
  it('accepts absent / null notes (the note is optional and always has been)', () => {
    expect(validateNotes(undefined)).toBeNull();
    expect(validateNotes(null)).toBeNull();
  });

  it('accepts an ordinary note', () => {
    expect(validateNotes('side-dressed the whole bed with blood meal')).toBeNull();
  });

  it('accepts an empty string (blank is not an error — it normalizes to NULL)', () => {
    // Rejecting '' would 400 a user who focused the field and typed nothing. The right answer to a
    // blank note is "no note", not "your request is malformed".
    expect(validateNotes('')).toBeNull();
    expect(validateNotes('   \n  ')).toBeNull();
  });

  it('rejects a non-string note', () => {
    // Not hypothetical: event_log.notes is plain `text`, so an object bound here would be coerced
    // into a row rather than raising, and 500 rows would carry "[object Object]".
    for (const v of [42, true, {}, [], { toString: () => 'x' }]) {
      const r = validateNotes(v);
      expect(r?.status).toBe(400);
      expect(r?.error).toBe(NOTES_TYPE_ERROR);
    }
  });

  it('accepts a note exactly at the cap and rejects one character past it', () => {
    expect(validateNotes('x'.repeat(MAX_NOTES_LEN))).toBeNull();
    const r = validateNotes('x'.repeat(MAX_NOTES_LEN + 1));
    expect(r?.status).toBe(400);
    expect(r?.error).toBe(NOTES_LENGTH_ERROR);
  });

  it('measures the TRIMMED length, so trailing whitespace cannot 400 an in-range note', () => {
    expect(validateNotes('x'.repeat(MAX_NOTES_LEN) + '\n\n   ')).toBeNull();
  });

  it('the cap is generous enough that no real note can hit it', () => {
    // Longest note in prod on 2026-08-14 was 397 chars across 405 notes. A cap that could reject a
    // note a human actually wrote would be a worse defect than the one this row closes.
    expect(MAX_NOTES_LEN).toBeGreaterThanOrEqual(2000);
  });
});

describe('normalizeNotes — empty-to-NULL, not empty-string', () => {
  it('trims', () => {
    expect(normalizeNotes('  side-dressed the bed  ')).toBe('side-dressed the bed');
  });

  it('turns blank and whitespace-only into NULL', () => {
    // The known defect class: a '' row is an "event with a note" to every read surface in the app
    // (all of them test `notes` for truthiness or render it raw) and displays as a blank note.
    // Prod holds ZERO such rows; this path must not introduce the first 500 of them.
    expect(normalizeNotes('')).toBeNull();
    expect(normalizeNotes('   ')).toBeNull();
    expect(normalizeNotes('\n\t ')).toBeNull();
  });

  it('turns absent into NULL', () => {
    expect(normalizeNotes(undefined)).toBeNull();
    expect(normalizeNotes(null)).toBeNull();
  });

  it('preserves interior whitespace and newlines (a note is prose, not a token)', () => {
    expect(normalizeNotes('  line one\nline two  ')).toBe('line one\nline two');
  });
});

describe('validateBatchBody — notes', () => {
  it('a batch with NO notes is still valid (the old contract is untouched)', () => {
    expect(validateBatchBody(base())).toBeNull();
  });

  it('accepts a batch-level note', () => {
    expect(validateBatchBody(base({ notes: 'side-dressed the whole bed' }))).toBeNull();
  });

  it('rejects a non-string note with a 400 the client can surface', () => {
    const r = validateBatchBody(base({ notes: { text: 'nope' } }));
    expect(r?.status).toBe(400);
    expect(r?.error).toBe(NOTES_TYPE_ERROR);
  });

  it('rejects an over-length note', () => {
    const r = validateBatchBody(base({ notes: 'x'.repeat(MAX_NOTES_LEN + 1) }));
    expect(r?.status).toBe(400);
    expect(r?.error).toBe(NOTES_LENGTH_ERROR);
  });

  it('validates notes on a dry_run too (the preview must not accept what the write rejects)', () => {
    const r = validateBatchBody({ dry_run: true, event_type: 'watering', scope: { type: 'all' }, notes: 7 });
    expect(r?.status).toBe(400);
  });
});

describe('events Lambda — the batch INSERT actually writes notes', () => {
  // Anchor to the batch INSERT specifically. index.js has several INSERT INTO event_log statements
  // (the single-event CTE among them) and a global first-match would drift onto one of them.
  const batchInsertFrom = () => {
    const idx = SRC.indexOf('INSERT INTO event_log\n              (project_id, location_id, plant_id, event_type, event_date, is_public,');
    expect(idx, 'batch INSERT anchor not found — update this test, the route was restructured').toBeGreaterThan(-1);
    return SRC.slice(idx, SRC.indexOf('INSERT INTO entity_memory', idx));
  };

  it('normalizes the incoming note before it is bound', () => {
    expect(SRC).toMatch(/const batchNotes = normalizeNotes\(body\.notes\);/);
  });

  it('imports normalizeNotes from the shared validators (not a local re-implementation)', () => {
    expect(SRC).toMatch(/import \{[^}]*normalizeNotes[^}]*\} from '\.\/validators\.js';/s);
  });

  it('lists `notes` in the batch INSERT column list', () => {
    // THE bug: the column list was
    //   (project_id, location_id, plant_id, event_type, event_date, is_public,
    //    logged_by, created_by, metadata, source)
    // with no notes, so a validated note went nowhere at all.
    const stmt = batchInsertFrom();
    expect(stmt).toMatch(/metadata, source, notes\)/);
  });

  it('binds the normalized note in the SELECT list', () => {
    const stmt = batchInsertFrom();
    expect(stmt).toMatch(/\$\{batchNotes\}::text/);
  });

  it('casts the bound note explicitly (an untyped NULL parameter is a 42P18, not a NULL)', () => {
    // This is the difference between "batches with no note work" and "every batch 500s".
    const stmt = batchInsertFrom();
    expect(stmt).not.toMatch(/\$\{batchNotes\}(?!::text)/);
  });

  it('binds the note ONCE — it is a batch-level value, not a per-row one', () => {
    const stmt = batchInsertFrom();
    expect(stmt.match(/\$\{batchNotes\}/g)).toHaveLength(1);
  });

  it('the note rides the SAME single INSERT ... SELECT that writes the rows', () => {
    // Which is what makes "every row in the batch gets it" true by construction rather than by
    // loop discipline: one statement, one bound value, N rows. It is also the answer to partial
    // failure — the statement is inside sql.transaction([...]), so either every row lands with the
    // note or none of them land at all. There is no partial-batch state for a note to survive in.
    const stmt = batchInsertFrom();
    expect(stmt).toMatch(/FROM public\.garden_node p JOIN public\.container pp ON pp\.id = p\.container_id/);
    expect(stmt).toMatch(/WHERE p\.id = ANY\(\$\{plantIds\}\)/);
    expect(SRC.slice(0, SRC.indexOf('${batchNotes}::text'))).toMatch(/await sql\.transaction\(\[/);
  });

  it('did not touch the batch side-effect set (scope was the note column only)', () => {
    // BUG-BATCHSIDEEFFECTS-001 territory: the batch path is NOT the single-event path, and this row
    // deliberately did not "helpfully" add anything adjacent.
    expect(SRC).toMatch(/const batchFx = await applyBatchSideEffects\(\{/);
    expect(SRC.match(/applyBatchSideEffects\(\{/g)).toHaveLength(2); // fresh path + idempotent re-hit
  });
});
