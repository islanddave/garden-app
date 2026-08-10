// V3-ARCHIVE-001 (Decision 6): logging on an archived planting is allowed, but the critter
// reward is suppressed. Behavioral test of the awardCritterServer chokepoint + static guard
// that bulk scope-resolution excludes archived plantings.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('./critterSpecies.js', () => ({
  pickSpecies: vi.fn(() => 3),
  pickCopyVariant: vi.fn(() => 0),
}));
import { awardCritterServer } from './critterAward.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// sql mock: archived check returns a row with archived_at set when archived=true.
function makeSql({ archived = false } = {}) {
  const calls = [];
  const sql = (strings) => {
    const q = strings.join('?');
    calls.push(q);
    if (q.includes('SELECT archived_at FROM public.garden_node')) {
      return Promise.resolve([{ archived_at: archived ? '2026-06-12T00:00:00Z' : null }]);
    }
    if (q.includes('public.critter_state')) return Promise.resolve([{ id: 'c1', species_id: 3 }]);
    return Promise.resolve([]);
  };
  sql.calls = calls;
  return sql;
}
const base = { userId: 'u1', eventId: 'e1', plantId: 'p1', eventCreatedAt: '2026-06-12T00:00:00Z', householdId: 'u1' };

describe('awardCritterServer — V3-ARCHIVE-001 reward suppression', () => {
  beforeEach(() => vi.clearAllMocks());

  it('suppresses the award when the planting is archived (returns null, no critter_state INSERT)', async () => {
    const sql = makeSql({ archived: true });
    const res = await awardCritterServer({ sql, ...base });
    expect(res).toBeNull();
    expect(sql.calls.some(q => q.includes('public.critter_state'))).toBe(false);
  });

  it('still awards when the planting is NOT archived', async () => {
    const sql = makeSql({ archived: false });
    const res = await awardCritterServer({ sql, ...base });
    expect(res?.id).toBe('c1');
  });

  it('events bulk scope-resolution excludes archived plantings', () => {
    expect(SRC).toMatch(/WHERE p\.deleted_at IS NULL AND pp\.deleted_at IS NULL AND p\.archived_at IS NULL/);
  });
});
