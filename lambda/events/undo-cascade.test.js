// Child-row handling on event undo (BUG-EVTCASCADE-001, 2026-08-03). Static-source per L-072 house
// style, matching undo-route.test.js (DB-free; live behaviour is covered by the integrity-weekly job).
//
// ROOT CAUSE pinned here: DELETE /api/events/:id and DELETE /api/events/batch/:id soft-deleted
// event_log ONLY. Nothing touched the rows that hang off an event, so every undo stranded its
// children against a dead parent — 18 of 45 all-time prod deletes leaked (9 harvest_log, 6 photos,
// 6 critter_state) before integrity-weekly caught the growth.
//
// The invariant these tests defend is NOT "cascade everything". Each child type gets the treatment
// its semantics demand, and the two most valuable assertions below are the NEGATIVE ones: photos must
// never be soft-deleted by an undo (irreplaceable user content), and critter_state must never be
// touched at all (earned rewards are not clawed back). A future "consistency" refactor that unifies
// these three into one cascade would destroy user data and pass every positive test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const SRC = decomment(RAW);

// The route markers are COMMENT banners, so the offsets are taken in RAW; the extracted window is
// then decommented so every assertion below runs against code and cannot be satisfied by prose.
const singleUndo = () => {
  const idx = RAW.indexOf('/api/events/:id — single-event undo');
  expect(idx).toBeGreaterThan(-1);
  return decomment(RAW.slice(idx, idx + 6000));
};
const batchUndo = () => {
  const idx = RAW.indexOf('/api/events/batch/:id — undo a batch');
  expect(idx).toBeGreaterThan(-1);
  return decomment(RAW.slice(idx, idx + 3000));
};

describe('events Lambda — single-event undo cascades to child rows', () => {
  it('soft-deletes the event’s harvest_log rows', () => {
    expect(singleUndo()).toMatch(
      /UPDATE harvest_log SET deleted_at = NOW\(\), updated_at = NOW\(\)\s*WHERE event_id = \$\{eventId\} AND deleted_at IS NULL/);
  });

  it('detaches photos instead of deleting them, and re-parents from the event', () => {
    const block = singleUndo();
    expect(block).toMatch(/UPDATE photos ph SET[\s\S]*?event_id\s*=\s*NULL/);
    expect(block).toMatch(/project_id = COALESCE\(ph\.project_id, e\.project_id\)/);
    expect(block).toMatch(/plant_id\s*= COALESCE\(ph\.plant_id,\s*e\.plant_id\)/);
  });

  it('re-parents by reading event_log, never by binding a possibly-NULL plantId param', () => {
    // The neon driver cannot infer the type of a NULL bound param even with an explicit ::uuid cast,
    // and plant_id is NULL on every project-level event — so `${plantId}` here would 500 the undo on
    // exactly the events that are most common. Guard the FROM event_log form.
    const block = singleUndo();
    expect(block).toMatch(/UPDATE photos ph SET[\s\S]*?FROM event_log e/);
    expect(block).not.toMatch(/COALESCE\(ph\.plant_id,\s*\$\{plantId\}/);
  });
});

describe('events Lambda — batch undo cascades identically', () => {
  it('soft-deletes harvest_log rows for every event in the batch', () => {
    expect(batchUndo()).toMatch(
      /UPDATE harvest_log h SET deleted_at = NOW\(\), updated_at = NOW\(\)[\s\S]*?e\.metadata->>'batch_id' = \$\{batchId\}/);
  });

  it('detaches the batch’s photos rather than deleting them', () => {
    const block = batchUndo();
    expect(block).toMatch(/UPDATE photos ph SET[\s\S]*?event_id\s*=\s*NULL/);
    expect(block).toMatch(/e\.metadata->>'batch_id' = \$\{batchId\}/);
  });

  it('keys the child updates on batch_id, so a partially-undone batch converges', () => {
    // Deliberately NOT keyed on the events this call just soft-deleted: if an earlier undo attempt
    // half-applied, the leftover children must still be swept rather than stranded forever.
    const block = batchUndo();
    const harvestStmt = block.slice(block.indexOf('UPDATE harvest_log h SET'));
    expect(harvestStmt.slice(0, 400)).not.toMatch(/e\.deleted_at IS NULL/);
  });
});

describe('events Lambda — what undo must NEVER do to child rows', () => {
  it('never hard-deletes from any child table', () => {
    expect(SRC).not.toMatch(/DELETE\s+FROM\s+harvest_log/i);
    expect(SRC).not.toMatch(/DELETE\s+FROM\s+photos/i);
    expect(SRC).not.toMatch(/DELETE\s+FROM\s+critter_state/i);
  });

  it('never soft-deletes photos on undo — a deleted harvest must not eat the picture', () => {
    for (const block of [singleUndo(), batchUndo()]) {
      expect(block).not.toMatch(/UPDATE photos[\s\S]*?SET[\s\S]{0,200}?deleted_at = NOW\(\)/);
    }
  });

  it('never writes critter_state on undo — earned rewards are not clawed back', () => {
    for (const block of [singleUndo(), batchUndo()]) {
      expect(block).not.toMatch(/UPDATE\s+critter_state/i);
    }
  });
});
