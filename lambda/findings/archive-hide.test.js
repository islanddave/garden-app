// V4-ARCHIVEHIDE-001 (L5) — Findings must not raise care copy for an ARCHIVED planting.
//
// Findings renders "likely needs water" / "may need attention" with a Treated action, so a leaked
// row is not a cosmetic listing — it is an instruction to go treat something the user has put away.
// Same defect class as BUG-FINDINGSDORMANT-001 (dead tissue being asked for water), which is why the
// predicate sits beside that one rather than on the join.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('findings Lambda — archived plantings raise no findings (L5)', () => {
  it('the query filters archived_at in the WHERE clause', () => {
    expect(SRC).toMatch(/AND p\.archived_at IS NULL/);
  });

  it('did not trade the deleted_at axis for the archived_at axis', () => {
    expect(SRC).toMatch(/JOIN public\.garden_node p ON p\.id = e\.plant_id AND p\.deleted_at IS NULL/);
    expect(SRC).toMatch(/WHERE e\.deleted_at IS NULL/);
  });

  it('keeps the dormant/ended/failed status gate alongside it, not instead of it', () => {
    // archived_at alone would NOT close BUG-FINDINGSDORMANT-001 and the status set alone does not
    // close this one: a live-status planting can be archived, and an archived one can be 'growing'.
    expect(SRC).toMatch(/p\.status NOT IN \('dormant','ended','failed','rooting'\)/);
  });

  // Plant axis only. plant_projects also carries archived_at, but whether archiving a CONTAINER
  // should silence care for the LIVE plantings inside it is an open ruling — asserted as an explicit
  // scope boundary so a later widening is a deliberate edit to this file rather than a quiet drift.
  it('does not (yet) filter the container axis', () => {
    expect(SRC).not.toMatch(/pp\.archived_at/);
  });
});
