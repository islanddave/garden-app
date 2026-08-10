// V4-PHOTOLOCFIND-001 static-source guard (photos Lambda) — space-scoped gallery fetch.
// ?location_id=<spaceId> must return photos attached to that space OR any descendant space via the
// same recursive parent_id walk the events By-Space filter uses (V4-LOGMANYLOC-001), household-scoped,
// soft-delete-aware. It is a CONTAINER-style filter like ?project_id — NOT an attachment source for
// planting galleries (the Dave 2026-07-09 ?attachedTo rule is unchanged). Static-source (L-072), DB-free.

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

describe('photos Lambda — V4-PHOTOLOCFIND-001 space-scoped gallery', () => {
  it('reads the location_id query param', () => {
    expect(SRC).toMatch(/const locationId = event\.queryStringParameters\?\.location_id \?\? null/);
  });

  it('branches after attachedTo and before project_id (attachment scope keeps precedence)', () => {
    const iAttached = SRC.indexOf('if (attachedTo)');
    const iLocation = SRC.indexOf('} else if (locationId) {');
    const iProject = SRC.indexOf('} else if (projectId) {');
    expect(iAttached).toBeGreaterThan(-1);
    expect(iLocation).toBeGreaterThan(iAttached);
    expect(iProject).toBeGreaterThan(iLocation);
  });

  it('walks the location subtree recursively (descendant spaces included, soft-deleted excluded)', () => {
    const iLocation = SRC.indexOf('} else if (locationId) {');
    const block = SRC.slice(iLocation, iLocation + 1200);
    expect(block).toMatch(/WITH RECURSIVE loc_subtree AS \(/);
    expect(block).toMatch(/SELECT id FROM locations WHERE id = \$\{locationId\} AND deleted_at IS NULL/);
    expect(block).toMatch(/JOIN loc_subtree st ON l\.parent_id = st\.id/);
    expect(block).toMatch(/p\.location_id IN \(/);
  });

  it('is household-scoped and excludes soft-deleted photos', () => {
    const iLocation = SRC.indexOf('} else if (locationId) {');
    const block = SRC.slice(iLocation, iLocation + 1200);
    expect(block).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    expect(block).toMatch(/p\.deleted_at IS NULL/);
  });

  it('does NOT touch the attachedTo union (location_id stays out of planting-gallery membership)', () => {
    const iAttached = SRC.indexOf('if (attachedTo)');
    const iEnd = SRC.indexOf('} else if (locationId) {');
    const attachedBlock = SRC.slice(iAttached, iEnd);
    expect(attachedBlock).not.toMatch(/loc_subtree/);
    expect(attachedBlock).not.toMatch(/p\.location_id = /);
  });
});
