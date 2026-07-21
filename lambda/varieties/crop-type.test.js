// V4-PLANTTYPE-001 — varieties Lambda crop-type plumbing.
// (1) validateBody unit tests for the new optional fields.
// (2) static-source guards pinning the read/write column plumbing + crop-types vocab route,
//     so a future edit that drops a column from one SELECT/INSERT but not the others red-CIs
//     (the green-tests-broken-prod / mock-sql-blindspot guard family, L-104/L-181).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateBody, VALID_LIFECYCLE,
  slugifyCropType, resolveCropTypeName, validateCropTypeBody,
  COUPLED_CROP_SLUGS, COUPLED_CROP_SYNONYMS,
} from './validate.js';

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

// ── V4-CROPTYPE-001 — user-minted crop types ────────────────────────────────────────────────
// The vocabulary used to be closed from the app: a plant with no matching type could only be saved
// with crop_type_slug = NULL, which drops it out of every type-grouped view. These tests pin the
// two halves of Dave's accepted design — "always-add-on-the-fly" (anything genuinely new creates)
// and "guard only the 8 code-coupled slugs" (a near-duplicate of those steers to the original).

describe('slugifyCropType', () => {
  it('derives a safe slug from a display name', () => {
    expect(slugifyCropType('Hibiscus')).toBe('hibiscus');
    expect(slugifyCropType('Rose of Sharon')).toBe('rose_of_sharon');
    expect(slugifyCropType('  Mahogany  Splendor  ')).toBe('mahogany_splendor');
  });

  it('strips combining accents rather than turning them into separators', () => {
    // NFKD leaves a combining acute behind; without the strip this became 'e_pinard'.
    expect(slugifyCropType('Épinard')).toBe('epinard');
  });

  it('returns empty for names with no alphanumerics (caller must reject)', () => {
    expect(slugifyCropType('   ')).toBe('');
    expect(slugifyCropType('!!!')).toBe('');
    expect(slugifyCropType(null)).toBe('');
    expect(slugifyCropType(42)).toBe('');
  });

  it('never emits leading/trailing separators or exceeds the column-safe length', () => {
    expect(slugifyCropType('--Kale--')).toBe('kale');
    expect(slugifyCropType('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('resolveCropTypeName — always-add, guard the coupled 8', () => {
  const HAVE = ['tomato', 'pepper', 'onion', 'garlic', 'shallot', 'chives', 'basil', 'bean', 'carrot', 'hibiscus'];

  it('creates a genuinely new crop freely', () => {
    for (const name of ['Amaranth', 'Luffa', 'Rose of Sharon', 'Tomatillo']) {
      expect(resolveCropTypeName(name, HAVE), name).toMatchObject({ ok: true });
    }
  });

  it('steers an exact repeat to the existing type', () => {
    expect(resolveCropTypeName('Hibiscus', HAVE)).toMatchObject({ ok: false, reason: 'exists', existingSlug: 'hibiscus' });
  });

  it('steers a plural of ANY existing type, not just the coupled ones', () => {
    // Generic pluralisation matters: if this only worked via the hand-maintained synonym map,
    // every non-coupled crop ('Carrots') would silently mint a duplicate type.
    expect(resolveCropTypeName('Carrots', HAVE)).toMatchObject({ ok: false, reason: 'plural', existingSlug: 'carrot' });
    expect(resolveCropTypeName('Tomatoes', HAVE)).toMatchObject({ ok: false, existingSlug: 'tomato' });
  });

  it('steers known aliases of the coupled slugs (the facet-loss case)', () => {
    const cases = [['Chili', 'pepper'], ['Chile', 'pepper'], ['Sweet Pepper', 'pepper'],
      ['Scallion', 'onion'], ['Green Onion', 'onion'], ['Snap Bean', 'bean']];
    for (const [name, slug] of cases) {
      expect(resolveCropTypeName(name, HAVE), name).toMatchObject({ ok: false, reason: 'coupled_synonym', existingSlug: slug });
    }
  });

  it('does NOT block "Garlic Chives" — a distinct crop, not an alias of garlic or chives', () => {
    // The synonym map is deliberately narrow: a false positive here blocks a real crop.
    expect(resolveCropTypeName('Garlic Chives', HAVE)).toMatchObject({ ok: true, slug: 'garlic_chives' });
  });

  it('reports invalid for a name that slugifies to nothing', () => {
    expect(resolveCropTypeName('!!!', HAVE)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('treats an empty vocabulary as "everything is new"', () => {
    expect(resolveCropTypeName('Tomato', [])).toMatchObject({ ok: true, slug: 'tomato' });
  });

  it('every coupled slug is guarded against at least one alias or plural', () => {
    // Pins the set itself: adding a 9th coupled slug to crop-derive without an alias entry here
    // should be a visible failure, not a silent gap.
    for (const slug of COUPLED_CROP_SLUGS) {
      // Probe BOTH directions: 'tomato' -> 'tomatoes', and an already-plural 'chives' -> 'chive'.
      // The one-directional probe reported a false gap on chives while missing the real one.
      const viaPlural = resolveCropTypeName(`${slug}s`, HAVE);
      const viaSingular = resolveCropTypeName(slug.replace(/s$/, ''), HAVE);
      const aliases = Object.entries(COUPLED_CROP_SYNONYMS).filter(([, v]) => v === slug);
      const guarded = viaPlural.ok === false || viaSingular.ok === false || aliases.length > 0;
      expect(guarded, `coupled slug '${slug}' has no plural, singular, or alias guard`).toBe(true);
    }
  });
});

describe('validateCropTypeBody', () => {
  it('accepts a minimal and a full payload', () => {
    expect(validateCropTypeBody({ display_name: 'Hibiscus' })).toBeNull();
    expect(validateCropTypeBody({ display_name: 'Hibiscus', category: 'ornamental', default_lifecycle: 'tender_perennial' })).toBeNull();
  });

  it('requires a non-empty display_name', () => {
    expect(validateCropTypeBody({})).toMatch(/display_name/);
    expect(validateCropTypeBody({ display_name: '   ' })).toMatch(/display_name/);
    expect(validateCropTypeBody(null)).toMatch(/body/);
  });

  it('rejects a lifecycle outside the DB CHECK vocabulary', () => {
    // Mirrors crop_types_default_lifecycle_check — a bad value must 400, not surface as a 23514.
    expect(validateCropTypeBody({ display_name: 'X', default_lifecycle: 'evergreen' })).toMatch(/default_lifecycle/);
    for (const lc of VALID_LIFECYCLE) {
      expect(validateCropTypeBody({ display_name: 'X', default_lifecycle: lc })).toBeNull();
    }
  });

  it('rejects a category outside the in-use set (category has no DB CHECK to catch it)', () => {
    expect(validateCropTypeBody({ display_name: 'X', category: 'Ornamental' })).toMatch(/category/);
    expect(validateCropTypeBody({ display_name: 'X', category: 'vine' })).toMatch(/category/);
  });

  it('caps display_name length', () => {
    expect(validateCropTypeBody({ display_name: 'x'.repeat(81) })).toMatch(/80 characters/);
  });
});

describe('resolveCropTypeName — singular/plural symmetry', () => {
  it('steers the SINGULAR of an existing plural type', () => {
    // Found by the coupled-slug meta-test: "Chive" would otherwise mint a duplicate of chives,
    // and that duplicate silently loses the allium_type derived facet.
    expect(resolveCropTypeName('Chive', ['chives'])).toMatchObject({ ok: false, reason: 'plural', existingSlug: 'chives' });
    expect(resolveCropTypeName('Green', ['greens'])).toMatchObject({ ok: false, existingSlug: 'greens' });
  });

  it('still creates a singular that is nobody else\'s plural', () => {
    expect(resolveCropTypeName('Hibiscus', ['tomato'])).toMatchObject({ ok: true, slug: 'hibiscus' });
  });
})
