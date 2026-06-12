// V3-ARCHIVE-001 regression guard (projects). Static-source per L-072 (DB-free).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('projects Lambda — V3-ARCHIVE-001 archive route + filters', () => {
  it('defines the /archive matcher and PATCH-only handler', () => {
    expect(SRC).toMatch(/archiveMatch = rawPath\.match\(\/\^\\\/api\\\/projects\\\/\(\[\^\/\]\+\)\\\/archive\$\/\)/);
    const i = SRC.indexOf('if (archiveMatch)');
    expect(i).toBeGreaterThan(-1);
    const block = SRC.slice(i, i + 900);
    expect(block).toMatch(/method !== 'PATCH'/);
    expect(block).toMatch(/archived_at = CASE WHEN \$\{archived\} THEN NOW\(\) ELSE NULL END/);
    expect(block).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
  });
  it('active-LIST variants + plant_count exclude archived (4 deleted+archived pairs)', () => {
    // 3 list variants (all / parent=null / parent=X) + the by-id plant_count subquery.
    const m = SRC.match(/AND deleted_at IS NULL\n\s*AND archived_at IS NULL/g) ?? [];
    expect(m.length).toBe(4);
  });
  it('by-id GET exposes archived_at (drives inline unarchive state)', () => {
    expect(SRC).toMatch(/pp\.kind_set_at, pp\.archived_at,/);
  });
  it('by-id plant_count excludes archived plantings (count matches filtered list)', () => {
    const i = SRC.indexOf('FROM garden_node');
    const block = SRC.slice(i, i + 160);
    expect(block).toMatch(/container_id = \$\{projectId\}[\s\S]*deleted_at IS NULL[\s\S]*archived_at IS NULL/);
  });
});
