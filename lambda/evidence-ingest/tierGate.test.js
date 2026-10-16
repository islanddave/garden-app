// I40 (BUG-AUTHZLAMBDA-001) — a non-admin cannot write dave_confirmed evidence or a source_record_id.
// The pure gate is executed; its wiring in index.js (not importable here: per-Lambda deps) is pinned
// on decommented source. The real-Postgres arm (403 and no row) is tests/integration/evidence-ingest.int.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdmin, adminOnlyFields } from './tierGate.js';
import { validateEvidenceInput } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('isAdmin — fail-closed copy of lambda/tags/validate.js', () => {
  it('unset / empty / whitespace env -> nobody is admin', () => {
    expect(isAdmin('user_a', {})).toBe(false);
    expect(isAdmin('user_a', { ADMIN_CLERK_SUBS: '' })).toBe(false);
    expect(isAdmin('user_a', { ADMIN_CLERK_SUBS: ' , ' })).toBe(false);
    expect(isAdmin('', { ADMIN_CLERK_SUBS: ' , ' })).toBe(false);
  });
  it('listed sub is admin, others are not', () => {
    expect(isAdmin('user_a', { ADMIN_CLERK_SUBS: 'user_b, user_a' })).toBe(true);
    expect(isAdmin('user_c', { ADMIN_CLERK_SUBS: 'user_b, user_a' })).toBe(false);
  });
});

describe('adminOnlyFields — which validated values need an admin', () => {
  it('flags dave_confirmed on each of tier / source_tier / provenance', () => {
    expect(adminOnlyFields({ tier: 'dave_confirmed' })).toEqual(['tier']);
    expect(adminOnlyFields({ source_tier: 'dave_confirmed' })).toEqual(['source_tier']);
    expect(adminOnlyFields({ provenance: 'dave_confirmed' })).toEqual(['provenance']);
  });
  it('flags a non-null source_record_id (pipeline-only, globally unique)', () => {
    expect(adminOnlyFields({ source_record_id: 'pipe-1' })).toEqual(['source_record_id']);
    expect(adminOnlyFields({ source_record_id: null })).toEqual([]);
  });
  it('an ordinary first-party value needs nothing', () => {
    expect(adminOnlyFields({ tier: 'first_party_log', source_tier: 'first_party_obs', provenance: 'user', source_record_id: null })).toEqual([]);
  });
  // Through the REAL validator: a legacy `tier: dave_confirmed` derives source_tier dave_confirmed
  // (trust_rank 5), so the gate sees it on the value index.js actually writes.
  it('the legacy tier path is caught on the validated value', () => {
    const v = validateEvidenceInput({
      entity_id: '11111111-1111-1111-1111-111111111111', schema_version: 1,
      tier: 'dave_confirmed', axis: 'local', polarity: 'supporting', observed_at: '2026-06-16T00:00:00Z',
    });
    if (v.ok) {
      expect(adminOnlyFields(v.value)).toContain('tier');
      expect(v.value.source_tier).toBe('dave_confirmed');
    } else {
      // The fixture above must stay a VALID payload, or this test proves nothing.
      expect.fail(`fixture rejected by validateEvidenceInput: ${v.error}`);
    }
  });
});

describe('evidence-ingest index.js — the gate is wired before any DB work (I40)', () => {
  const iValidate = SRC.indexOf('const v = validateEvidenceInput(body);');
  const iGate = SRC.indexOf('const adminFields = adminOnlyFields(v.value);');
  const iNeon = SRC.indexOf('neon(secrets.NEON_DATABASE_URL)');
  it('imports the gate from its own module (not validate.js)', () => {
    expect(SRC).toMatch(/import \{ adminOnlyFields, isAdmin \} from '\.\/tierGate\.js';/);
  });
  it('sits after validation and before the DB client / entity lookup', () => {
    expect(iValidate).toBeGreaterThan(-1);
    expect(iGate).toBeGreaterThan(iValidate);
    expect(iNeon).toBeGreaterThan(iGate);
  });
  // MUTATION: delete the `if (adminFields.length && !isAdmin(...))` block -> RED.
  it('403s a non-admin, logging the denied fields', () => {
    expect(SRC.slice(iGate, iNeon)).toMatch(/if \(adminFields\.length && !isAdmin\(userId, process\.env\)\) \{\s*console\.warn\(JSON\.stringify\(\{ msg: 'evidence-tier-denied', userId, fields: adminFields \}\)\);\s*return resp\(403, \{ error: 'Forbidden' \}\);/);
  });
});
