// WAVE-2 S3(d), server half — POST /api/inventory-items/:id/seed-stage accepted a future entered_at.
//
// THE DEFECT. `entered_at` lives on seed_lot_stage_log (verified live against a fork of staging —
// it is NOT a column on inventory_items), and /seeds/saved derives its entire queue from it: the
// card's elapsed() reads stage_entered_at, which the list computes from the lot's latest log row.
// A lot entered with a mistyped year therefore reads "0 days in drying" forever and quietly leaves
// the list of things that need checking, on the one page whose whole job is to produce that list.
// The client-side `max` attribute is a separate change; this file covers the server refusal, which
// is the half that also binds the API, the voice path and any future caller.
//
// BACKDATING STAYS UNRESTRICTED and is pinned below. The route is retroactive by design — the 1884
// tomato lot fermented and dried before any of this existed.
//
// WHY THE TOLERANCE IS NOT ZERO, and why testing it matters more than testing the rejection:
// SavedSeeds sends `${when}T12:00:00`, a local date pinned to noon with no zone, so a genuine
// "today" arrives AHEAD of server now for any user west of UTC. A strict `> Date.now()` test would
// refuse Dave's own entry every morning before 08:00 Eastern — a fix that breaks the happy path is
// not a fix. The first case below is the one that catches that regression.
import { describe, it, expect, beforeEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const ITEM = '2d6df841-b507-4e65-8db0-97c8659df37c';
const HOUR = 60 * 60 * 1000;

const stagePost = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: `/api/inventory-items/${ITEM}/seed-stage`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

// An absolute instant, so these cases do not depend on the runner's TZ. The one case that DOES
// exercise the client's zoneless shape says so explicitly.
const isoOffset = (ms) => new Date(Date.now() + ms).toISOString();

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  // One row back from the CTE so a request that reaches the SQL reports 201 rather than the 404 an
  // unconfigured stub gives — otherwise "not 400" could not be told apart from "rejected elsewhere".
  stubState.sqlHandler = () => [{ id: 'log-1', inventory_item_id: ITEM, stage: 'drying' }];
});

describe('WAVE-2 S3d — a seed lot cannot be dated into the future', () => {
  it('accepts the local-noon shape the client actually sends for TODAY', async () => {
    // The regression this guard is most likely to cause. `${when}T12:00:00` for today's local date
    // is up to ~12h ahead of server now once Node parses it — a naive `> Date.now()` reds this.
    const d = new Date();
    const when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const { status, body } = parse(await handler(stagePost({ stage: 'drying', entered_at: `${when}T12:00:00` })));
    expect(body.error).toBeUndefined();
    expect(status).toBe(201);
    expect(stubState.sqlCalls).toHaveLength(1);
  });

  it('refuses a lot dated next year — 400, and nothing is written', async () => {
    // The reported case: a 2027 date renders as "today" and the lot silently leaves the queue.
    const { status, body } = parse(await handler(stagePost({
      stage: 'drying', entered_at: isoOffset(365 * 24 * HOUR),
    })));
    expect(status).toBe(400);
    expect(body.error).toBe('entered_at cannot be in the future');
    // The refusal must precede the CTE — a stage log row written and then reported as an error is
    // the worse half of the bug, not the fix for it.
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('refuses just past the tolerance and accepts just inside it', async () => {
    // Pins the boundary in BOTH directions. A guard tested only on a far-future value passes with
    // the threshold set anywhere at all, including a year.
    const inside = parse(await handler(stagePost({ stage: 'drying', entered_at: isoOffset(47 * HOUR) })));
    expect(inside.status).toBe(201);
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
    stubState.sqlHandler = () => [{ id: 'log-1' }];
    const outside = parse(await handler(stagePost({ stage: 'drying', entered_at: isoOffset(49 * HOUR) })));
    expect(outside.status).toBe(400);
    expect(outside.body.error).toBe('entered_at cannot be in the future');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('still backdates freely — the retroactive case the route was built for', async () => {
    // The 1884 tomato lot. A future-date guard that also blocked the past would break the founding
    // use case, so this is not decoration.
    const { status } = parse(await handler(stagePost({
      stage: 'stored', entered_at: isoOffset(-400 * 24 * HOUR),
    })));
    expect(status).toBe(201);
    expect(stubState.sqlCalls).toHaveLength(1);
  });

  it('leaves an omitted entered_at alone — the DB still defaults it to now()', async () => {
    const { status } = parse(await handler(stagePost({ stage: 'fermenting' })));
    expect(status).toBe(201);
    expect(stubState.sqlCalls).toHaveLength(1);
    // COALESCE(NULL::timestamptz, NOW()) — the absent case must not be dragged into the new branch.
    expect(stubState.sqlCalls[0].text).toMatch(/COALESCE\(\?::timestamptz, NOW\(\)\)/);
    expect(stubState.sqlCalls[0].values).toContain(null);
  });

  it('names a malformed date instead of 500ing through the catch', async () => {
    // Previously this reached Postgres, raised 22007 and fell out of the handler catch as an opaque
    // "Internal server error". Free to fix here: the parse has to happen either way.
    const { status, body } = parse(await handler(stagePost({ stage: 'drying', entered_at: 'yesterday-ish' })));
    expect(status).toBe(400);
    expect(body.error).toBe('entered_at must be a valid date');
    expect(stubState.sqlCalls).toHaveLength(0);
  });
});
