// V3-REPARENT-001 regression guard (projects). Static-source per L-072 (DB-free).
// Runtime correctness (move/closure/cycle/dedup/version/restore) is proven separately
// against a Neon COW branch in the build session; this pins the wiring against drift.
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

describe('projects Lambda — V3-REPARENT-001 reparent + restore', () => {
  it('defines the /reparent and /reparent/restore matchers (extra segment, before idMatch)', () => {
    expect(SRC).toMatch(/reparentMatch = rawPath\.match\(\/\^\\\/api\\\/projects\\\/\(\[\^\/\]\+\)\\\/reparent\$\/\)/);
    expect(SRC).toMatch(/reparentRestoreMatch = rawPath\.match\(\/\^\\\/api\\\/projects\\\/\(\[\^\/\]\+\)\\\/reparent\\\/restore\$\/\)/);
    const idi = SRC.indexOf('const idMatch =');
    expect(SRC.indexOf('reparentMatch =')).toBeGreaterThan(-1);
    // restore handler must be checked before the bare reparent handler
    expect(SRC.indexOf('if (reparentRestoreMatch)')).toBeLessThan(SRC.indexOf('if (reparentMatch)'));
    // both handlers must run before the by-id block
    // The by-id block is delimited by a COMMENT banner, so this ordering check reads RAW offsets
    // (mixing RAW and decommented offsets would compare positions in two different strings).
    expect(RAW.indexOf('// --- /api/projects/:id ---')).toBeGreaterThan(-1);
    expect(RAW.indexOf('if (reparentMatch)')).toBeLessThan(RAW.indexOf('// --- /api/projects/:id ---'));
    expect(idi).toBeGreaterThan(-1);
  });

  it('reparent handler is POST-only and requires op_id + numeric expected_version', () => {
    const i = SRC.indexOf('if (reparentMatch)');
    const block = SRC.slice(i, i + 900);
    expect(block).toMatch(/method !== 'POST'/);
    expect(block).toMatch(/op_id is required/);
    expect(block).toMatch(/typeof body\.expected_version !== 'number'/);
    expect(block).toMatch(/new_parent_id \?\? null/); // null = move to root
  });

  it('restore handler resolves old_parent_id from the source reparent_event', () => {
    const i = SRC.indexOf('if (reparentRestoreMatch)');
    const block = SRC.slice(i, i + 1100);
    expect(block).toMatch(/source_op_id is required/);
    expect(block).toMatch(/SELECT old_parent_id FROM reparent_event/);
    expect(block).toMatch(/newParentId: src\[0\]\.old_parent_id/);
  });

  it('core is idempotent (op_id replay), version-guarded, snapshot-writing, cycle-aware', () => {
    const i = SRC.indexOf('export async function reparentCore');
    const block = SRC.slice(i);
    // idempotent replay short-circuit before any write
    expect(block).toMatch(/SELECT subject_id, new_parent_id, moved_at FROM reparent_event WHERE op_id = \$\{opId\}/);
    expect(block).toMatch(/replayed: true/);
    // optimistic concurrency
    expect(block).toMatch(/Version conflict/);
    expect(block).toMatch(/current_version/);
    // atomic CTE: snapshot -> event -> version-bumped update
    expect(block).toMatch(/INSERT INTO reparent_event/);
    expect(block).toMatch(/jsonb_build_object/);
    expect(block).toMatch(/version = version \+ 1/);
    expect(block).toMatch(/AND version = \$\{expectedVersion\}/);
    // trigger raises on cycle -> mapped to 422
    expect(block).toMatch(/cycle/i);
    expect(block).toMatch(/status: 422/);
    // op_id unique race -> replay, FK miss -> 422
    expect(block).toMatch(/reparent_op_uniq\|duplicate key/);
  });

  it('writes the base table plant_projects so the closure/acyclicity trigger fires', () => {
    const i = SRC.indexOf('export async function reparentCore');
    const block = SRC.slice(i);
    expect(block).toMatch(/UPDATE plant_projects/);
    expect(block).toMatch(/SET parent_project_id = \$\{newParentId\}/);
    // subject enum cast for the event row
    expect(block).toMatch(/'container'::node_class/);
  });
});
