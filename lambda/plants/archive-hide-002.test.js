// BUG-ARCHIVEHIDE-002 (audit I17) — GET /api/plants, the wide default list, must not return a live
// planting whose CONTAINER is archived. The grid and picker branches have filtered it since
// BUG-PLANTSLISTARCHIVEDCONTAINER-001; the default list is read by a dozen client surfaces (Today's
// care, heads-up and protect cards, Findings, Favorites, CaptureFlow, Search, PlantsCatchUp), and it
// did not. Archiving a container does NOT cascade to its plantings (lambda/projects' archive PATCH
// writes the container's own column only), so the container clause is the only thing that hides them.
//
// THE EXEMPTION is pinned with the filter: GET /api/plants?project_id= names one container and is that
// container's own page (ProjectDetail renders an archived container with its Unarchive button, and
// lambda/projects' by-id plant_count applies no container-archive filter). Adding the clause there
// would blank the page under the button that brings it back.
//
// Static-source (L-072), DB-free. Behaviour on real rows: tests/integration/archive-hide-002.int.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

function between(src, start, end) {
  const i = src.indexOf(start);
  expect(i, `start marker not found — update this anchor: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `end marker not found — update this anchor: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
}

// The four GET-list branches, in declaration order: grid, picker, ?project_id, default.
const LIST = () => between(SRC, "const rows = view === 'grid'", "const enriched = await Promise.all(rows.map(");
const projectBranch = () => between(LIST(), ': projectId', ': await sql`');
const defaultBranch = () => LIST().slice(LIST().lastIndexOf(': await sql`'));

describe('plants Lambda — BUG-ARCHIVEHIDE-002 I17, the default list', () => {
  // MUTATION: delete `AND pp.archived_at IS NULL` from the default branch -> RED.
  it('filters plantings in an ARCHIVED container', () => {
    expect(defaultBranch()).toMatch(/AND pp\.archived_at IS NULL/);
  });

  // The container join stays LEFT, so the clause is NULL-safe for a project-less planting. An INNER
  // join would drop every CaptureFlow planting with no container.
  it('keeps the container join LEFT (project-less plantings stay listed)', () => {
    expect(defaultBranch()).toMatch(/LEFT JOIN public\.container pp ON pp\.id = p\.container_id/);
    expect(defaultBranch()).toMatch(/OR \(p\.container_id IS NULL AND p\.created_by = ANY/);
  });

  it('keeps the planting archive and both soft-delete predicates beside it', () => {
    const q = defaultBranch();
    expect(q).toMatch(/AND p\.archived_at IS NULL/);
    expect(q).toMatch(/AND p\.deleted_at IS NULL/);
    expect(q).toMatch(/pp\.deleted_at IS NULL/);
  });
});

describe('plants Lambda — BUG-ARCHIVEHIDE-002 I17, the ?project_id exemption', () => {
  // MUTATION: add the clause to the ?project_id branch -> RED.
  it('the ?project_id list does NOT filter on the container archive (it is that container\'s own page)', () => {
    expect(projectBranch()).not.toMatch(/pp\.archived_at/);
  });

  it('the ?project_id list still filters the planting archive and the deleted container', () => {
    const q = projectBranch();
    expect(q).toMatch(/AND p\.archived_at IS NULL/);
    expect(q).toMatch(/AND pp\.deleted_at IS NULL/);
  });
});
