// V1.2a-4 S6 (PROJ-RESCOPE) static-source regression guard for the admin
// classify route added to lambda/projects/index.js.
//
// Static-source pattern (L-072 fallback). The Lambda handler is wrapped in
// AWS Secrets Manager / Clerk verifyToken / Neon HTTP calls that are hard to
// exercise end-to-end without a deployed env, so this test inspects the
// source text itself to assert the structural invariants of the PATCH branch
// and the GET ?admin=1 extension per design V001 §5.1 + §5.4.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('projects Lambda admin PATCH route (S6 static-source guard)', () => {
  it('declares a PATCH branch inside the idMatch block', () => {
    expect(SRC).toMatch(/if \(method === 'PATCH'\)/);
  });

  it('reads ADMIN_CLERK_SUBS from process.env', () => {
    expect(SRC).toMatch(/process\.env\.ADMIN_CLERK_SUBS/);
  });

  it('fails closed when ADMIN_CLERK_SUBS is empty (returns 403)', () => {
    const m = SRC.match(/ADMIN_CLERK_SUBS\.length === 0[\s\S]{0,200}/);
    expect(m, 'expected fail-closed length-zero branch').toBeTruthy();
    expect(m[0]).toMatch(/403/);
    expect(m[0]).toMatch(/Admin route not configured/);
  });

  it('rejects non-allowlisted callers (returns 403)', () => {
    const m = SRC.match(/!ADMIN_CLERK_SUBS\.includes\(userId\)[\s\S]{0,160}/);
    expect(m, 'expected allowlist includes check').toBeTruthy();
    expect(m[0]).toMatch(/403/);
  });

  it('validates kind against the canonical ALLOWED_KINDS list', () => {
    expect(SRC).toMatch(/ALLOWED_KINDS\s*=\s*\['campaign',\s*'category',\s*'cultivar'\]/);
  });

  it('rejects self-reference (parent_project_id === projectId)', () => {
    // Two anchors expected (PATCH + PUT); the PATCH branch must include one.
    const matches = SRC.match(/parent_project_id === projectId/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('rejects empty PATCH body (no kind, no parent)', () => {
    expect(SRC).toMatch(/PATCH body must include kind and\/or parent_project_id/);
  });

  it('audit INSERT precedes UPDATE in a single CTE (atomic)', () => {
    // Locate the PATCH branch and assert the audit CTE structure.
    const patchStart = SRC.indexOf("if (method === 'PATCH')");
    const patchEnd = SRC.indexOf("if (method === 'PUT')", patchStart);
    expect(patchStart).toBeGreaterThan(-1);
    expect(patchEnd).toBeGreaterThan(patchStart);
    const patchBlock = SRC.slice(patchStart, patchEnd);
    // CTE shape: WITH pre AS (SELECT ...), audit AS (INSERT ...) UPDATE ...
    expect(patchBlock).toMatch(/WITH pre AS \(/);
    expect(patchBlock).toMatch(/audit AS \(\s*INSERT INTO proj_rescope_events/);
    expect(patchBlock).toMatch(/'admin_classify'/);
    // UPDATE comes after audit in the CTE
    const auditIdx = patchBlock.indexOf('audit AS (');
    const updateIdx = patchBlock.indexOf('UPDATE plant_projects', auditIdx);
    expect(updateIdx).toBeGreaterThan(auditIdx);
  });

  it('PATCH UPDATE does NOT filter by created_by (admin overrides ownership)', () => {
    const patchStart = SRC.indexOf("if (method === 'PATCH')");
    const patchEnd = SRC.indexOf("if (method === 'PUT')", patchStart);
    const patchBlock = SRC.slice(patchStart, patchEnd);
    const updateIdx = patchBlock.indexOf('UPDATE plant_projects');
    const returningIdx = patchBlock.indexOf('RETURNING', updateIdx);
    const updateSlice = patchBlock.slice(updateIdx, returningIdx);
    // No `created_by = ${userId}` clause inside the UPDATE WHERE
    expect(updateSlice).not.toMatch(/created_by\s*=\s*\$\{userId\}/);
    // Must still respect soft-delete
    expect(updateSlice).toMatch(/deleted_at IS NULL/);
  });

  it('PATCH stamps kind_set_at when kind transitions NULL -> non-NULL', () => {
    const patchStart = SRC.indexOf("if (method === 'PATCH')");
    const patchEnd = SRC.indexOf("if (method === 'PUT')", patchStart);
    const patchBlock = SRC.slice(patchStart, patchEnd);
    expect(patchBlock).toMatch(/kind_set_at = CASE/);
    expect(patchBlock).toMatch(/NOT NULL AND kind IS NULL THEN NOW\(\)/);
  });
});

describe('projects Lambda admin GET extension (S6 ?admin=1 guard)', () => {
  it('checks qs.admin === \'1\' inside the list GET handler', () => {
    expect(SRC).toMatch(/qs\.admin === '1'/);
  });

  it('admin GET fails closed when ADMIN_CLERK_SUBS is empty', () => {
    // Both branches (PATCH + admin GET) check length === 0 -> 403
    const matches = SRC.match(/ADMIN_CLERK_SUBS\.length === 0/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('admin GET returns ALL alive rows (no created_by filter)', () => {
    const adminStart = SRC.indexOf('const adminMode = qs.admin');
    const adminEnd = SRC.indexOf('// Optional filter: ?parent_id', adminStart);
    expect(adminStart).toBeGreaterThan(-1);
    expect(adminEnd).toBeGreaterThan(adminStart);
    const adminBlock = SRC.slice(adminStart, adminEnd);
    // SELECT FROM plant_projects WHERE deleted_at IS NULL — no created_by filter
    expect(adminBlock).toMatch(/FROM plant_projects\s+WHERE deleted_at IS NULL/);
    expect(adminBlock).not.toMatch(/created_by\s*=\s*\$\{userId\}/);
  });

  it('admin GET response includes PROJ-RESCOPE columns kind + target_end_date + kind_set_at', () => {
    const adminStart = SRC.indexOf('const adminMode = qs.admin');
    const adminEnd = SRC.indexOf('// Optional filter: ?parent_id', adminStart);
    const adminBlock = SRC.slice(adminStart, adminEnd);
    for (const col of ['kind', 'target_end_date', 'kind_set_at']) {
      expect(adminBlock, `admin GET SELECT missing ${col}`).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });
});
