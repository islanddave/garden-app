// V4-CAPTURE-002 static-source guard (plants Lambda list query).
// Project-less plantings (container_id NULL — photo-first capture) must survive the list query.
// The container join is a LEFT JOIN and ownership is scoped by the parent project OR, for
// project-less rows, by the planting's own created_by. Static-source (L-072), DB-free.
import { describe, it, expect } from 'vitest';
import { decommentSqlDashSpace, readHandlerSource } from '../_test-stubs/handlerSource.js';

// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.

const SRC = readHandlerSource('plants', { decomment: decommentSqlDashSpace });

describe('plants Lambda — project-less plantings surface in the list (V4-CAPTURE-002)', () => {
  it('list query LEFT JOINs the container (no longer drops null container_id)', () => {
    expect(SRC).toMatch(/LEFT JOIN public\.container pp ON pp\.id = p\.container_id/);
  });

  it('rescopes ownership to include project-less rows by their own created_by', () => {
    expect(SRC).toMatch(/p\.container_id IS NULL AND p\.created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('still scopes projected rows by the parent project owner', () => {
    expect(SRC).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
  });
});
