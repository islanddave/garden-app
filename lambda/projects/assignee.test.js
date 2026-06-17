// PLANT-ASSIGN-001 — static-source guard for assignee_user_id write->read symmetry in the projects Lambda.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('projects assignee_user_id (PLANT-ASSIGN-001)', () => {
  it('PUT can set AND unset via presence-sentinel CASE', () => {
    expect(SRC).toMatch(/const hasAssignee = Object\.prototype\.hasOwnProperty\.call\(body, 'assignee_user_id'\)/);
    expect(SRC).toMatch(/assignee_user_id = CASE/);
    expect(SRC).toMatch(/WHEN \$\{hasAssignee\} THEN \$\{body\.assignee_user_id \?\? null\}/);
  });
  it('is exposed by the GET SELECTs + PUT RETURNING (by-id pp. + list blocks)', () => {
    expect(SRC).toMatch(/pp\.assignee_user_id/);          // by-id
    const n = (SRC.match(/assignee_user_id/g) || []).length;
    expect(n).toBeGreaterThanOrEqual(6);
  });
});
