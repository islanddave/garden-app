import { describe, it, expect } from 'vitest';
import { validateEvidenceInput, EXPECTED_SCHEMA_VERSION, TIERS } from './validate.js';

const base = () => ({
  entity_id: '11111111-1111-1111-1111-111111111111', schema_version: 1,
  tier: 'first_party_log', axis: 'local', polarity: 'supporting',
  observed_at: '2026-06-16T00:00:00Z',
});

describe('validateEvidenceInput', () => {
  it('accepts a well-formed payload and normalizes optional fields + observed_at', () => {
    const r = validateEvidenceInput(base());
    expect(r.ok).toBe(true);
    expect(r.value.note).toBe(null);
    expect(r.value.photo_ref).toBe(null);
    expect(r.value.observed_at).toBe('2026-06-16T00:00:00.000Z');
  });
  it('rejects schema-version mismatch (the C-risk #4 gate)', () => {
    const r = validateEvidenceInput({ ...base(), schema_version: 2 });
    expect(r.ok).toBe(false); expect(r.status).toBe(400); expect(r.error).toMatch(/schema_version/);
  });
  it('rejects a non-uuid entity_id', () => {
    expect(validateEvidenceInput({ ...base(), entity_id: 'nope' }).ok).toBe(false);
    expect(validateEvidenceInput({ ...base(), entity_id: 123 }).ok).toBe(false);
  });
  it('rejects unknown tier / axis / polarity', () => {
    expect(validateEvidenceInput({ ...base(), tier: 'bogus' }).ok).toBe(false);
    expect(validateEvidenceInput({ ...base(), axis: 'sideways' }).ok).toBe(false);
    expect(validateEvidenceInput({ ...base(), polarity: 'meh' }).ok).toBe(false);
  });
  it('accepts every engine tier name', () => {
    for (const t of TIERS) expect(validateEvidenceInput({ ...base(), tier: t }).ok).toBe(true);
  });
  it('defaults observed_at to now when omitted; rejects a bad timestamp', () => {
    const r = validateEvidenceInput({ ...base(), observed_at: undefined });
    expect(r.ok).toBe(true); expect(typeof r.value.observed_at).toBe('string');
    expect(validateEvidenceInput({ ...base(), observed_at: 'not-a-date' }).ok).toBe(false);
  });
  it('rejects optional fields of the wrong type', () => {
    expect(validateEvidenceInput({ ...base(), note: 5 }).ok).toBe(false);
    expect(validateEvidenceInput({ ...base(), source: {} }).ok).toBe(false);
  });
  it('rejects a non-object body', () => {
    expect(validateEvidenceInput(null).ok).toBe(false);
    expect(validateEvidenceInput([]).ok).toBe(false);
    expect(validateEvidenceInput('x').ok).toBe(false);
  });
  it('EXPECTED_SCHEMA_VERSION matches the engine contract (1)', () => {
    expect(EXPECTED_SCHEMA_VERSION).toBe(1);
  });
});

// ── CARE-ENGINE-P0 dual-write (G-EVID) — derive V2 cols from the legacy body ──────────────────
import { TIER_TO_V2, STORED_SCHEMA_VERSION, EVIDENCE_CLASSES } from './validate.js';

const baseDW = () => ({
  entity_id: '11111111-1111-1111-1111-111111111111', schema_version: 1,
  tier: 'first_party_log', axis: 'local', polarity: 'supporting', note: 'leaf spots',
});

describe('validateEvidenceInput — V2 dual-write derivation (G-EVID)', () => {
  it('an OLD V1 body derives every required V2 col (backward-compat)', () => {
    const r = validateEvidenceInput(baseDW());
    expect(r.ok).toBe(true);
    const x = r.value;
    expect(x.schema_version).toBe(STORED_SCHEMA_VERSION);   // stored row is V2 (=2)
    expect(x.evidence_class).toBe('observation');           // G-EVID backfill-consistent default
    expect(x.entity_type).toBe('organism');
    expect(x.source_tier).toBe('first_party_obs');          // tier-mapped, not renumbered
    expect(x.trust_rank).toBe(4);
    expect(x.strength_weight).toBe(0.7);
    expect(x.claim_scope).toBe('crop');
    expect(x.evidence_kind).toBe('user_note');
    expect(x.claim).toBe('leaf spots');                     // from note
    expect(x.provenance).toBe('user');
    expect(x.retracted).toBe(false);
    expect(typeof x.captured_at).toBe('string');
    expect(x.garden_node_id).toBe(null);
    // legacy cols still present (dual-window)
    expect(x.tier).toBe('first_party_log'); expect(x.axis).toBe('local'); expect(x.polarity).toBe('supporting');
  });

  it('every legacy TIER maps to a lookup-consistent, monotonic trust_rank', () => {
    const ranks = TIERS.map(t => {
      const r = validateEvidenceInput({ ...baseDW(), tier: t });
      expect(r.ok).toBe(true);
      expect(TIER_TO_V2[t]).toBeTruthy();
      expect(r.value.trust_rank).toBe(TIER_TO_V2[t].trust_rank);     // writer-derived == lookup seed
      expect(r.value.source_tier).toBe(TIER_TO_V2[t].source_tier);
      expect(r.value.strength_weight).toBe(TIER_TO_V2[t].strength_weight);
      return r.value.trust_rank;
    });
    // dave_confirmed(5) > first_party_log(4) > corroborated(3) > distilled(2) > transferable(1)
    expect(ranks).toEqual([5, 4, 3, 2, 1]);
  });

  it('claim falls back to "observation logged" when note is empty', () => {
    const r = validateEvidenceInput({ ...baseDW(), note: undefined });
    expect(r.value.claim).toBe('observation logged');
  });

  it('claim_scope=planting REQUIRES garden_node_id (mirrors chk_evidence_planting_requires_node)', () => {
    expect(validateEvidenceInput({ ...baseDW(), claim_scope: 'planting' }).ok).toBe(false);
    const r = validateEvidenceInput({ ...baseDW(), claim_scope: 'planting', garden_node_id: '22222222-2222-2222-2222-222222222222' });
    expect(r.ok).toBe(true); expect(r.value.claim_scope).toBe('planting'); expect(r.value.garden_node_id).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('provenance=claude_distilled REQUIRES model_provenance (mirrors chk_evidence_distilled_requires_model)', () => {
    expect(validateEvidenceInput({ ...baseDW(), provenance: 'claude_distilled' }).ok).toBe(false);
    const r = validateEvidenceInput({ ...baseDW(), provenance: 'claude_distilled', model_provenance: { model_id: 'x', model_version: '1', prompt_version: '1' } });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown V2 enum overrides', () => {
    expect(validateEvidenceInput({ ...baseDW(), evidence_class: 'bogus' }).ok).toBe(false);
    expect(validateEvidenceInput({ ...baseDW(), entity_type: 'bogus' }).ok).toBe(false);
    expect(validateEvidenceInput({ ...baseDW(), source_tier: 'bogus' }).ok).toBe(false);
    expect(validateEvidenceInput({ ...baseDW(), claim_scope: 'bogus' }).ok).toBe(false);
    expect(validateEvidenceInput({ ...baseDW(), evidence_kind: 'bogus' }).ok).toBe(false);
    expect(validateEvidenceInput({ ...baseDW(), provenance: 'bogus' }).ok).toBe(false);
  });

  it('explicit V2 overrides persist + every evidence_class is accepted', () => {
    for (const c of EVIDENCE_CLASSES) {
      const body = { ...baseDW() };
      if (c === 'knowledge') { body.provenance = 'claude_distilled'; body.model_provenance = { model_id: 'x', model_version: '1', prompt_version: '1' }; }
      const r = validateEvidenceInput({ ...body, evidence_class: c });
      expect(r.ok, c).toBe(true); expect(r.value.evidence_class).toBe(c);
    }
  });
});
