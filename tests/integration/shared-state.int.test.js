// tests/integration/shared-state.int.test.js
// Real-Postgres integration coverage for the garden_shared_state substrate endpoints
// (V3-REWARDSTATE-001): featured-of-day upsert/read + shared sighting-tally atomic increment.
// SKIP-as-noop when garden_shared_state is absent on the branch (the table lands via the
// gated migration step), so the suite stays GREEN pre-migration and exercises the real
// contract once the table exists on the staging-derived ephemeral branch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { directSql, callHandler, setTestUserId, testRunId, setHouseholdDefault } from './_harness.js';
import { handler } from '../../lambda/shared-state/index.js';

const RUN = testRunId();
const USER = `user_int_sharedstate_${RUN}`;
// BUG-AUTHZLAMBDA-001 B6: the handler admits household members only. USER + MATE are the household
// (two entries — a one-entry list admits nobody); STRANGER holds a valid token but is outside it.
const MATE = `user_int_sharedstate_mate_${RUN}`;
const STRANGER = `user_int_sharedstate_stranger_${RUN}`;
const TALLY_KEY = `int-tally-${RUN}`;
const FEATURED_DATE = new Date().toISOString().slice(0, 10);
const SENTINEL = '00000000-0000-0000-0000-000000000001';
let tableExists = false;
let _hhEnv;

beforeAll(async () => {
  // Saved and restored so this file does not leak into the shared worker env.
  _hhEnv = process.env.GARDEN_HOUSEHOLD_IDS;
  process.env.GARDEN_HOUSEHOLD_IDS = `${USER},${MATE}`;
  setTestUserId(USER);
  const r = await directSql`SELECT to_regclass('public.garden_shared_state') AS t`;
  tableExists = !!r[0]?.t;
  if (!tableExists) {
    console.warn('[shared-state.int] garden_shared_state absent on this branch — skipping (apply the V100 migration to staging/prod Neon to exercise).');
  }
});

afterAll(async () => {
  if (_hhEnv === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS;
  else process.env.GARDEN_HOUSEHOLD_IDS = _hhEnv;
  if (!tableExists) return;
  await directSql`DELETE FROM garden_shared_state WHERE kind='incentive_counter' AND natural_key = ${TALLY_KEY}`;
  await directSql`DELETE FROM garden_shared_state WHERE kind='featured_of_day' AND natural_key = ${FEATURED_DATE}`;
});

describe('garden_shared_state endpoints (integration, real Neon)', () => {
  it('featured-of-day PUT then GET round-trips the payload', async () => {
    if (!tableExists) return;
    const payload = { plant_id: RUN, title: 'Tomato of the day' };
    const put = await callHandler(handler, {
      method: 'PUT', path: '/api/shared-state/featured-of-day',
      body: { date: FEATURED_DATE, payload },
    });
    expect(put.status).toBe(200);
    expect(put.body.featured).toEqual(payload);

    const get = await callHandler(handler, { method: 'GET', path: '/api/shared-state/featured-of-day' });
    expect(get.status).toBe(200);
    expect(get.body.featured).toEqual(payload);

    const rows = await directSql`
      SELECT payload FROM garden_shared_state
      WHERE workspace_id = ${SENTINEL}::uuid AND kind='featured_of_day'
        AND natural_key = ${FEATURED_DATE} AND deleted_at IS NULL`;
    expect(rows[0].payload).toEqual(payload);
  });

  it('tally increment creates then accumulates; GET reads it', async () => {
    if (!tableExists) return;
    const inc1 = await callHandler(handler, {
      method: 'POST', path: `/api/shared-state/tally/${TALLY_KEY}/increment`, body: {},
    });
    expect(inc1.status).toBe(200);
    expect(inc1.body.counter).toBe(1);

    const inc5 = await callHandler(handler, {
      method: 'POST', path: `/api/shared-state/tally/${TALLY_KEY}/increment`, body: { by: 5 },
    });
    expect(inc5.body.counter).toBe(6);

    const get = await callHandler(handler, { method: 'GET', path: `/api/shared-state/tally/${TALLY_KEY}` });
    expect(get.status).toBe(200);
    expect(get.body.counter).toBe(6);
  });

  it('concurrent increments are not lost (50 parallel +1 == 50)', async () => {
    if (!tableExists) return;
    const KEY = `int-conc-${RUN}`;
    try {
      await Promise.all(
        Array.from({ length: 50 }, () =>
          callHandler(handler, { method: 'POST', path: `/api/shared-state/tally/${KEY}/increment`, body: {} })
        )
      );
      const get = await callHandler(handler, { method: 'GET', path: `/api/shared-state/tally/${KEY}` });
      expect(get.body.counter).toBe(50);
    } finally {
      await directSql`DELETE FROM garden_shared_state WHERE kind='incentive_counter' AND natural_key = ${KEY}`;
    }
  });

  it('rejects a bad date (400) and a bad tally key (400)', async () => {
    if (!tableExists) return;
    const badDate = await callHandler(handler, {
      method: 'PUT', path: '/api/shared-state/featured-of-day', body: { date: 'not-a-date', payload: {} },
    });
    expect(badDate.status).toBe(400);
    const badKey = await callHandler(handler, {
      method: 'POST', path: '/api/shared-state/tally/bad key!/increment', body: {},
    });
    expect(badKey.status).toBe(400);
  });

  it('unknown route returns 405', async () => {
    if (!tableExists) return;
    const r = await callHandler(handler, { method: 'DELETE', path: '/api/shared-state/featured-of-day' });
    expect(r.status).toBe(405);
  });

  it('a household member other than the first entry is admitted (200)', async () => {
    if (!tableExists) return;
    setTestUserId(MATE);
    try {
      const r = await callHandler(handler, { method: 'GET', path: `/api/shared-state/tally/${TALLY_KEY}` });
      expect(r.status).toBe(200);
    } finally {
      setTestUserId(USER);
    }
  });

  // Runs whether or not the table exists: the gate answers before any SQL.
  it('a non-member with a valid token gets 403 on every route and writes nothing', async () => {
    const KEY = `int-stranger-${RUN}`;
    setTestUserId(STRANGER);
    setHouseholdDefault(false); // the stranger stays outside the list: this case IS the household gate's refusal
    try {
      for (const [method, path, body] of [
        ['GET', `/api/shared-state/tally/${KEY}`],
        ['POST', `/api/shared-state/tally/${KEY}/increment`, {}],
        ['GET', '/api/shared-state/featured-of-day'],
        ['PUT', '/api/shared-state/featured-of-day', { date: FEATURED_DATE, payload: { by: 'stranger' } }],
      ]) {
        const r = await callHandler(handler, { method, path, body });
        expect(r.status, `${method} ${path}`).toBe(403);
      }
    } finally {
      setHouseholdDefault(true);
      setTestUserId(USER);
    }
    if (!tableExists) return;
    const rows = await directSql`
      SELECT 1 FROM garden_shared_state
      WHERE kind='incentive_counter' AND natural_key = ${KEY}`;
    expect(rows.length).toBe(0);
  });
});
