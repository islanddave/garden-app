// V4-PLANTTYPE-001 — varieties Lambda crop-type plumbing.
// (1) validateBody unit tests for the new optional fields.
// (2) static-source guards pinning the read/write column plumbing + crop-types vocab route,
//     so a future edit that drops a column from one SELECT/INSERT but not the others red-CIs
//     (the green-tests-broken-prod / mock-sql-blindspot guard family, L-104/L-181).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBody, VALID_LIFECYCLE } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const CROP_COLS = ['crop_type_slug', 'lifecycle', 'scoville_min', 'scoville_max', 'growth_habit', 'produces_scape'];

describe('validateBody — PLANTTYPE fields', () => {
  it('accepts a full valid crop-type payload', () => {
    expect(validateBody({
      name: 'Habanero', crop_type_slug: 'pepper', lifecycle: 'tender_perennial',
      scoville_min: 100000, scoville_max: 350000, growth_habit: 'compact', produces_scape: false,
    })).toBeNull();
  });
  it('accepts null/omitted crop-type fields (all optional)', () => {
    expect(validateBody({ name: 'Mystery' })).toBeNull();
    expect(validateBody({ name: 'Mystery', crop_type_slug: null, lifecycle: null, scoville_min: null })).toBeNull();
  });
  it('rejects an empty-string crop_type_slug', () => {
    expect(validateBody({ name: 'X', crop_type_slug: '   ' })).toMatch(/crop_type_slug/);
  });
  it('rejects a lifecycle outside the enum', () => {
    expect(validateBody({ name: 'X', lifecycle: 'evergreen' })).toMatch(/lifecycle must be one of/);
    expect(VALID_LIFECYCLE).toContain('tender_perennial');
  });
  it('rejects scoville_min > scoville_max', () => {
    expect(validateBody({ name: 'X', scoville_min: 5000, scoville_max: 100 })).toMatch(/scoville_min must be <= scoville_max/);
  });
  it('rejects non-integer / negative scoville', () => {
    expect(validateBody({ name: 'X', scoville_min: 1.5 })).toMatch(/scoville_min must be/);
    expect(validateBody({ name: 'X', scoville_max: -1 })).toMatch(/scoville_max must be/);
  });
  it('rejects a non-boolean produces_scape', () => {
    expect(validateBody({ name: 'X', produces_scape: 'yes' })).toMatch(/produces_scape/);
  });
  it('rejects a non-string growth_habit', () => {
    expect(validateBody({ name: 'X', growth_habit: 42 })).toMatch(/growth_habit/);
  });
});

describe('varieties Lambda — crop-types vocab route', () => {
  it('handles GET /api/varieties/crop-types BEFORE the :id route', () => {
    const cropIdx = SRC.indexOf("rawPath === '/api/varieties/crop-types'");
    const idMatchIdx = SRC.indexOf('const idMatch = rawPath.match');
    expect(cropIdx).toBeGreaterThan(-1);
    expect(idMatchIdx).toBeGreaterThan(-1);
    expect(cropIdx).toBeLessThan(idMatchIdx); // else "crop-types" parses as a variety id
  });
  it('crop-types route selects from crop_types filtering soft-deletes, ordered by sort_order', () => {
    const i = SRC.indexOf("rawPath === '/api/varieties/crop-types'");
    const block = SRC.slice(i, i + 500);
    expect(block).toMatch(/FROM public\.crop_types/);
    expect(block).toMatch(/deleted_at IS NULL/);
    expect(block).toMatch(/ORDER BY sort_order/);
  });
});

describe('varieties Lambda — crop-type column plumbing (static guards)', () => {
  it('every client-facing SELECT from public.cultivar projects all 6 crop columns', () => {
    // Each cultivar SELECT that returns a full variety row to the client must carry the cols.
    // (Excludes the minimal fuzzy-match SELECT id,name,species,genus — internal only.)
    const selects = SRC.split('FROM public.cultivar');
    // selects[0] is the preamble before the first SELECT; selects[1..] each start with the
    // tail of a SELECT (its column list is the text just BEFORE the split point).
    const colLists = [];
    let idx = 0;
    let from = SRC.indexOf('FROM public.cultivar', idx);
    while (from !== -1) {
      const selStart = SRC.lastIndexOf('SELECT', from);
      colLists.push(SRC.slice(selStart, from));
      from = SRC.indexOf('FROM public.cultivar', from + 1);
    }
    const fullSelects = colLists.filter(c => c.includes('display_name AS name') && c.includes('care_notes'));
    expect(fullSelects.length).toBeGreaterThanOrEqual(4); // byId, list q, list all, sourceProj-existing
    for (const c of fullSelects) {
      for (const col of CROP_COLS) expect(c, `SELECT missing ${col}`).toContain(col);
    }
  });
  it('INSERT column list + RETURNING include all 6 crop columns', () => {
    const insertIdx = SRC.indexOf('INSERT INTO public.cultivar');
    const valuesIdx = SRC.indexOf('VALUES', insertIdx);
    const cols = SRC.slice(insertIdx, valuesIdx);
    for (const col of CROP_COLS) expect(cols, `INSERT missing ${col}`).toContain(col);
    const returning = SRC.slice(valuesIdx, SRC.indexOf('`', valuesIdx + 5) + 1);
    for (const col of CROP_COLS) expect(returning, `INSERT RETURNING missing ${col}`).toContain(col);
  });
  it('PUT UPDATE COALESCEs all 6 crop columns', () => {
    const updIdx = SRC.indexOf('UPDATE public.cultivar SET');
    const updBlock = SRC.slice(updIdx, SRC.indexOf('WHERE id =', updIdx));
    for (const col of CROP_COLS) {
      expect(updBlock, `UPDATE missing COALESCE for ${col}`).toMatch(new RegExp(`${col}\\s*=\\s*COALESCE`));
    }
  });
});
