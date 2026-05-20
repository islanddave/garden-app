import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guard against the L-086-class bug: a JS `//` comment placed INSIDE a sql`...`
// tagged template ships literal `//` to Postgres (SQL line comments are `--`),
// 500-ing at runtime while vitest/vite stay green (static + mock never hit a real DB).
// Caught in household-mode review 2026-05-20 (inventory-items UPDATE SET block).
const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  'projects/index.js', 'plants/index.js', 'events/index.js',
  'inventory-items/index.js', 'photos/index.js', 'dashboard/handlers.js',
];

// Match REAL tagged templates only: `sql` as an identifier (not preceded by a word
// char or a backtick — the latter excludes prose like "calls `sql`..." in JS comments)
// immediately followed by a backtick. Body is a non-backtick run (templates never
// contain a literal backtick). Then keep only bodies that actually look like SQL.
function sqlTemplates(src) {
  const out = [];
  const re = /(?<![\w`])sql`([^`]*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[1];
    if (/\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(body)) out.push(body);
  }
  return out;
}

describe('SQL template comment hygiene', () => {
  for (const rel of FILES) {
    it(`${rel}: no '//' inside any sql\`...\` template`, () => {
      const src = readFileSync(join(here, rel), 'utf-8');
      const offenders = sqlTemplates(src).filter((t) => t.includes('//'));
      expect(offenders, `'//' found inside a SQL template in ${rel} (use '--' for SQL comments, or move the comment to JS scope)`).toEqual([]);
    });
  }
});
