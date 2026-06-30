// DRG-BACKBONE-001 P1 §9 — materialization seam tests (round-trip contract + hybrid fault injection).
import { describe, it, expect, vi } from 'vitest';
import { composeFinding } from './finding.js';
import { ENGINE_VERSION } from './config.js';
import { toPersistRow, fromPersistRow, resolveHybrid, RESERVED_DEFAULTS } from './persist.js';

const PLANT = '11111111-1111-1111-1111-111111111111';
const ENTITY = '22222222-2222-2222-2222-222222222222';
const EVID = '33333333-3333-3333-3333-333333333333';
const NOW = Date.parse('2026-06-25T12:00:00Z');

function rawFinding(over = {}) {
  return {
    finding_id: 'issue:evt-1',
    plant_id: PLANT,
    entity_id: ENTITY,
    source_room: 'Knowledge',
    finding_type: 'water_need',
    subject_label: 'Cayenne (Peppers)',
    severity: 'high',
    evidence: [{ tier: 'first_party_log', axis: 'local', observed_at: '2026-06-24', polarity: 'supporting', evidence_id: EVID }],
    harm: { horizon_hours: null, external: false, irreversible: false, is_cadence_miss: false },
    ...over,
  };
}

describe('toPersistRow — every NOT-NULL column resolved + FLAG paths', () => {
  const raw = rawFinding();
  const composed = composeFinding(raw, NOW);
  const row = toPersistRow(raw, composed, NOW);

  it('maps garden_node_id from raw.plant_id (FLAG-1)', () => {
    expect(row.garden_node_id).toBe(PLANT);
  });
  it('carries finding_type + severity from raw (absent in composed output)', () => {
    expect(row.finding_type).toBe('water_need');
    expect(row.severity).toBe('high');
  });
  it('derives finding_kind=diagnostic with null recommended_action in V1 (FLAG-2, satisfies CHECK)', () => {
    expect(row.finding_kind).toBe('diagnostic');
    expect(row.recommended_action).toBeNull();
  });
  it('maps confidence_basis to a UUID[] from evidence ids (FLAG-3), not rendered text', () => {
    expect(row.confidence_basis).toEqual([EVID.toLowerCase()]);
  });
  it('confidence_basis is [] when V1 evidence carries no ids (FLAG-3a)', () => {
    const r2 = rawFinding({ evidence: [{ tier: 'first_party_log', axis: 'local', observed_at: '2026-06-24', polarity: 'supporting' }] });
    expect(toPersistRow(r2, composeFinding(r2, NOW), NOW).confidence_basis).toEqual([]);
  });
  it('promotes finding_kind=action when a recommended_action payload is present (DERIVE-KIND)', () => {
    const r3 = rawFinding({ recommended_action: { label: 'water now' } });
    const row3 = toPersistRow(r3, composeFinding(r3, NOW), NOW);
    expect(row3.finding_kind).toBe('action');
    expect(row3.recommended_action).toEqual({ label: 'water now' });
  });
  it('stamps engine_version + computed_at (clock-as-arg, deterministic)', () => {
    expect(row.engine_version).toBe(ENGINE_VERSION);
    expect(row.computed_at).toBe(new Date(NOW).toISOString());
  });
  it('throws loudly when garden_node_id (raw.plant_id) is missing — never a silent NULL insert', () => {
    expect(() => toPersistRow(rawFinding({ plant_id: null }), composed, NOW)).toThrow(/plant_id/);
  });
  it('throws when finding_type is missing', () => {
    expect(() => toPersistRow(rawFinding({ finding_type: '' }), composed, NOW)).toThrow(/finding_type/);
  });
});

describe('fromPersistRow — re-emits RESERVED Class C constants + coerces NUMERIC', () => {
  const raw = rawFinding();
  const row = { ...toPersistRow(raw, composeFinding(raw, NOW), NOW), id: '44444444-4444-4444-4444-444444444444',
    confidence_local: '0.700', confidence_transferable: '0.000' }; // pg returns NUMERIC as string
  const served = fromPersistRow(row);
  it('coerces NUMERIC strings back to numbers', () => {
    expect(served.confidence_local).toBe(0.7);
    expect(served.confidence_transferable).toBe(0);
  });
  it('re-emits all Class C reserved fields as the documented constants', () => {
    expect(served.entity_role).toBe(RESERVED_DEFAULTS.entity_role);
    expect(served.source_group_id).toBe(RESERVED_DEFAULTS.source_group_id);
    expect(served.correlation_refs).toEqual([]);
    expect(served.scope).toBe('planting');
    expect(served.guide_ref).toBeNull();
    expect(served.confidence_log).toEqual([]);
  });
  it('falls back finding_id to row.id (SEAM GAP: table has no natural finding_id column in V1)', () => {
    expect(served.finding_id).toBe('44444444-4444-4444-4444-444444444444');
  });
});

describe('round-trip contract (§3): compose -> toPersistRow -> fromPersistRow preserves Class A+B', () => {
  const raw = rawFinding();
  const composed = composeFinding(raw, NOW);
  const served = fromPersistRow(toPersistRow(raw, composed, NOW));
  // Fields legitimately allowed to differ: finding_id (table lacks natural id col) + confidence_basis
  // (stored UUID[] vs rendered text). Everything else is the behavior-preservation proof.
  const SEMANTIC = ['schema_version', 'engine_version', 'record_version', 'entity_id', 'source_room',
    'confidence_local', 'confidence_transferable', 'confidence_band', 'tier', 'corroborator_count',
    'assertion_mode', 'decay_state', 'trend', 'channel', 'urgency_level', 'statement',
    'entity_role', 'source_group_id', 'correlation_refs', 'scope', 'guide_ref', 'confidence_log'];
  for (const f of SEMANTIC) {
    it(`preserves ${f}`, () => { expect(served[f]).toEqual(composed[f]); });
  }
  it('Class C reserved fields are constant on BOTH sides (sidecar tripwire — fails if composed emits non-constant)', () => {
    expect(composed.entity_role).toBe(null);
    expect(composed.correlation_refs).toEqual([]);
    expect(composed.scope).toBe('planting');
    expect(composed.confidence_log).toEqual([]);
  });
});

describe('resolveHybrid — read-time engine_version fallback (FALSIFIABILITY)', () => {
  const raw = rawFinding();
  const composed = composeFinding(raw, NOW);
  const currentRow = { ...toPersistRow(raw, composed, NOW), id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', deleted_at: null };

  it('empty materialized set -> [] (caller computes cold nodes; index.js stays compute-on-read)', () => {
    const r = resolveHybrid({ materializedRows: [], recomputeFn: () => { throw new Error('should not recompute'); }, currentEngineVersion: ENGINE_VERSION, now: NOW });
    expect(r).toEqual([]);
  });
  it('serves a current-engine row from the table (no recompute)', () => {
    const recompute = vi.fn();
    const r = resolveHybrid({ materializedRows: [currentRow], recomputeFn: recompute, currentEngineVersion: ENGINE_VERSION, now: NOW });
    expect(recompute).not.toHaveBeenCalled();
    expect(r[0].source).toBe('materialized');
    expect(r[0].served.statement).toBe(composed.statement);
  });
  it('FAULT INJECTION: a STALE engine_version row is NEVER served as-is — it forces recompute', () => {
    const staleRow = { ...currentRow, engine_version: '0.0.1-stale', statement: 'WRONG STALE ADVICE' };
    const recompute = vi.fn(() => ({ ...composed, _recomputed: true }));
    const r = resolveHybrid({ materializedRows: [staleRow], recomputeFn: recompute, currentEngineVersion: ENGINE_VERSION, now: NOW });
    expect(recompute).toHaveBeenCalledOnce();
    expect(r[0].source).toBe('recomputed');
    expect(r[0].served._recomputed).toBe(true);
    expect(r[0].served.statement).not.toBe('WRONG STALE ADVICE');
  });
  it('a soft-deleted row forces recompute (never served stale)', () => {
    const recompute = vi.fn(() => composed);
    const r = resolveHybrid({ materializedRows: [{ ...currentRow, deleted_at: '2026-06-25T00:00:00Z' }], recomputeFn: recompute, currentEngineVersion: ENGINE_VERSION, now: NOW });
    expect(recompute).toHaveBeenCalledOnce();
    expect(r[0].source).toBe('recomputed');
  });
});
