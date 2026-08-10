// V1.2a-4 S6 (PROJ-RESCOPE) static-source guard for the varieties Lambda
// source_proj_rescope_project_id path added to support /admin/classify
// inline-create. Per design proj-rescope-s6-design-V001-20260519.1625.md
// §4 Q3 + §5.3 #6.

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

// Anchor for the VARIETY POST block. These guards used to do SRC.indexOf("if (method === 'POST')")
// and take the first hit, which silently stopped meaning "the variety POST" once V4-CROPTYPE-001
// added an earlier POST on /api/varieties/crop-types — the ordering assertions below then compared
// offsets from two different routes. Anchoring on the POST guard immediately preceding the
// sourceProjId declaration names the block by its actual content, so any number of future routes
// can be added anywhere in the file without re-breaking these tests.
const varietyPostStart = SRC.lastIndexOf("if (method === 'POST')", SRC.indexOf('const sourceProjId'));

describe('varieties Lambda POST source_proj_rescope_project_id path (S6)', () => {
  it('reads source_proj_rescope_project_id from body', () => {
    expect(SRC).toMatch(/body\.source_proj_rescope_project_id/);
  });

  it('idempotent SELECT runs BEFORE rate limit + fuzzy-match when sourceProjId set', () => {
    const postStart = varietyPostStart;
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
    const postStart = varietyPostStart;
    const insertIdx = SRC.indexOf('INSERT INTO public.cultivar', postStart);
    const valuesIdx = SRC.indexOf('VALUES', insertIdx);
    const colBlock = SRC.slice(insertIdx, valuesIdx);
    expect(colBlock).toMatch(/source_proj_rescope_project_id/);
  });

  it('INSERT VALUES binds sourceProjId in correct position', () => {
    const postStart = varietyPostStart;
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
