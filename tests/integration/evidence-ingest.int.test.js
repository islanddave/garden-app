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
let sampleEntityId = null;
const inserted = [];

beforeAll(async () => {
  setTestUserId(USER);
  const r = await directSql`SELECT to_regclass('public.evidence') AS t`;
  tableExists = !!r[0]?.t;
  if (tableExists) {
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
    if (!tableExists || !sampleEntityId) return;
    const r = await callHandler(handler, { method: 'POST', path: '/api/evidence', body: validBody({ note: 'int test note' }) });
    expect(r.status).toBe(201);
    expect(r.body.evidence.id).toBeTruthy();
    inserted.push(r.body.evidence.id);
    const back = await directSql`SELECT entity_id, tier, axis, polarity, created_by, note FROM public.evidence WHERE id = ${r.body.evidence.id}`;
    expect(back[0].created_by).toBe(USER);
    expect(back[0].tier).toBe('first_party_log');
    expect(back[0].note).toBe('int test note');
  });
  it('rejects other methods with 405', async () => {
    if (!tableExists) return;
    const r = await callHandler(handler, { method: 'GET', path: '/api/evidence' });
    expect(r.status).toBe(405);
  });
});
