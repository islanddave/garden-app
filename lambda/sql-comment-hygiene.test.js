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
  'harvests/index.js', 'facebook-share/index.js',
  'varieties/index.js', // V4-VARIETYHOUSEHOLD-001 — added when its write predicates gained a household arm
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

// The sibling hazard, and a nastier one: a template placeholder inside a `--` SQL comment.
//
// The `--` makes it a comment to POSTGRES, but the template literal is evaluated by JAVASCRIPT
// first — so the placeholder still interpolates. Write a now-deleted binding's name in a comment
// explaining why you deleted it and you get ReferenceError at runtime, on every request down that
// path. Hit live 2026-08-07 while removing `movedType` for BUG-CACHEGATE-001: the explanatory
// comment named the very binding it had just removed.
//
// Nothing else catches it. `node --check` is a syntax check and does not resolve scope; ESLint is
// configured without no-undef here (verified — reintroducing the fault produced zero lint output);
// and every static-source test reads the file as TEXT, so the placeholder is just characters to
// them. Only actually executing the route fails, which means CI integration tests or prod.
//
// A placeholder in a comment is never load-bearing, so this bans the shape outright rather than
// trying to decide which identifiers are still in scope.
describe('SQL template placeholder hygiene', () => {
  for (const rel of FILES) {
    it(`${rel}: no template placeholder inside a '--' SQL comment`, () => {
      const src = readFileSync(join(here, rel), 'utf-8');
      const offenders = [];
      for (const t of sqlTemplates(src)) {
        for (const line of t.split('\n')) {
          const c = line.indexOf('--');
          if (c === -1) continue;
          // Only the comment tail. A placeholder BEFORE the `--` on the same line is real SQL.
          if (/\$\{/.test(line.slice(c))) offenders.push(line.trim());
        }
      }
      expect(offenders,
        `a template placeholder appears inside a '--' comment in ${rel}. Postgres ignores the ` +
        'comment but JavaScript still interpolates it, so a stale or deleted binding throws ' +
        'ReferenceError at runtime while every static check stays green. Describe the binding in ' +
        'prose instead of reproducing its placeholder.').toEqual([]);
    });
  }
});
