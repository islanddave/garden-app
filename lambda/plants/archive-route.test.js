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

describe('plants Lambda — V3-ARCHIVE-001 archive route + filters', () => {
  it('defines the /archive matcher', () => {
    expect(SRC).toMatch(/archiveMatch = rawPath\.match\(\/\^\\\/api\\\/plants\\\/\(\[\^\/\]\+\)\\\/archive\$\/\)/);
  });
  it('archive handler is PATCH-only and toggles archived_at symmetrically', () => {
    const i = SRC.indexOf('if (archiveMatch)');
    expect(i).toBeGreaterThan(-1);
    const block = SRC.slice(i, i + 1300);
    expect(block).toMatch(/method !== 'PATCH'/);
    expect(block).toMatch(/archived_at = CASE WHEN \$\{archived\} THEN NOW\(\) ELSE NULL END/);
    expect(block).toMatch(/body\.archived !== false/); // default true
    expect(block).toMatch(/AND p\.deleted_at IS NULL/); // can't archive a deleted row
  });
  it('archive handler does not introduce a SELECT...FROM garden_node p block (3-block invariant)', () => {
    const i = SRC.indexOf('if (archiveMatch)');
    const block = SRC.slice(i, i + 900);
    expect(/SELECT[\s\S]*FROM\s+public\.garden_node\s+p\b/.test(block)).toBe(false);
  });
  it('both active-LIST reads exclude archived plantings', () => {
    const m = SRC.match(/AND p\.archived_at IS NULL\n\s*ORDER BY p\.created_at DESC/g) ?? [];
    expect(m.length).toBe(2);
  });
  it('the /seen reward gate excludes archived plantings', () => {
    expect(SRC).toMatch(/ln\.deleted_at IS NULL AND ln\.archived_at IS NULL/);
  });
  it('by-id GET is NOT archived-filtered (archived items still open)', () => {
    // The by-id GET WHERE ends with p.deleted_at + pp.created_by, no archived predicate.
    const i = SRC.indexOf('WHERE p.id = ${plantId}');
    expect(i).toBeGreaterThan(-1);
    const block = SRC.slice(i, i + 160);
    expect(block).not.toMatch(/archived_at/);
  });
});
