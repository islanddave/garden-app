// V5-PUTUPMULTISOURCE-001 (BD-058) — the pure source module, EXECUTED.
//
// EVERY REFUSAL ASSERTION BELOW CARRIES A POSITIVE CONTROL. A test that only shows a bad input is
// rejected cannot tell "the guard works" from "this input was never going to be accepted anyway" —
// the vacuous-guard failure this project has hit repeatedly. So each refusal is paired with the same
// row, minimally repaired, asserted to pass. Where a control is subtle it is named in a comment.
//
// LANE: the root `npm test` run (vitest run --coverage), which is blocking.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PS_SOURCE_KINDS, PS_PROVENANCE_GRADES, PS_QTY_UNITS, PS_MAX_SOURCES, PS_LOST_POINTER,
  normalizeText, sourceRowError, normalizeSourceRows, deriveGrade, gradeAtLeast,
  parentCache, isMultiSource, describeSource,
} from './putUpSources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DDL = readFileSync(
  resolve(__dirname, '../../migrations/v5-putupmultisource-001/0a-additive-ddl.sql'), 'utf8',
);

const PLANT = '11111111-1111-1111-1111-111111111111';
const PEPPER = '22222222-2222-2222-2222-222222222222';
const HARVEST = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const garden = (over = {}) => ({
  source_kind: 'own_garden', display_label: 'Sweet Basil', crop_type_slug: 'basil',
  plant_id: PLANT, ...over,
});
const bought = (over = {}) => ({
  source_kind: 'store', display_label: 'pine nuts', source_label: 'Big Y', ...over,
});

// ── vocabulary parity ───────────────────────────────────────────────────────────────────────────
// A mirror nobody pins is a mirror that drifts. Each array is read back out of the DDL's own CHECK
// clause rather than restated, so a widened constraint that misses this file reds here.
function ddlCheckValues(conname) {
  const at = DDL.indexOf(`ADD CONSTRAINT ${conname}`);
  expect(at, `no ${conname} in the DDL`).toBeGreaterThan(-1);
  const block = DDL.slice(at, DDL.indexOf(';', at));
  return [...block.matchAll(/'([a-z_ ]+)'/g)].map((m) => m[1]);
}

describe('the vocabularies are pinned to the migration', () => {
  it('found the DDL, so the parity assertions are not vacuous', () => {
    expect(DDL.length).toBeGreaterThan(2000);
    expect(ddlCheckValues('chk_ps_source_kind').length).toBe(8);
  });

  it('matches chk_ps_source_kind exactly', () => {
    expect([...PS_SOURCE_KINDS].sort()).toEqual([...ddlCheckValues('chk_ps_source_kind')].sort());
  });

  it('matches chk_ps_provenance_grade exactly', () => {
    expect([...PS_PROVENANCE_GRADES].sort())
      .toEqual([...ddlCheckValues('chk_ps_provenance_grade')].sort());
  });

  it('matches chk_ps_qty_unit exactly, including the space in "fl oz"', () => {
    expect([...PS_QTY_UNITS].sort()).toEqual([...ddlCheckValues('chk_ps_qty_unit')].sort());
    expect(PS_QTY_UNITS).toContain('fl oz');
  });

  it('keeps the grade order semantic, because gradeAtLeast compares by index', () => {
    // Mutation: alphabetise PS_PROVENANCE_GRADES. This reds; the parity test above would not.
    expect(PS_PROVENANCE_GRADES).toEqual(['origin', 'crop', 'planting', 'harvest']);
    expect(gradeAtLeast('harvest', 'planting')).toBe(true);
    expect(gradeAtLeast('crop', 'planting')).toBe(false);
    expect(gradeAtLeast('nonsense', 'origin')).toBe(false);
  });

  it('mirrors the parent vocabulary rather than inventing one', () => {
    // The eight kinds are preservation_log's own. If this file ever grew a ninth the two
    // cardinalities would disagree about what a source can be.
    expect(PS_SOURCE_KINDS).toContain('own_garden');
    expect(PS_SOURCE_KINDS).toContain('store');
    expect(PS_SOURCE_KINDS).toContain('u_pick');
    expect(PS_SOURCE_KINDS).not.toContain('traded');
  });
});

// ── row validation, each refusal with its control ───────────────────────────────────────────────
describe('sourceRowError refuses what the CHECKs refuse', () => {
  it('CONTROL: a plain garden row and a plain bought row both pass', () => {
    // Without this the whole block below could be passing because every fixture is malformed.
    expect(sourceRowError(garden())).toBeNull();
    expect(sourceRowError(bought())).toBeNull();
  });

  it('needs a source kind', () => {
    expect(sourceRowError({ display_label: 'x' })).toMatch(/needs a source/);
    expect(sourceRowError({ display_label: 'x', source_kind: 'own_garden' })).toBeNull();
  });

  it('refuses a kind outside the eight', () => {
    expect(sourceRowError(garden({ source_kind: 'traded' }))).toMatch(/source must be one of/);
    expect(sourceRowError(garden({ source_kind: 'foraged', plant_id: null }))).toBeNull();
  });

  it('needs a display label — the identity rule, with no garden exemption', () => {
    expect(sourceRowError(garden({ display_label: null }))).toMatch(/needs a name/);
    expect(sourceRowError(garden({ display_label: '   ' }))).toMatch(/needs a name/);
    // THE CONTROL THAT MATTERS: a garden row carrying a planting id is still refused without a
    // label. A design that let the FK stand in for the label is exactly the deferred one.
    expect(sourceRowError({ source_kind: 'own_garden', plant_id: PLANT })).toMatch(/needs a name/);
    expect(sourceRowError(garden({ display_label: 'Sweet Basil' }))).toBeNull();
  });

  it('bounds both labels at 120', () => {
    expect(sourceRowError(garden({ display_label: 'x'.repeat(121) }))).toMatch(/120 characters/);
    expect(sourceRowError(garden({ display_label: 'x'.repeat(120) }))).toBeNull();
    expect(sourceRowError(bought({ source_label: 'v'.repeat(121) }))).toMatch(/vendor must be/);
    expect(sourceRowError(bought({ source_label: 'v'.repeat(120) }))).toBeNull();
  });

  it('refuses a garden pointer on a bought row — chk_ps_garden_only', () => {
    expect(sourceRowError(bought({ plant_id: PLANT }))).toMatch(/cannot be linked/);
    expect(sourceRowError(bought({ harvest_log_id: HARVEST }))).toMatch(/cannot be linked/);
    // CONTROL, and it is the load-bearing one: the SAME pointers on an own_garden row are fine.
    // Without this the assertion above would also pass if pointers were refused unconditionally,
    // which would break the internal half of the feature entirely.
    expect(sourceRowError(garden({ plant_id: PLANT, harvest_log_id: HARVEST }))).toBeNull();
  });

  it('refuses a malformed uuid before it reaches Postgres', () => {
    expect(sourceRowError(garden({ plant_id: 'not-a-uuid' }))).toMatch(/plant_id must be a uuid/);
    expect(sourceRowError(garden({ plant_id: PLANT }))).toBeNull();
  });

  it('pairs amount and unit, both directions', () => {
    expect(sourceRowError(garden({ quantity_value: 2 }))).toMatch(/both be set/);
    expect(sourceRowError(garden({ quantity_unit: 'cup' }))).toMatch(/both be set/);
    expect(sourceRowError(garden({ quantity_value: 2, quantity_unit: 'cup' }))).toBeNull();
  });

  it('treats a blank number box as absent, not as zero', () => {
    // '' would pair-check as present and coerce to 0, which the DB rejects. Both halves collapse.
    expect(sourceRowError(garden({ quantity_value: '', quantity_unit: '' }))).toBeNull();
    expect(sourceRowError(garden({ quantity_value: 0, quantity_unit: 'cup' })))
      .toMatch(/greater than 0/);
  });

  it('refuses a unit outside the fourteen', () => {
    expect(sourceRowError(garden({ quantity_value: 1, quantity_unit: 'bushel' })))
      .toMatch(/unit must be one of/);
    expect(sourceRowError(garden({ quantity_value: 1, quantity_unit: 'fl oz' }))).toBeNull();
  });

  it('names the row by 1-based position', () => {
    expect(sourceRowError({}, 0)).toMatch(/^source 1:/);
    expect(sourceRowError({}, 4)).toMatch(/^source 5:/);
  });
});

// ── list normalization ──────────────────────────────────────────────────────────────────────────
describe('normalizeSourceRows', () => {
  it('assigns ordinals from array position, never from the client', () => {
    const { error, rows } = normalizeSourceRows([
      garden({ ordinal: 99 }), bought({ ordinal: 99 }),
    ]);
    expect(error).toBeNull();
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1]);
  });

  it('nulls a vendor on an own_garden row rather than refusing it', () => {
    const { rows } = normalizeSourceRows([garden({ source_label: 'leftover from the picker' })]);
    expect(rows[0].source_label).toBeNull();
    // CONTROL: the same field survives on a non-garden row, so the nulling is conditional and not
    // a blanket drop.
    const { rows: b } = normalizeSourceRows([bought()]);
    expect(b[0].source_label).toBe('Big Y');
  });

  it('defaults the grade but never overrides a sent one', () => {
    const { rows } = normalizeSourceRows([garden({ harvest_log_id: HARVEST })]);
    expect(rows[0].provenance_grade).toBe('harvest');
    // THE RULING: a client asserting a finer grade than the pointers support keeps it. That is how
    // "he knew, and the planting is gone" is recorded after an ON DELETE SET NULL.
    const { rows: kept } = normalizeSourceRows([
      { source_kind: 'own_garden', display_label: 'Cherry Falls', provenance_grade: 'planting' },
    ]);
    expect(kept[0].provenance_grade).toBe('planting');
    expect(deriveGrade({ source_kind: 'own_garden', display_label: 'x' })).toBe('origin');
  });

  it('refuses a non-array, an empty list, and an over-long list', () => {
    expect(normalizeSourceRows(null).error).toMatch(/must be an array/);
    expect(normalizeSourceRows([]).error).toMatch(/non-empty/);
    const many = Array.from({ length: PS_MAX_SOURCES + 1 }, () => garden());
    expect(normalizeSourceRows(many).error).toMatch(/at most/);
    // CONTROL: exactly at the cap is accepted, so the bound is off-by-one-correct.
    const exact = Array.from({ length: PS_MAX_SOURCES }, () => garden());
    expect(normalizeSourceRows(exact).error).toBeNull();
  });

  it('stops at the first bad row and names it', () => {
    const { error, rows } = normalizeSourceRows([garden(), bought({ plant_id: PLANT })]);
    expect(error).toMatch(/^source 2:/);
    expect(rows).toBeNull();
  });
});

// ── the parent cache: the invariant the migration rests on ──────────────────────────────────────
describe('parentCache maintains the ordinal-0 mirror', () => {
  it('mirrors a garden primary, pointers and all', () => {
    const { rows } = normalizeSourceRows([garden({ harvest_log_id: HARVEST }), bought()]);
    const c = parentCache(rows);
    expect(c).toEqual({
      source_kind: 'own_garden', source_label: null, plant_id: PLANT,
      harvest_log_id: HARVEST, crop_type_slug: 'basil', variety_id: null,
    });
  });

  it('NEVER emits a garden pointer beside a non-garden primary', () => {
    // THE ASSERTION THE WHOLE "no parent migration" DECISION RESTS ON. preservation_log still carries
    // chk_preservation_log_source_plant — (source_kind IS NULL OR = 'own_garden' OR plant_id IS NULL)
    // — so a cache that copied a plant_id from a `store` primary would 23514 the parent UPDATE.
    // Hand-built rows, deliberately bypassing normalizeSourceRows: this asserts the SECOND guard, and
    // routing through the first would make it untestable.
    const c = parentCache([{
      ordinal: 0, source_kind: 'store', source_label: 'Big Y', display_label: 'pine nuts',
      plant_id: PLANT, harvest_log_id: HARVEST, crop_type_slug: 'basil',
    }]);
    expect(c.plant_id).toBeNull();
    expect(c.harvest_log_id).toBeNull();
    expect(c.source_kind).toBe('store');
    expect(c.source_label).toBe('Big Y');
    // CONTROL: crop identity is NOT gated on own_garden — a bought thing may be a known crop, and
    // chk_preservation_log_attribution needs one of crop/variety present.
    expect(c.crop_type_slug).toBe('basil');
  });

  it('returns all six keys explicitly for an empty list, never a partial object', () => {
    // A partial object would let a COALESCE-preserving caller retain a stale plant_id whose source
    // row is soft-deleted — the false-provenance shape v4-putupprov-001 rejects a DEFAULT for.
    const c = parentCache([]);
    expect(Object.keys(c).sort()).toEqual([
      'crop_type_slug', 'harvest_log_id', 'plant_id', 'source_kind', 'source_label', 'variety_id',
    ]);
    expect(Object.values(c).every((v) => v === null)).toBe(true);
  });

  it('reads ordinal 0 rather than the first element', () => {
    const rows = [
      { ordinal: 1, source_kind: 'store', display_label: 'pine nuts', source_label: 'Big Y' },
      { ordinal: 0, source_kind: 'own_garden', display_label: 'Basil', plant_id: PLANT },
    ];
    expect(parentCache(rows).plant_id).toBe(PLANT);
  });
});

// ── Dave's three cases, from the ledger row, as fixtures ────────────────────────────────────────
describe("BD-058's actual cases", () => {
  it('A: tomatoes AND basil from the garden, one jar', () => {
    const { error, rows } = normalizeSourceRows([
      garden({ display_label: 'Brandywine', crop_type_slug: 'tomato' }),
      garden({ display_label: 'Sweet Basil', plant_id: PEPPER }),
    ]);
    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    expect(isMultiSource(rows)).toBe(true);
    expect(rows.every((r) => r.provenance_grade === 'planting')).toBe(true);
  });

  it('B: a pesto combining his basil with one of his peppers, at two grades', () => {
    const { error, rows } = normalizeSourceRows([
      garden({ display_label: 'Sweet Basil', harvest_log_id: HARVEST }),
      garden({ display_label: 'Scotch Bonnet', crop_type_slug: 'pepper', plant_id: PEPPER }),
    ]);
    expect(error).toBeNull();
    expect(rows.map((r) => r.provenance_grade)).toEqual(['harvest', 'planting']);
  });

  it('C: garden-grown mixed with locally bought, in ONE jar', () => {
    // The case V100 §7.2 flagged as "currently rejected by chk_preservation_log_source_plant".
    const { error, rows } = normalizeSourceRows([
      garden({ display_label: 'Purple Petra' }),
      bought({ display_label: 'pine nuts' }),
      { source_kind: 'farm_stand', display_label: 'cashews', source_label: 'Warner Farms' },
    ]);
    expect(error).toBeNull();
    expect(rows).toHaveLength(3);
    // Heterogeneous: one internal planting reference, two external with no planting behind them.
    expect(rows.filter((r) => r.plant_id != null)).toHaveLength(1);
    expect(rows.filter((r) => r.source_kind !== 'own_garden')).toHaveLength(2);
    // Per-source vendors — the thing a single parent column cannot hold.
    expect(rows.map((r) => r.source_label)).toEqual([null, 'Big Y', 'Warner Farms']);
    // And the parent cache keeps chk_preservation_log_source_plant satisfiable.
    const c = parentCache(rows);
    expect(c.source_kind).toBe('own_garden');
    expect(c.plant_id).toBe(PLANT);
  });
});

// ── reading ─────────────────────────────────────────────────────────────────────────────────────
describe('describeSource', () => {
  it('names the vendor when there is one, and the kind when there is not', () => {
    expect(describeSource({ display_label: 'pine nuts', source_kind: 'store', source_label: 'Big Y' }))
      .toBe('pine nuts — Big Y');
    expect(describeSource({ display_label: 'Sweet Basil', source_kind: 'own_garden' }))
      .toBe('Sweet Basil — from the garden');
  });

  it('renders the amount when both halves are present', () => {
    expect(describeSource({
      display_label: 'Basil', source_kind: 'own_garden', quantity_value: '2', quantity_unit: 'cup',
    })).toBe('Basil — from the garden — 2 cup');
  });

  it('says the pointer is gone rather than silently downgrading', () => {
    // THE SENTENCE THE STORED GRADE BUYS. Grade claims 'planting'; the FK has been nulled by an
    // ON DELETE SET NULL. Without provenance_grade this row is indistinguishable from crop-grade.
    expect(describeSource({
      display_label: 'Cherry Falls', source_kind: 'own_garden', provenance_grade: 'planting',
      plant_id: null, harvest_log_id: null,
    })).toBe(`Cherry Falls — ${PS_LOST_POINTER}`);
    // CONTROL: the SAME row with its pointer intact renders normally, so the branch is about the
    // missing pointer and not about the grade alone.
    expect(describeSource({
      display_label: 'Cherry Falls', source_kind: 'own_garden', provenance_grade: 'planting',
      plant_id: PLANT,
    })).toBe('Cherry Falls — from the garden');
    // CONTROL 2: an origin-grade row with no pointer is NOT "since removed" — it never had one.
    expect(describeSource({
      display_label: 'pine nuts', source_kind: 'store', provenance_grade: 'origin',
    })).toBe('pine nuts — bought');
  });

  it('never renders a raw machine value for an unknown kind', () => {
    expect(describeSource({ display_label: 'x', source_kind: 'wat' })).toBe('x — from somewhere');
  });
});

describe('normalizeText', () => {
  it('collapses blank to null and trims the rest', () => {
    expect(normalizeText('  ')).toBeNull();
    expect(normalizeText(null)).toBeNull();
    expect(normalizeText(' Basil ')).toBe('Basil');
  });
});
