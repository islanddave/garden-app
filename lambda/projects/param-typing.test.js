// L-086 regression guard — Postgres 42P18 "could not determine data type of parameter".
//
// Root cause (prod incident 2026-05-19, project edit/rename returned 500): the PUT
// and S6 admin PATCH UPDATE statements stamped kind_set_at with
//   WHEN ${hasKind} AND ${body.kind ?? null} IS NOT NULL AND kind IS NULL THEN NOW()
// The second `${body.kind ?? null}` is a tagged-template parameter ($15 in the PUT)
// whose ONLY appearance is `$n IS NOT NULL`. `IS NOT NULL` accepts any type, so
// Postgres cannot infer the parameter's type at PARSE time and rejects the whole
// statement with SQLSTATE 42P18 — before any values are bound. Because it fails at
// parse, it broke EVERY PUT (and PATCH) regardless of request body.
//
// Fix: compute the boolean in JS (`${hasKind && body.kind != null}`) so the WHEN
// operand is a typed boolean and no untyped parameter reaches the planner.
//
// This guard asserts the dangerous shape never reappears in any plant_projects
// write in this handler. Static-source pattern (L-072) — CI-runnable without a DB.

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

describe('projects Lambda parameter typing (L-086 / 42P18 guard)', () => {
  it('no tagged-template parameter is used solely in `IS NOT NULL`', () => {
    // Matches `${ ... }` immediately followed by IS NOT NULL — the exact
    // type-indeterminate shape that triggered 42P18.
    const dangerous = /\$\{[^}]*\}\s+IS\s+NOT\s+NULL/i;
    const m = SRC.match(dangerous);
    expect(
      m,
      m ? `Type-indeterminate parameter (42P18 risk) found: "${m[0]}". ` +
          `Compute the boolean in JS instead, e.g. \${hasKind && body.kind != null}.`
        : undefined,
    ).toBeNull();
  });

  it('the stale buggy expression `${body.kind ?? null} IS NOT NULL` is absent', () => {
    expect(SRC.includes('${body.kind ?? null} IS NOT NULL')).toBe(false);
  });

  it('both kind_set_at CASE branches use the JS-computed boolean operand', () => {
    const matches = SRC.match(/WHEN \$\{hasKind && body\.kind != null\} AND classification IS NULL THEN NOW\(\)/g);
    // One in the PUT branch, one in the S6 admin PATCH branch.
    expect(matches?.length ?? 0).toBe(2);
  });
});
