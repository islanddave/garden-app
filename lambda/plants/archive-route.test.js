// V3-ARCHIVE-001 regression guard (plants). Static-source per L-072 house style (DB-free).
// Pins: (1) a PATCH /api/plants/:id/archive route exists and symmetric-toggles archived_at;
// (2) the two active-LIST reads exclude archived; (3) by-id GET/PUT/DELETE do NOT (archived
// items must still open/edit/delete); (4) the /seen reward gate excludes archived.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// Branch-bounded extractors replace the old fixed-width `SRC.slice(i, i + N)` windows. A char
// count is not a statement boundary: it drifts every time the code above it grows, and it fails
// SILENTLY — too long and a neighbouring branch answers for this one, too short and a negative
// assertion passes because the thing it forbids was never inside the window.
function branch(openAnchor, closeAnchor) {
  const start = SRC.indexOf(openAnchor);
  expect(start, `${openAnchor} not found`).toBeGreaterThan(-1);
  const end = SRC.indexOf(closeAnchor, start);
  expect(end, `${closeAnchor} (end anchor for ${openAnchor}) not found — the extractor would run ` +
    'past its branch and let a neighbour satisfy these assertions').toBeGreaterThan(start);
  return SRC.slice(start, end);
}
const archiveBranch = () => branch('if (archiveMatch)', 'if (idMatch) {');

// The by-id GET's WHERE clause, whole, to the end of its template literal.
// TWO stacked defects here before this rewrite, both proven by mutation:
//   (a) WRONG ANCHOR. `SRC.indexOf('WHERE p.id = ${plantId}')` returns the FIRST of four
//       occurrences — index.js:179, which is the ARCHIVE branch's UPDATE. The by-id GET is at
//       :258. The test named "by-id GET is NOT archived-filtered" had never once read the by-id
//       GET.
//   (b) WINDOW TOO SMALL. The 160 chars from that anchor were `WHERE p.id = ${plantId}` + a
//       three-line `--` comment + `EXISTS (` — the predicate list did not begin inside the
//       window, so `not.toMatch(/archived_at/)` could not have failed for any input.
// Mutation that proved both: add `AND p.archived_at IS NULL` to the by-id GET's WHERE at :259.
// Archived plantings become un-openable — the exact regression this `it` is titled after — and
// all six tests stayed GREEN.
function byIdGetWhere() {
  const branchStart = SRC.indexOf('if (idMatch) {');
  expect(branchStart, 'if (idMatch) { not found').toBeGreaterThan(-1);
  const start = SRC.indexOf('WHERE p.id = ${plantId}', branchStart);
  expect(start, 'by-id GET WHERE not found inside the idMatch branch').toBeGreaterThan(branchStart);
  const end = SRC.indexOf('`;', start);
  expect(end, 'by-id GET template literal never closes').toBeGreaterThan(start);
  const w = SRC.slice(start, end);
  // Floor: a negative assertion over an empty/degenerate window is vacuously true, so pin that
  // the window really does contain the ownership predicates that belong to this WHERE.
  expect(w, 'by-id GET WHERE window does not contain its own ownership predicate').toMatch(
    /p\.deleted_at IS NULL[\s\S]*created_by = ANY\(\$\{householdIds\}\)/);
  return w;
}

describe('plants Lambda — V3-ARCHIVE-001 archive route + filters', () => {
  it('defines the /archive matcher', () => {
    expect(SRC).toMatch(/archiveMatch = rawPath\.match\(\/\^\\\/api\\\/plants\\\/\(\[\^\/\]\+\)\\\/archive\$\/\)/);
  });
  it('archive handler is PATCH-only and toggles archived_at symmetrically', () => {
    // Was `SRC.slice(i, i + 1800)` — a width that had already been hand-widened once from 1300
    // when the code above it grew. Bounded by the next branch instead, so it neither truncates
    // nor spills into the by-id routes.
    const block = archiveBranch();
    expect(block).toMatch(/method !== 'PATCH'/);
    expect(block).toMatch(/archived_at = CASE WHEN \$\{archived\} THEN NOW\(\) ELSE NULL END/);
    expect(block).toMatch(/body\.archived !== false/); // default true
    expect(block).toMatch(/AND p\.deleted_at IS NULL/); // can't archive a deleted row
  });
  it('archive handler does not introduce a SELECT...FROM garden_node p block (3-block invariant)', () => {
    // Negative assertion: was `i + 900`, which ended mid-comment well before the branch did, so
    // a `SELECT ... FROM public.garden_node p` added in the back half of the branch was outside
    // the window and could not fail. Now bounded by the branch itself.
    expect(/SELECT[\s\S]*FROM\s+public\.garden_node\s+p\b/.test(archiveBranch())).toBe(false);
  });
  it('both active-LIST reads exclude archived plantings', () => {
    const m = SRC.match(/AND p\.archived_at IS NULL\n\s*ORDER BY p\.created_at DESC/g) ?? [];
    expect(m.length).toBe(2);
  });
  it('the /seen reward gate excludes archived plantings', () => {
    expect(SRC).toMatch(/ln\.deleted_at IS NULL AND ln\.archived_at IS NULL/);
  });
  it('by-id GET is NOT archived-filtered (archived items still open)', () => {
    // The by-id GET WHERE carries p.deleted_at + the container-ownership arm, no archived
    // predicate. See byIdGetWhere() above for the two defects this replaces.
    expect(byIdGetWhere()).not.toMatch(/archived_at/);
  });
});
