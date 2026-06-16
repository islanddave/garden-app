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
