// DRG-BACKBONE-001 P1 §9 — materialize writer tests (SQL builders + injected-client execution).
// No real DB: a mock client captures (text, values). The writer imports NO Pool/ws/neon (dependency-light,
// COW-dry-runnable, zero bundle/connection risk while unwired) — these tests also prove it loads clean.
import { describe, it, expect, vi } from 'vitest';
import { buildUpsertFinding, buildSoftDeleteResolved, materializeFinding, softDeleteResolvedFinding } from './materialize.js';
import { toPersistRow } from './engine/persist.js';
import { composeFinding } from './engine/finding.js';

const PLANT = '11111111-1111-1111-1111-111111111111';
const ENTITY = '22222222-2222-2222-2222-222222222222';
const NOW = Date.parse('2026-06-25T12:00:00Z');
const raw = { finding_id: 'issue:e1', plant_id: PLANT, entity_id: ENTITY, source_room: 'Knowledge',
  finding_type: 'water_need', subject_label: 'X', severity: 'high',
  evidence: [{ tier: 'first_party_log', axis: 'local', observed_at: '2026-06-24', polarity: 'supporting' }],
  harm: { horizon_hours: null, external: false, irreversible: false, is_cadence_miss: false } };
const row = toPersistRow(raw, composeFinding(raw, NOW), NOW);

describe('buildUpsertFinding — idempotent UPSERT on the partial natural-key index', () => {
  const { text, values } = buildUpsertFinding(row);
  it('targets the (garden_node_id, entity_id, finding_type) partial unique index', () => {
    expect(text).toMatch(/ON CONFLICT \(garden_node_id, entity_id, finding_type\) WHERE deleted_at IS NULL/);
  });
  it('bumps record_version and resurrects a soft-deleted row on conflict', () => {
    expect(text).toMatch(/record_version = findings\.record_version \+ 1/);
    expect(text).toMatch(/deleted_at = NULL/);
  });
  it('is a true no-op when nothing semantic changed (IS DISTINCT FROM guard on DO UPDATE)', () => {
    expect(text).toMatch(/WHERE .*IS DISTINCT FROM/s);
    expect(text).toMatch(/findings\.statement IS DISTINCT FROM EXCLUDED\.statement/);
  });
  it('binds exactly 23 positional values in column order', () => {
    expect(values).toHaveLength(23);
    expect(values[3]).toBe(PLANT);          // garden_node_id is 4th column
    expect(text).toMatch(/\$23\)/);
  });
  it('returns inserted-vs-updated discriminator', () => {
    expect(text).toMatch(/RETURNING id, record_version, \(xmax = 0\) AS inserted/);
  });
});

describe('buildSoftDeleteResolved — soft-delete only (never hard delete)', () => {
  const { text, values } = buildSoftDeleteResolved({ garden_node_id: PLANT, entity_id: ENTITY, finding_type: 'water_need' }, NOW);
  it('UPDATEs deleted_at on the live row only, never DELETEs', () => {
    expect(text).toMatch(/UPDATE public\.findings/);
    expect(text).toMatch(/SET deleted_at = \$4/);
    expect(text).toMatch(/WHERE .*deleted_at IS NULL/s);
    expect(text).not.toMatch(/\bDELETE\b/);
  });
  it('binds the natural key + the resolution timestamp', () => {
    expect(values).toEqual([PLANT, ENTITY, 'water_need', new Date(NOW).toISOString()]);
  });
});

describe('materializeFinding / softDeleteResolvedFinding — execute on an INJECTED client', () => {
  it('runs the upsert on the injected client and returns the result row', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'x', record_version: 1, inserted: true }] }) };
    const res = await materializeFinding(client, raw, composeFinding(raw, NOW), NOW);
    expect(client.query).toHaveBeenCalledOnce();
    const [text, values] = client.query.mock.calls[0];
    expect(text).toMatch(/INSERT INTO public\.findings/);
    expect(values).toHaveLength(23);
    expect(res).toEqual({ id: 'x', record_version: 1, inserted: true });
  });
  it('returns null on a no-op upsert (nothing changed)', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await materializeFinding(client, raw, composeFinding(raw, NOW), NOW)).toBeNull();
  });
  it('soft-delete returns the retired row id', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'gone' }] }) };
    const id = await softDeleteResolvedFinding(client, { garden_node_id: PLANT, entity_id: ENTITY, finding_type: 'water_need' }, NOW);
    expect(id).toBe('gone');
  });
});
