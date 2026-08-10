// BUG-LASTISSUEPLANT-001, second pass — the guard for the class that caused the miss.
//
// WHAT HAPPENED: adding last_issue_at to the plant-keyed forward upsert touched the INSERT column
// list and the SELECT values, but NOT the ON CONFLICT ... DO UPDATE SET. The result reads complete
// — the column list names every column — and is a no-op on a mature table: the INSERT arm of an
// upsert only runs on FIRST touch, so a brand-new planting got a value and all 262 existing rows
// could never advance one. It shipped, and CI was green, because every static assertion about that
// statement was written against the column list.
//
// THE INVARIANT: for an upsert whose purpose is to maintain a cache, every column in the INSERT
// list except the conflict key must also appear on the left-hand side of the DO UPDATE. A column
// present in one arm and absent from the other is either a half-finished edit or a deliberate
// asymmetry that needs saying out loud.
//
// This is cheap, structural, and catches the whole family rather than the one instance — the same
// posture as clear-channel-coverage.test.js and blank-name-guard.test.js.
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

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Columns a given upsert may legitimately insert without updating.
//
// SCOPED PER STATEMENT, NOT GLOBAL — and that scoping is the whole design. The first draft of this
// file used a flat {column: reason} map, so exempting last_issue_at for the batch arm exempted it
// on EVERY arm, including the plant-keyed forward upsert this file exists to guard. Mutation-testing
// caught it: deleting the very arm the fix had just added left the suite green. A guard whose
// allowlist is coarser than the thing it guards is worse than no guard, because it reads like
// coverage.
//
// `where` must appear in that upsert's own SELECT body, so an entry cannot drift onto a statement
// it was never written about.
const ALLOWED_ASYMMETRY = [
  {
    where: 'FROM public.garden_node p',      // the BATCH arms only
    cols: {
      last_harvested_at: 'batch arm inserts a literal NULL — a batch event is never a harvest',
      last_issue_at: 'batch arm inserts a literal NULL — the batch POST has no flagged_as_issue input',
      next_water_at: 'batch arm derives it in its own CASE from the watering date',
    },
  },
];

const exemptFor = (u, col) => ALLOWED_ASYMMETRY.some(
  (e) => u.select.includes(e.where) && col in e.cols);

// Every `INSERT INTO entity_memory ( ... ) ... ON CONFLICT ... DO UPDATE SET ...` in the file.
function upserts(src) {
  const out = [];
  const re = /INSERT INTO entity_memory\s*\(([\s\S]*?)\)\s*SELECT([\s\S]*?)ON CONFLICT\s*\(([a-z_]+)\)[\s\S]*?DO UPDATE SET([\s\S]*?)updated_at = NOW\(\)/g;
  for (const m of src.matchAll(re)) {
    out.push({
      cols: m[1].split(',').map((s) => s.trim()).filter(Boolean),
      select: m[2],
      key: m[3],
      setCols: [...m[4].matchAll(/^\s*([a-z_]+)\s*=/gm)].map((x) => x[1]),
      at: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

describe('entity_memory upserts: the INSERT list and the DO UPDATE must agree', () => {
  const found = upserts(SRC);

  it('finds the upserts (guards against an empty match)', () => {
    // Without this, a formatting change that breaks the regex turns the whole file into a vacuous
    // pass. Assert the shape of the world before asserting anything about it.
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found.some((u) => u.key === 'plant_id')).toBe(true);
    expect(found.some((u) => u.key === 'project_id')).toBe(true);
    for (const u of found) {
      expect(u.cols.length, `upsert near line ${u.at} parsed no columns`).toBeGreaterThan(3);
      expect(u.setCols.length, `upsert near line ${u.at} parsed no SET columns`).toBeGreaterThan(3);
    }
  });

  it.each(found.map((u) => [u.at, u]))(
    'upsert at line ~%s updates every column it inserts', (_at, u) => {
      const set = new Set(u.setCols);
      const missing = u.cols
        .filter((c) => c !== u.key)
        .filter((c) => !set.has(c))
        .filter((c) => !exemptFor(u, c));
      expect(missing,
        `upsert at line ~${u.at} (ON CONFLICT ${u.key}) inserts [${missing.join(', ')}] but never ` +
        'updates them. The INSERT arm only runs on FIRST touch, so on a table that already has ' +
        'rows this is a no-op that reads complete — exactly how BUG-LASTISSUEPLANT-001 shipped ' +
        'half-fixed. Add the DO UPDATE arm, or add a reasoned ALLOWED_ASYMMETRY entry.')
        .toEqual([]);
    });

  it('the plant-keyed forward upsert maintains last_issue_at on BOTH arms', () => {
    // The specific regression, pinned by name. The generic assertion above would also catch it,
    // but this one names the column so a failure explains itself without re-deriving the class.
    const plantFwd = found.find((u) => u.key === 'plant_id' && u.cols.includes('last_issue_at'));
    expect(plantFwd, 'no plant-keyed upsert declares last_issue_at').toBeTruthy();
    expect(plantFwd.setCols).toContain('last_issue_at');
  });

  it('every ALLOWED_ASYMMETRY entry names a real statement and carries a real reason', () => {
    for (const e of ALLOWED_ASYMMETRY) {
      expect(found.some((u) => u.select.includes(e.where)),
        `ALLOWED_ASYMMETRY entry '${e.where}' matches no upsert — a stale exemption silently ` +
        'pre-authorizes whatever statement drifts into matching it next').toBe(true);
      for (const [col, why] of Object.entries(e.cols)) {
        expect(typeof why === 'string' && why.trim().length > 20,
          `ALLOWED_ASYMMETRY['${e.where}']['${col}'] needs a real reason`).toBe(true);
      }
    }
  });
});
