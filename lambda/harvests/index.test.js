// Unit tests for the harvests read model's PURE helpers (lambda/harvests/aggregate.js). No DB, no
// runtime deps — runs under the root vitest config. Real-Postgres coverage (household scope, keyset
// pagination, season boundaries, orphan render) lives in tests/integration/harvests.int.test.js.
import { describe, it, expect } from 'vitest';
import {
  parseTimeframe, encodeCursor, decodeCursor, isoWeekStart, projectEntry, computeAggregates,
} from './aggregate.js';

describe('parseTimeframe', () => {
  it('absent/empty -> all', () => {
    expect(parseTimeframe(undefined)).toEqual({ kind: 'all' });
    expect(parseTimeframe('')).toEqual({ kind: 'all' });
  });
  it('known bare kinds pass through', () => {
    expect(parseTimeframe('7d')).toEqual({ kind: '7d' });
    expect(parseTimeframe('month')).toEqual({ kind: 'month' });
    expect(parseTimeframe('all')).toEqual({ kind: 'all' });
  });
  it('season:<year> parses the grow-year label', () => {
    expect(parseTimeframe('season:2026')).toEqual({ kind: 'season', year: 2026 });
  });
  it('unknown -> null (handler 400s)', () => {
    expect(parseTimeframe('week')).toBeNull();
    expect(parseTimeframe('season:26')).toBeNull();
    expect(parseTimeframe('season:')).toBeNull();
    expect(parseTimeframe('2026')).toBeNull();
  });
});

describe('cursor round-trip', () => {
  it('encode then decode recovers (event_date, id)', () => {
    const d = new Date('2026-07-20T14:30:00.000Z');
    const id = '11111111-2222-4333-8444-555555555555';
    const c = encodeCursor(d, id);
    expect(typeof c).toBe('string');
    expect(decodeCursor(c)).toEqual({ eventDate: '2026-07-20T14:30:00.000Z', id });
  });
  it('malformed / empty -> null (never throws)', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('%%%not-base64%%%')).toBeNull();
    expect(decodeCursor(Buffer.from('nopipe', 'utf8').toString('base64'))).toBeNull();
  });
});

describe('isoWeekStart', () => {
  it('snaps every weekday to its Monday', () => {
    expect(isoWeekStart('2026-07-20')).toBe('2026-07-20'); // Monday
    expect(isoWeekStart('2026-07-21')).toBe('2026-07-20'); // Tuesday
    expect(isoWeekStart('2026-07-19')).toBe('2026-07-13'); // Sunday -> prior Monday
    expect(isoWeekStart('2026-07-26')).toBe('2026-07-20'); // Sunday of that ISO week
  });
});

describe('projectEntry', () => {
  it('unassigned row (plant_id null) is not planting_removed', () => {
    const e = projectEntry({ event_id: 'e1', event_type: 'harvest', event_date: '2026-07-20T12:00:00.000Z', day_key: '2026-07-20', plant_id: null, gn_id: null, project_id: 'p1', project_name: 'Bed A', crop_slug: null, quantity: '2', unit: 'lb', harvest_log_id: 'h1' });
    expect(e.planting_removed).toBe(false);
    expect(e.crop_type_slug).toBeNull();
    expect(e.photos).toEqual([]);
  });
  it('deleted planting (plant_id set, gn_id null) -> planting_removed true', () => {
    const e = projectEntry({ event_id: 'e2', event_type: 'harvest', event_date: '2026-07-20T12:00:00.000Z', day_key: '2026-07-20', plant_id: 'plant-x', gn_id: null, project_id: 'p1', crop_slug: null, harvest_log_id: null });
    expect(e.planting_removed).toBe(true);
  });
  it('crop_name falls back to slug; note first line truncated', () => {
    const e = projectEntry({ event_id: 'e3', event_type: 'first_harvest', event_date: '2026-07-20T12:00:00.000Z', day_key: '2026-07-20', plant_id: 'x', gn_id: 'x', project_id: 'p1', crop_slug: 'tomato', crop_name: null, notes: 'first line\nsecond line', quantity: null, unit: null, harvest_log_id: null });
    expect(e.crop_name).toBe('tomato');
    expect(e.note_excerpt).toBe('first line');
    expect(e.quantity).toBeNull();
  });
});

describe('computeAggregates', () => {
  const rows = [
    // blueberry, two varieties, cups
    { event_id: 'a', day_key: '2026-07-20', plant_id: 'pl1', gn_id: 'pl1', project_id: 'proj1', project_name: 'Beds', crop_slug: 'blueberry', crop_name: 'Blueberry', variety_id: 'v1', variety_name: 'Bluecrop', harvest_log_id: 'h1', quantity: '2.5', unit: 'cup' },
    { event_id: 'b', day_key: '2026-07-21', plant_id: 'pl1', gn_id: 'pl1', project_id: 'proj1', project_name: 'Beds', crop_slug: 'blueberry', crop_name: 'Blueberry', variety_id: 'v1', variety_name: 'Bluecrop', harvest_log_id: 'h2', quantity: '1.5', unit: 'Cup' }, // mixed raw case -> same key
    { event_id: 'c', day_key: '2026-07-22', plant_id: 'pl2', gn_id: 'pl2', project_id: 'proj1', project_name: 'Beds', crop_slug: 'blueberry', crop_name: 'Blueberry', variety_id: 'v2', variety_name: 'Duke', harvest_log_id: 'h3', quantity: '3', unit: 'cup' },
    // zucchini, count, first_harvest earliest for its planting
    { event_id: 'd', day_key: '2026-06-01', plant_id: 'pl3', gn_id: 'pl3', project_id: 'proj1', project_name: 'Beds', crop_slug: 'zucchini', crop_name: 'Zucchini', variety_id: 'v3', variety_name: 'Black Beauty', harvest_log_id: 'h4', quantity: '4', unit: 'count' },
    // orphan / quantity-less harvest (no harvest_log row) attributed to a crop
    { event_id: 'e', day_key: '2026-07-20', plant_id: 'pl2', gn_id: 'pl2', project_id: 'proj1', project_name: 'Beds', crop_slug: 'blueberry', crop_name: 'Blueberry', variety_id: 'v2', variety_name: 'Duke', harvest_log_id: null, quantity: null, unit: null },
    // unattributed (crop null) -> Other bucket, quantified
    { event_id: 'f', day_key: '2026-07-20', plant_id: null, gn_id: null, project_id: 'proj2', project_name: 'Pots', crop_slug: null, crop_name: null, variety_id: null, variety_name: null, harvest_log_id: 'h6', quantity: '5', unit: 'count' },
  ];
  const agg = computeAggregates(rows);

  it('per-crop per-unit sums (case-insensitive unit key, dominant raw form)', () => {
    const bb = agg.crops.find((c) => c.crop_type_slug === 'blueberry');
    const cupUnit = bb.units.find((u) => u.unit_key === 'cup');
    expect(cupUnit.total).toBe(7); // 2.5 + 1.5 + 3
    expect(cupUnit.count).toBe(3);
    expect(cupUnit.unit).toBe('cup'); // dominant raw ("cup" x2 vs "Cup" x1)
  });
  it('variety sub-totals split within a crop', () => {
    const bb = agg.crops.find((c) => c.crop_type_slug === 'blueberry');
    const bluecrop = bb.varieties.find((v) => v.variety_id === 'v1');
    const duke = bb.varieties.find((v) => v.variety_id === 'v2');
    expect(bluecrop.units.find((u) => u.unit_key === 'cup').total).toBe(4); // 2.5 + 1.5
    expect(duke.units.find((u) => u.unit_key === 'cup').total).toBe(3);
    expect(duke.unquantified).toBe(1); // the orphan Duke row
  });
  it('orphan/quantity-less row counted, never summed', () => {
    expect(agg.unquantified_total).toBe(1);
    const bb = agg.crops.find((c) => c.crop_type_slug === 'blueberry');
    expect(bb.unquantified).toBe(1);
  });
  it('Other bucket holds unattributed rows per project/unit', () => {
    expect(agg.other).toHaveLength(1);
    expect(agg.other[0].project_id).toBe('proj2');
    expect(agg.other[0].units.find((u) => u.unit_key === 'count').total).toBe(5);
  });
  it('first-pick per planting = min day_key', () => {
    const fpPl1 = agg.first_pick.find((f) => f.plant_id === 'pl1');
    expect(fpPl1.first_pick_date).toBe('2026-07-20');
    const fpPl2 = agg.first_pick.find((f) => f.plant_id === 'pl2');
    expect(fpPl2.first_pick_date).toBe('2026-07-20'); // 07-20 orphan earlier than 07-22 quantified
  });
  it('distinct crop list feeds the picker (attributed crops only, sorted)', () => {
    expect(agg.crop_list).toEqual([
      { crop_type_slug: 'blueberry', display_name: 'Blueberry' },
      { crop_type_slug: 'zucchini', display_name: 'Zucchini' },
    ]);
  });
  it('weekly ISO-Monday event-count buckets span the range', () => {
    const total = agg.weekly.reduce((s, w) => s + w.count, 0);
    expect(total).toBe(rows.length);
    expect(agg.weekly.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.week_start))).toBe(true);
  });
});
