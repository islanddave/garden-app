// BUG-FINDINGSDORMANT-001 — /api/findings must not suggest care on non-actionable plantings.
//
// Dave, 2026-08-10: dormant stock is in temp/humidity-controlled bins and "never need that treatment".
//
// THE DEFECT. The planting join carried NO status gate at all — `JOIN garden_node p ON p.id = e.plant_id
// AND p.deleted_at IS NULL` and nothing else. Findings render care copy ("likely needs water", "is
// likely due for feeding", "may need attention") with a Treated action, under an empty state that says
// "Nothing needs attention right now" — and unresolved findings never age out, so a non-actionable
// planting sat there suggesting treatment indefinitely.
//
// NOT THEORETICAL when written. Measured on prod 2026-08-10: 0 dormant rows, but SEVEN `failed` rows
// were leaking — dead tissue being asked for water. `harvested` (7 rows) is deliberately NOT excluded:
// a harvested plant still needs water (Dave, 2026-06-22), and the sibling surfaces agree.
//
// Source-text guard: a lambda test must never import this handler's index.js — each Lambda is zipped
// per-directory with its own package.json and CI installs the ROOT manifest only, so an import that
// resolves on a dev machine CANNOT resolve in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// Comment-strip first: this file's own header names the predicate, and a raw-text guard that matched
// prose would pass over deleted code left in a comment.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(l => l.replace(/(^|[^:])--.*$/, '$1'))     // SQL comments, keeping `https://` safe
  .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

describe('BUG-FINDINGSDORMANT-001 — findings exclude non-actionable plantings', () => {
  it('gates the planting status', () => {
    expect(CODE).toMatch(/p\.status\s+NOT\s+IN\s*\(/i);
  });

  it('excludes the full non-actionable set used by every sibling care surface', () => {
    const m = CODE.match(/p\.status\s+NOT\s+IN\s*\(([^)]*)\)/i);
    expect(m).toBeTruthy();
    for (const s of ['dormant', 'ended', 'failed', 'rooting']) {
      expect(m[1]).toMatch(new RegExp(`'${s}'`));
    }
  });

  it("does NOT exclude 'harvested' — a harvested plant still needs care (Dave 2026-06-22)", () => {
    const m = CODE.match(/p\.status\s+NOT\s+IN\s*\(([^)]*)\)/i);
    expect(m[1]).not.toMatch(/harvested/);
  });

  it('stays fail-open on a NULL status, matching the siblings', () => {
    // A planting with no status recorded is still actionable everywhere else in the codebase;
    // silently dropping it here would hide real issues rather than hide noise.
    expect(CODE).toMatch(/p\.status\s+IS\s+NULL\s+OR\s+p\.status\s+NOT\s+IN/i);
  });
});
