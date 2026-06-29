// tests/integration/evidence-ingest.int.test.js
// Real-Postgres integration coverage for the evidence-ingest write path (DRG-ENGINE-003 slice 7).
// SKIP-as-noop when the `evidence` table is absent on the branch (it lands via the additive V100
// migration), so the suite stays GREEN pre-migration and exercises the real contract once the table
// exists on the staging-derived ephemeral branch (L-173: migration must reach staging, not just prod).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { directSql, callHandler, setTestUserId, testRunId } from './_harness.js';
import { handler } from '../../lambda/evidence-ingest/index.js';

const RUN = testRunId();
const USER = `user_int_evidence_${RUN}`;
let tableExists = false;
let v2ColsExist = false;
let sampleEntityId = null;
const inserted = [];

beforeAll(async () => {
  setTestUserId(USER);
  const r = await directSql`SELECT to_regclass('public.evidence') AS t`;
  tableExists = !!r[0]?.t;
  if (tableExists) {
    // CARE-ENGINE-P0: the dual-write INSERT references V2 cols (evidence_class, ...). They land via the
    // P0 additive migration; until it reaches this branch's parent (staging), skip the WRITE test so the
    // suite stays GREEN pre-migration (L-173). The 400/404/405 tests do not hit the INSERT.
    const c = await directSql`SELECT 1 AS x FROM information_schema.columns WHERE table_name='evidence' AND column_name='evidence_class'`;
    v2ColsExist = c.length > 0;
    const e = await directSql`SELECT id FROM public.entity WHERE deleted_at IS NULL LIMIT 1`;
    sampleEntityId = e[0]?.id ?? null;
  } else {
    console.warn('[evidence-ingest.int] evidence table absent on this branch — skipping (apply the DRG-ENGINE-003 V100 migration to staging/prod Neon to exercise).');
  }
});

afterAll(async () => {
  if (inserted.length) await directSql`DELETE FROM public.evidence WHERE id = ANY(${inserted}::uuid[])`;
});

const validBody = (over = {}) => ({
  entity_id: sampleEntityId, schema_version: 1, tier: 'first_party_log',
  axis: 'local', polarity: 'supporting', observed_at: new Date().toISOString(),
  source: 'integration-test', ...over,
});

describe('evidence-ingest write path (integration, real Neon)', () => {
  it('rejects schema-version mismatch (400)', async () => {
    if (!tableExists) return;
    const r = await callHandler(handler, { method: 'POST', path: '/api/evidence', body: validBody({ schema_version: 2 }) });
    expect(r.status).toBe(400);
  });
  it('rejects an unknown entity_id (404)', async () => {
    if (!tableExists) return;
    const r = await callHandler(handler, { method: 'POST', path: '/api/evidence', body: validBody({ entity_id: '00000000-0000-0000-0000-0000000000ff' }) });
    expect(r.status).toBe(404);
  });
  it('writes an append-only evidence row for a valid entity (201) and persists it', async () => {
    if (!tableExists || !sampleEntityId || !v2ColsExist) return;
    const r = await callHandler(handler, { method: 'POST', path: '/api/evidence', body: validBody({ note: 'int test note' }) });
    expect(r.status).toBe(201);
    expect(r.body.evidence.id).toBeTruthy();
    inserted.push(r.body.evidence.id);
    // legacy cols preserved (dual-window) AND V2 cols dual-written (G-EVID)
    const back = await directSql`SELECT tier, axis, polarity, created_by, note, schema_version, evidence_class, entity_type, claim, source_tier, trust_rank, strength_weight, claim_scope, retracted FROM public.evidence WHERE id = ${r.body.evidence.id}`;
    expect(back[0].created_by).toBe(USER);
    expect(back[0].tier).toBe('first_party_log');
    expect(back[0].note).toBe('int test note');
    expect(back[0].schema_version).toBe(2);                 // stored row is V2
    expect(back[0].evidence_class).toBe('observation');     // derived default
    expect(back[0].entity_type).toBe('organism');
    expect(back[0].source_tier).toBe('first_party_obs');    // tier-mapped
    expect(back[0].trust_rank).toBe(4);
    expect(Number(back[0].strength_weight)).toBe(0.7);
    expect(back[0].claim_scope).toBe('crop');
    expect(back[0].claim).toBe('int test note');            // from note
    expect(back[0].retracted).toBe(false);
  });
  it('rejects other methods with 405', async () => {
    if (!tableExists) return;
    const r = await callHandler(handler, { method: 'GET', path: '/api/evidence' });
    expect(r.status).toBe(405);
  });
});
