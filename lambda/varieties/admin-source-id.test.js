// V1.2a-4 S6 (PROJ-RESCOPE) static-source guard for the varieties Lambda
// source_proj_rescope_project_id path added to support /admin/classify
// inline-create. Per design proj-rescope-s6-design-V001-20260519.1625.md
// §4 Q3 + §5.3 #6.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('varieties Lambda POST source_proj_rescope_project_id path (S6)', () => {
  it('reads source_proj_rescope_project_id from body', () => {
    expect(SRC).toMatch(/body\.source_proj_rescope_project_id/);
  });

  it('idempotent SELECT runs BEFORE rate limit + fuzzy-match when sourceProjId set', () => {
    const postStart = SRC.indexOf("if (method === 'POST')");
    const idemIdx = SRC.indexOf('if (sourceProjId)', postStart);
    const rateIdx = SRC.indexOf('checkRateLimit', postStart);
    const fuzzyIdx = SRC.indexOf('allow_duplicate', postStart);
    expect(postStart).toBeGreaterThan(-1);
    expect(idemIdx).toBeGreaterThan(postStart);
    expect(rateIdx).toBeGreaterThan(idemIdx);
    expect(fuzzyIdx).toBeGreaterThan(idemIdx);
  });

  it('idempotent path returns 200 with existing variety (not 201)', () => {
    const m = SRC.match(/if \(existing\.length\) return resp\(200,[^)]+\)/);
    expect(m, 'expected idempotent 200 return for existing source-id match').toBeTruthy();
  });

  it('fuzzy-match check is skipped when sourceProjId is present', () => {
    expect(SRC).toMatch(/!body\.allow_duplicate && !sourceProjId/);
  });

  it('INSERT includes source_proj_rescope_project_id in column list', () => {
    const postStart = SRC.indexOf("if (method === 'POST')");
    const insertIdx = SRC.indexOf('INSERT INTO public.cultivar', postStart);
    const valuesIdx = SRC.indexOf('VALUES', insertIdx);
    const colBlock = SRC.slice(insertIdx, valuesIdx);
    expect(colBlock).toMatch(/source_proj_rescope_project_id/);
  });

  it('INSERT VALUES binds sourceProjId in correct position', () => {
    const postStart = SRC.indexOf("if (method === 'POST')");
    const valuesIdx = SRC.indexOf('VALUES', postStart);
    const returningIdx = SRC.indexOf('RETURNING', valuesIdx);
    const valuesBlock = SRC.slice(valuesIdx, returningIdx);
    expect(valuesBlock).toMatch(/\$\{sourceProjId\}/);
  });

  it('idempotent SELECT filters by deleted_at IS NULL', () => {
    const idemIdx = SRC.indexOf('if (sourceProjId)');
    const limitIdx = SRC.indexOf('LIMIT 1', idemIdx);
    const idemBlock = SRC.slice(idemIdx, limitIdx);
    expect(idemBlock).toMatch(/WHERE source_proj_rescope_project_id = \$\{sourceProjId\}/);
    expect(idemBlock).toMatch(/deleted_at IS NULL/);
  });
});
