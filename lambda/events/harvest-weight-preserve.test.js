// BUG-HARVWEIGHTBLANK-001 — the harvest PUT's weight-preserve CASE guards and its carry-forward
// subquery must name ONE weight-unit set, or one path resurrects a weight the other just dropped.
// The guard's behaviour is proven on real Postgres in tests/integration/events.int.test.js
// (PUT /api/events/:id — BUG-HARVESTEDIT-001). Those fixtures only use 'lb' as the old unit, so this
// copies-must-match check is the only guard against g/kg/oz drifting between the lists.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'));

// The harvest EDIT update, isolated so these assertions cannot accidentally match the INSERT path
// or the batch-undo soft-delete. There is more than one `UPDATE harvest_log h` in this file — the
// batch-undo one appears FIRST — so anchor on the statement that actually sets the weight columns.
const UPDATE = (() => {
  let from = 0;
  for (;;) {
    const start = SRC.indexOf('UPDATE harvest_log h', from);
    expect(start, 'no UPDATE harvest_log statement sets weight_basis').toBeGreaterThan(-1);
    const end = SRC.indexOf('RETURNING', start);
    const stmt = SRC.slice(start, end === -1 ? start + 4000 : end);
    if (stmt.includes('weight_basis')) return stmt;
    from = start + 1;
  }
})();

describe('harvest PUT preserves a stored weight the resolver can no longer price', () => {
  it('the outer guard and the carry-forward subquery use the same weight-unit set', () => {
    const units = [...UPDATE.matchAll(/unit NOT IN \(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ''));
    expect(units.length, 'expected the outer guard(s) AND the carry-forward test').toBeGreaterThan(1);
    expect(new Set(units).size).toBe(1);
  });
});
