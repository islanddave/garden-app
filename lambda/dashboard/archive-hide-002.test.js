// BUG-ARCHIVEHIDE-002 (audit I30, I31, I32) — three dashboard reads that still loaded rows of
// ARCHIVED plantings: the dashboard's recent-events feed, header event search and header photo
// search. Each filtered the container archive (or nothing) and never the planting archive, which
// lambda/events' own feed and the Photo Library have filtered since V4-ARCHIVEHIDE-001.
//
// Each read is sliced out of handlers.js by its own export, so a predicate in one function cannot
// satisfy the assertion for another. Static-source (L-072), DB-free; the search/feed builders fold
// a failed section into [] (Promise.allSettled), so real-Postgres proof that each still RETURNS the
// live rows is in tests/integration/archive-hide-002.int.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'handlers.js'), 'utf8'));

function fn(name) {
  const start = SRC.search(new RegExp(`export (async )?function ${name}\\(`));
  expect(start, `function not found — update this anchor: ${name}`).toBeGreaterThan(-1);
  const next = SRC.slice(start + 1).search(/\nexport /);
  return next === -1 ? SRC.slice(start) : SRC.slice(start, start + 1 + next);
}

const PLANTING_ANTIJOIN =
  /AND NOT EXISTS \(SELECT 1 FROM public\.garden_node ga\s+WHERE ga\.id = e\.plant_id AND ga\.archived_at IS NOT NULL\)/;

describe('dashboard — BUG-ARCHIVEHIDE-002 I30, the recent-events feed', () => {
  // MUTATION: delete the NOT EXISTS from queryRecentEvents -> RED.
  it('filters events on ARCHIVED plantings', () => {
    expect(fn('queryRecentEvents')).toMatch(PLANTING_ANTIJOIN);
  });
  it('keeps the container archive and both soft-delete predicates (both axes, not one)', () => {
    const q = fn('queryRecentEvents');
    expect(q).toMatch(/AND pp\.archived_at IS NULL/);
    expect(q).toMatch(/AND pp\.deleted_at IS NULL/);
    expect(q).toMatch(/AND e\.deleted_at IS NULL/);
  });
  // The deleted-planting policy switch in the same WHERE binds gn; a gn-aliased anti-join would be
  // the archive filter reading the switch's join, silently.
  it('uses alias ga, distinct from the gn join the policy switch reads', () => {
    expect(fn('queryRecentEvents')).not.toMatch(/gn\.archived_at/);
  });
});

describe('dashboard — BUG-ARCHIVEHIDE-002 I31, header event search', () => {
  // MUTATION: delete the NOT EXISTS from searchEvents -> RED.
  it('filters events on ARCHIVED plantings', () => {
    expect(fn('searchEvents')).toMatch(PLANTING_ANTIJOIN);
  });
  it('keeps the container archive and soft-delete predicates', () => {
    expect(fn('searchEvents')).toMatch(/AND pp\.deleted_at IS NULL AND pp\.archived_at IS NULL/);
  });
});

describe('dashboard — BUG-ARCHIVEHIDE-002 I32, header photo search', () => {
  // MUTATION: delete either anti-join -> RED. The event arm is not optional: on prod 2026-08-13, 21
  // of 28 photos on archived plantings reached them only through an event.
  it('filters photos ON an archived planting', () => {
    expect(fn('searchPhotos')).toMatch(
      /AND NOT EXISTS \(\s*SELECT 1 FROM public\.garden_node gna\s+WHERE gna\.id = p\.plant_id AND gna\.archived_at IS NOT NULL\s*\)/);
  });
  it('filters photos on an EVENT of an archived planting, through a live event only', () => {
    expect(fn('searchPhotos')).toMatch(
      /AND NOT EXISTS \(\s*SELECT 1 FROM public\.event_log ea\s+JOIN public\.garden_node gne ON gne\.id = ea\.plant_id\s+WHERE ea\.id = p\.event_id AND ea\.deleted_at IS NULL\s+AND gne\.archived_at IS NOT NULL\s*\)/);
  });

  // The Photo Library's unscoped list carries the same two anti-joins; the search must not drift
  // from it (same pairing as supplier-image-marker-sync.test.js for the vendor-image predicate).
  it('matches the Photo Library unscoped list, anti-join for anti-join', () => {
    const lib = decomment(readFileSync(resolve(__dirname, '../photos/index.js'), 'utf8'));
    const norm = (s) => s.replace(/\s+/g, ' ');
    const arms = norm(fn('searchPhotos')).match(/AND NOT EXISTS \( SELECT 1 FROM public\.(garden_node gna|event_log ea).*?\) /g);
    expect(arms).toHaveLength(2);
    for (const arm of arms) expect(norm(lib)).toContain(arm.trim());
  });

  it('keeps the photo soft-delete and the supplier-image predicate', () => {
    const q = fn('searchPhotos');
    expect(q).toMatch(/AND p\.deleted_at IS NULL/);
    expect(q).toMatch(/NOT LIKE 'vendor-image--%'/);
  });
});

// T3b archive leftover — a photo hung off an ARCHIVED container (photos.project_id) still reached
// header search: searchPhotos joined no container at all. The join carries `pp.deleted_at IS NULL`
// IN THE ON CLAUSE (a deleted container is "no container", so its photo stays visible, as in the
// Library, which never hides on a deleted container) and the archive term sits in the WHERE.
describe('dashboard — T3b archive leftover, header photo search hides ARCHIVED-container photos', () => {
  // MUTATION: delete `AND pp.archived_at IS NULL` from searchPhotos -> RED.
  it('filters photos on an archived container', () => {
    expect(fn('searchPhotos')).toMatch(/\n\s+AND pp\.archived_at IS NULL\n/);
  });
  // MUTATION: move `AND pp.deleted_at IS NULL` from the ON into the WHERE (or drop it) -> RED.
  it('LEFT JOINs container with deleted_at in the ON clause, alias pp', () => {
    const q = fn('searchPhotos');
    expect(q).toMatch(/LEFT JOIN public\.container pp ON pp\.id = p\.project_id AND pp\.deleted_at IS NULL\n/);
    expect(q).not.toMatch(/WHERE[\s\S]*pp\.deleted_at/);
  });
});
