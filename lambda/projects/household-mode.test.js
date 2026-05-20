// HOUSEHOLD-MODE static-source guard (projects Lambda).
// Asserts ownership READ/WRITE-guard sites widened to created_by = ANY(${householdIds}),
// INSERT still stamps the real author (${userId}), householdScope is imported, and the
// uploaded_by featured-photo subquery was SWITCHED to created_by. Static-source pattern
// (L-072) — CI-runnable without a DB.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('projects Lambda — Household Mode scope widening', () => {
  it('imports householdScope from ../household.js', () => {
    expect(SRC).toMatch(/import \{ householdScope \} from '\.\.\/household\.js'/);
  });

  it('computes householdIds after the neon() client', () => {
    expect(SRC).toMatch(/const householdIds = householdScope\(userId\)/);
  });

  it('ownership reads/guards use = ANY(${householdIds})', () => {
    // LIST + UPDATE guard + DELETE guard + 3 post-update SELECTs = at least 6 sites,
    // plus the uploaded_by->created_by switch = 7.
    const matches = SRC.match(/created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(7);
  });

  it('42P18 guard: householdIds binds as ONE array param, never spread', () => {
    // The array must NOT be spread into the template (...householdIds) — that would
    // produce N untyped params. ANY(${householdIds}) binds a single array whose type
    // is anchored by the created_by TEXT column.
    expect(SRC).not.toMatch(/ANY\(\$\{\.\.\.householdIds\}\)/);
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });

  it('INSERT still binds created_by = ${userId} (real author, not widened)', () => {
    const insIdx = SRC.indexOf('INSERT INTO plant_projects');
    expect(insIdx).toBeGreaterThan(-1);
    const valuesIdx = SRC.indexOf('VALUES', insIdx);
    const block = SRC.slice(insIdx, valuesIdx + 600);
    expect(block).toMatch(/\$\{userId\}/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('project_types delete guard remains owner-only (out of scope)', () => {
    expect(SRC).toMatch(/UPDATE project_types SET deleted_at = NOW\(\)\s*\n\s*WHERE id = \$\{typeId\} AND created_by = \$\{userId\}/);
  });

  it('admin-override PATCH/GET paths still have NO created_by scope filter', () => {
    // Guarded by admin-patch.test.js; re-assert the widening did not introduce one.
    const patchStart = SRC.indexOf("if (method === 'PATCH')");
    const patchEnd = SRC.indexOf("if (method === 'PUT')", patchStart);
    const patchBlock = SRC.slice(patchStart, patchEnd);
    const updIdx = patchBlock.indexOf('UPDATE plant_projects');
    const retIdx = patchBlock.indexOf('RETURNING', updIdx);
    const upd = patchBlock.slice(updIdx, retIdx);
    expect(upd).not.toMatch(/created_by\s*=\s*\$\{userId\}/);
    expect(upd).not.toMatch(/householdIds/);
  });
});
