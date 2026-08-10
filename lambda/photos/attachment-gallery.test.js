// V4-PHOTOGALLERY-001 static-source guard (photos Lambda) — attachment-scoped gallery fetch.
// The per-planting gallery must include EVERY photo attached to the planting by ANY source:
// directly via photos.plant_id, OR through one of its events (photos.event_id -> event_log.plant_id),
// regardless of which container the photo sits in. This replaces the ?project_id container-scoped
// fetch that hid plant_id-attached photos living in a parent/sibling container. Static-source (L-072),
// DB-free: asserts the SQL text, not runtime behavior.

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

describe('photos Lambda — V4-PHOTOGALLERY-001 attachment-scoped gallery', () => {
  it('reads the attachedTo query param', () => {
    expect(SRC).toMatch(/const attachedTo = event\.queryStringParameters\?\.attachedTo \?\? null/);
  });

  it('branches on attachedTo BEFORE project_id (attachment scope takes precedence)', () => {
    const iAttached = SRC.indexOf('if (attachedTo)');
    const iProject = SRC.indexOf('} else if (projectId) {');
    expect(iAttached).toBeGreaterThan(-1);
    expect(iProject).toBeGreaterThan(iAttached);
  });

  it('unions plant_id = attachedTo OR an event-of-the-planting', () => {
    // direct plant_id attachment
    expect(SRC).toMatch(/p\.plant_id = \$\{attachedTo\}/);
    // event attachment via event_log.plant_id
    expect(SRC).toMatch(/p\.event_id IN \(\s*SELECT e\.id FROM public\.event_log e/);
    expect(SRC).toMatch(/WHERE e\.plant_id = \$\{attachedTo\} AND e\.deleted_at IS NULL/);
  });

  it('is household-scoped and excludes soft-deleted photos', () => {
    // The attachment branch must scope to the household and drop soft-deleted rows.
    const iAttached = SRC.indexOf('if (attachedTo)');
    const block = SRC.slice(iAttached, iAttached + 900);
    expect(block).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    expect(block).toMatch(/AND p\.deleted_at IS NULL/);
  });

  it('does NOT overload ?project_id — the project (container) branch is still present and distinct', () => {
    // project scope remains: WHERE ... AND p.project_id = ${projectId}
    expect(SRC).toMatch(/AND p\.project_id = \$\{projectId\}/);
  });

  it('no array spread on householdIds in the attachment branch (42P18 guard)', () => {
    const iAttached = SRC.indexOf('if (attachedTo)');
    const block = SRC.slice(iAttached, iAttached + 900);
    expect(block).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});
