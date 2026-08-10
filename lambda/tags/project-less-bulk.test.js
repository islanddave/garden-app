// V4-CAPTURE-002 static-source guard (tags Lambda bulk entity-tags).
// The whole-garden bulk map (GARDENIA group-by) must include project-less plantings so their
// derived type:/lifecycle: tags project into the by-type view. Both bulk queries LEFT JOIN the
// container and rescope null-container rows by the planting's own created_by. Static-source, DB-free.
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

describe('tags Lambda — bulk entity-tags include project-less plantings (V4-CAPTURE-002)', () => {
  it('both bulk queries LEFT JOIN the container', () => {
    const matches = SRC.match(/LEFT JOIN public\.container pp ON pp\.id = gn\.container_id/g) ?? [];
    expect(matches.length).toBe(3); // entityExists plant arm + directRows + projRows
  });

  it('rescopes null-container plantings by their own created_by', () => {
    const matches = SRC.match(/gn\.container_id IS NULL AND gn\.created_by = ANY\(\$\{household\}\)/g) ?? [];
    expect(matches.length).toBe(3); // entityExists plant arm + directRows + projRows
  });

  it('still scopes container-owned rows by the project owner', () => {
    expect(SRC).toMatch(/pp\.created_by = ANY\(\$\{household\}\)/);
  });
});
