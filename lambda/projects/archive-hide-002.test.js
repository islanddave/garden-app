// BUG-ARCHIVEHIDE-002 — two lambda/projects reads from the 2026-10-14 Lambda audit.
//
// I37: the share route's public timeline (/api/projects/public/:slug) listed public events of
// ARCHIVED plantings — 1,684 of them on prod, 2026-10-15 — while the project's own event_count
// already hid them. The timeline now carries the same planting anti-join.
//
// I36 (Dave, AskUserQuestion, first-hand, 2026-10-15: "Household only"): GET /api/projects/types
// returned every user's custom types plus each creator's Clerk sub to any signed-in user. Built-in
// types (created_by NULL) stay shared; a user-made type reaches only its creator's household, and no
// row carries created_by. The DELETE route stays owner-only (household-mode.test.js pins it).
//
// Static-source (L-072), DB-free; real rows in tests/integration/archive-hide-002.int.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

function between(start, end) {
  const i = SRC.indexOf(start);
  expect(i, `start marker not found — update this anchor: ${start}`).toBeGreaterThan(-1);
  const j = SRC.indexOf(end, i + start.length);
  expect(j, `end marker not found — update this anchor: ${end}`).toBeGreaterThan(-1);
  return SRC.slice(i, j);
}

const timeline = () => between('SELECT id, event_type, event_date, notes, quantity', 'LIMIT 200');
const typesGet = () => between('if (typesMatch) {', "if (method === 'POST')");
const typesPost = () => between('INSERT INTO project_types', 'return resp(201');

describe('projects — BUG-ARCHIVEHIDE-002 I37, the public timeline', () => {
  // MUTATION: delete the NOT EXISTS -> RED.
  it('does not list public events of ARCHIVED plantings', () => {
    expect(timeline()).toMatch(
      /AND NOT EXISTS \(SELECT 1 FROM public\.garden_node ga\s+WHERE ga\.id = event_log\.plant_id AND ga\.archived_at IS NOT NULL\)/);
  });
  // The deny-by-default row gate the anti-join sits beside: dropping it publishes private notes.
  it('keeps the is_public row gate and the soft-delete predicate', () => {
    expect(timeline()).toMatch(/AND is_public IS TRUE/);
    expect(timeline()).toMatch(/AND deleted_at IS NULL/);
  });
});

describe('projects — I36, GET /api/projects/types is household-only', () => {
  // MUTATION: drop the household arm -> RED (every user's custom types come back).
  it('lists built-in types and the household\'s own types only', () => {
    expect(typesGet()).toMatch(/AND \(created_by IS NULL OR created_by = ANY\(\$\{householdIds\}\)\)/);
  });
  // MUTATION: put created_by back in the projection -> RED.
  it('does not return created_by, on GET or on POST', () => {
    const projection = typesGet().slice(0, typesGet().indexOf('FROM project_types'));
    expect(projection).not.toMatch(/\bcreated_by\s*,|\bcreated_by\s*$/m);
    expect(projection).not.toMatch(/SELECT \*/);
    expect(typesPost()).not.toMatch(/RETURNING \*/);
    expect(typesPost().slice(typesPost().indexOf('RETURNING'))).not.toMatch(/\bcreated_by\b/);
  });
  it('says is_system and is_own instead, is_own being the caller (not the household)', () => {
    expect(typesGet()).toMatch(/\(created_by IS NULL\) AS is_system/);
    expect(typesGet()).toMatch(/\(created_by IS NOT NULL AND created_by = \$\{userId\}\) AS is_own/);
    expect(typesPost()).toMatch(/false AS is_system, true AS is_own/);
  });
});
