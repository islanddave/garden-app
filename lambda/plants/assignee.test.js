// PLANT-ASSIGN-001 — static-source guard for assignee_user_id write->read symmetry in the plants Lambda.
// Mirrors select-columns.test.js (index.js imports @neondatabase/serverless etc. at module load).
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

describe('plants assignee_user_id (PLANT-ASSIGN-001)', () => {
  it('PUT can set AND unset via presence-sentinel CASE', () => {
    expect(SRC).toMatch(/const hasAssignee = Object\.prototype\.hasOwnProperty\.call\(body, 'assignee_user_id'\)/);
    expect(SRC).toMatch(/assignee_user_id\s+= CASE/);
    expect(SRC).toMatch(/WHEN \$\{hasAssignee\} THEN \$\{body\.assignee_user_id \?\? null\}/);
  });
  it('is returned by the 3 GET SELECTs + PUT RETURNING (>=4 reads of p.assignee_user_id)', () => {
    const n = (SRC.match(/p\.assignee_user_id/g) || []).length;
    expect(n).toBeGreaterThanOrEqual(4);
  });
});
