// V4-CAPTURE-002 static-source guard (tags Lambda bulk entity-tags).
// The whole-garden bulk map (GARDENIA group-by) must include project-less plantings so their
// derived type:/lifecycle: tags project into the by-type view. Both bulk queries LEFT JOIN the
// container and rescope null-container rows by the planting's own created_by. Static-source, DB-free.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('tags Lambda — bulk entity-tags include project-less plantings (V4-CAPTURE-002)', () => {
  it('both bulk queries LEFT JOIN the container', () => {
    const matches = SRC.match(/LEFT JOIN public\.container pp ON pp\.id = gn\.container_id/g) ?? [];
    expect(matches.length).toBe(2); // directRows + projRows
  });

  it('rescopes null-container plantings by their own created_by', () => {
    const matches = SRC.match(/gn\.container_id IS NULL AND gn\.created_by = ANY\(\$\{household\}\)/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('still scopes container-owned rows by the project owner', () => {
    expect(SRC).toMatch(/pp\.created_by = ANY\(\$\{household\}\)/);
  });
});
