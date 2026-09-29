// V5-LOSSTOKEN-001 — the legacy loss/give-away spellings keep working, on every path that reads them.
//
// Dave, 2026-09-29: the plant-reduction event types moved from `failed` / `given_away` (a planting
// STATUS and a kitchen-batch OUTCOME) to `reduction_lost` / `reduction_given_away`. Old spellings
// survive in three places the rename cannot reach at once: rows stored before the backfill (or brought
// back by a restore), phones running a cached older bundle, and saved links. The review panel
// (Gardening/project-state/_lossrename-20260929/seat-qa-architect.md) proved that the existing suite
// could not see a missing alias: a no-alias rename left 231 token tests green while DELETE of a stored
// `failed` row silently restored nothing and a PUT of it returned 200.
//
// So these drive the REAL handler (Lambda runtime stubs, per-file neon mock as in
// reanchor-cache-liveness.test.js) and assert what is BOUND into the statements that are SENT:
//   POST   a legacy body stores the canonical token and decrements with it
//   PUT    a stored legacy row, and a legacy body, are both refused as reduction edits
//   DELETE a stored legacy row reverses its counters (loss: qty + qty_lost; gift: qty only)
//   feed   a type filter matches every stored spelling, in both directions
// LIMIT: the stub records SQL and runs none of it — this proves the bound values and which statements
// run, not the rows Postgres would match.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import {
  normalizeLegacyEventType, canonicalEventType, eventTypeTokens, readReductionPlan,
  isPlantReductionEventType, accruesQtyLost, reductionReasonKey,
  LOSS_EVENT_TYPE, GIVEAWAY_EVENT_TYPE, LEGACY_EVENT_TYPE_ALIASES,
} from './validators.js';
import * as canon from '../../src/lib/eventTypes.js';

const rec = vi.hoisted(() => ({ sent: [], tx: 0, respond: () => [] }));

vi.mock('@neondatabase/serverless', () => ({
  neon: () => {
    const text = (strings) => strings.reduce((acc, s, i) => acc + (i ? `$${i}` : '') + s, '');
    const sql = (strings, ...values) => {
      const q = { text: text(strings), values };
      Object.defineProperty(q, 'then', {
        enumerable: false,
        value: (ok, err) => {
          rec.sent.push({ text: q.text, values: q.values, tx: null });
          return Promise.resolve().then(() => rec.respond(q)).then(ok, err);
        },
      });
      return q;
    };
    sql.transaction = async (stmts) => {
      rec.tx += 1;
      const out = [];
      for (const q of stmts) {
        rec.sent.push({ text: q.text, values: q.values, tx: rec.tx });
        out.push(await rec.respond(q));
      }
      return out;
    };
    return sql;
  },
}));

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const EVENT = '5e0a7c1d-2b3f-4a6e-9c8d-1f2e3d4c5b6a';
const CONTAINER = 'c0c0c0c0-1111-4222-8333-444455556666';
const PLANTING = 'a1a1a1a1-2222-4333-8444-555566667777';

async function call(method, rawPath, { body, query } = {}) {
  rec.sent = [];
  const res = await handler({
    requestContext: { http: { method } },
    rawPath,
    headers: { authorization: 'Bearer stub-token' },
    queryStringParameters: query,
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}'), sent: rec.sent };
}

beforeEach(() => { resetStubs(); stubState.verifyTokenResult = { sub: USER }; rec.respond = () => []; });

describe('the alias itself (validators.js, generated from src/lib/eventTypes.js)', () => {
  it('maps exactly the two legacy spellings, and nothing else', () => {
    expect(LEGACY_EVENT_TYPE_ALIASES).toEqual({ failed: 'reduction_lost', given_away: 'reduction_given_away' });
    expect(canonicalEventType('failed')).toBe(LOSS_EVENT_TYPE);
    expect(canonicalEventType('given_away')).toBe(GIVEAWAY_EVENT_TYPE);
    for (const t of ['watering', 'harvest', 'status_change', 'reduction_lost', '', undefined, null]) {
      expect(canonicalEventType(t), String(t)).toBe(t);
    }
    // An inherited key must never alias (a plain `in` would map 'toString').
    expect(canonicalEventType('toString')).toBe('toString');
  });

  it('every predicate answers identically for the legacy and the canonical spelling', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_EVENT_TYPE_ALIASES)) {
      expect(isPlantReductionEventType(legacy), legacy).toBe(true);
      expect(accruesQtyLost(legacy), legacy).toBe(accruesQtyLost(canonical));
      expect(reductionReasonKey(legacy), legacy).toBe(reductionReasonKey(canonical));
      expect(eventTypeTokens(legacy)).toEqual(eventTypeTokens(canonical));
    }
    expect(accruesQtyLost(LOSS_EVENT_TYPE)).toBe(true);
    expect(accruesQtyLost(GIVEAWAY_EVENT_TYPE)).toBe(false);
  });

  it('the Lambda mirror agrees with the canonical module on every token (generator parity)', () => {
    // gen-lambda-event-types.mjs used to TYPE these literals; now it derives them. This pins the two
    // modules against each other, so a template edit that drifts reds here rather than in prod.
    const probes = [...canon.EVENT_TYPES, ...Object.keys(canon.LEGACY_EVENT_TYPE_ALIASES), 'status_change', 'nope'];
    for (const t of probes) {
      expect(canonicalEventType(t), t).toBe(canon.canonicalEventType(t));
      expect(isPlantReductionEventType(t), t).toBe(canon.isPlantReductionEventType(t));
      expect(accruesQtyLost(t), t).toBe(canon.accruesQtyLost(t));
      expect(reductionReasonKey(t), t).toBe(canon.reductionReasonKey(t));
      expect(eventTypeTokens(t), t).toEqual(canon.eventTypeTokens(t));
    }
    expect(LEGACY_EVENT_TYPE_ALIASES).toEqual(canon.LEGACY_EVENT_TYPE_ALIASES);
  });

  it('readReductionPlan reads a STORED legacy row exactly like a canonical one', () => {
    const meta = { qty_reduced: 3, loss_reason: 'pest' };
    expect(readReductionPlan({ event_type: 'failed', metadata: meta })).toEqual({ qty: 3, lostAccrual: 3, reason: 'pest' });
    expect(readReductionPlan({ event_type: LOSS_EVENT_TYPE, metadata: meta })).toEqual({ qty: 3, lostAccrual: 3, reason: 'pest' });
    const gift = { qty_reduced: 2, giveaway_reason: 'friend' };
    expect(readReductionPlan({ event_type: 'given_away', metadata: gift })).toEqual({ qty: 2, lostAccrual: 0, reason: 'friend' });
  });

  it('normalizeLegacyEventType rewrites a legacy body in place and reports it, and leaves others alone', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = { event_type: 'failed' };
    expect(normalizeLegacyEventType(b, 'POST')).toBe('failed');
    expect(b.event_type).toBe(LOSS_EVENT_TYPE);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"legacy_event_type_alias"'));
    const w = { event_type: 'watering' };
    expect(normalizeLegacyEventType(w, 'POST')).toBeNull();
    expect(w.event_type).toBe('watering');
    expect(normalizeLegacyEventType(null, 'POST')).toBeNull();
    log.mockRestore();
  });
});

describe('PUT — a reduction event cannot be edited, whichever spelling it is stored or sent under', () => {
  const owned = (event_type) => ({
    id: EVENT, event_type, plant_id: PLANTING, event_date: '2026-09-28T12:00:00.000Z',
    flagged_as_issue: false, severity: null, project_id: CONTAINER, location_id: null, harvest_log_id: null,
    project_owner_id: USER, plant_owner_id: USER, plant_project_id: CONTAINER,
  });
  const put = (stored, body) => {
    rec.respond = ({ text }) => (/AS plant_project_id/.test(text) ? [owned(stored)] : []);
    return call('PUT', `/api/events/${EVENT}`, { body });
  };
  const updates = (sent) => sent.filter((s) => /UPDATE event_log/.test(s.text));

  it('a row STORED as legacy `failed` is refused (was: a raw includes() let it be re-typed)', async () => {
    const r = await put('failed', { event_type: 'watering', event_date: '2026-09-28' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('REDUCTION_EVENT_IMMUTABLE');
    expect(updates(r.sent)).toEqual([]);
  });

  it('a row stored as legacy `given_away` is refused too', async () => {
    const r = await put('given_away', { event_type: 'observation' });
    expect(r.body.code).toBe('REDUCTION_EVENT_IMMUTABLE');
  });

  it('a legacy BODY converting a plain row into a loss is refused', async () => {
    const r = await put('watering', { event_type: 'failed' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('REDUCTION_EVENT_IMMUTABLE');
    // ...and the message names the event in words, never the stored token.
    expect(r.body.error).not.toMatch(/\bfailed\b|given_away|reduction_/);
  });

  it('non-vacuity: an ordinary edit on an ordinary row is not refused', async () => {
    const r = await put('watering', { event_type: 'watering', event_date: '2026-09-28' });
    expect(r.body.code).not.toBe('REDUCTION_EVENT_IMMUTABLE');
  });
});

describe('DELETE — reverses a STORED legacy row\'s counters', () => {
  const del = (event_type, metadata) => {
    rec.respond = ({ text }) => (/el\.metadata,\s*pp\.created_by AS project_owner_id/.test(text)
      ? [{ id: EVENT, project_id: CONTAINER, event_type, plant_id: PLANTING, metadata,
        project_owner_id: USER, plant_owner_id: USER }]
      : []);
    return call('DELETE', `/api/events/${EVENT}`);
  };
  // The reversal statement: its first two binds are undoQty, then undoLost, then the undoQty guard.
  const undo = (sent) => sent.find((s) => /qty_lost\s*=\s*GREATEST\(COALESCE\(p\.qty_lost, 0\) -/.test(s.text));

  for (const [label, type, meta, qty, lost] of [
    ['legacy loss', 'failed', { qty_reduced: 3, loss_reason: 'pest' }, 3, 3],
    ['canonical loss', 'reduction_lost', { qty_reduced: 3, loss_reason: 'pest' }, 3, 3],
    ['legacy gift', 'given_away', { qty_reduced: 2, giveaway_reason: 'friend' }, 2, 0],
    ['canonical gift', 'reduction_given_away', { qty_reduced: 2, giveaway_reason: 'friend' }, 2, 0],
  ]) {
    it(`${label}: restores ${qty} plant(s) and takes ${lost} off qty_lost`, async () => {
      const r = await del(type, meta);
      const u = undo(r.sent);
      expect(u, 'the reversal statement was never sent').toBeTruthy();
      expect(u.values.slice(0, 3)).toEqual([qty, qty, lost]);
      expect(u.values[3]).toBe(qty); // WHERE ${undoQty}::int > 0 — the no-op guard
    });
  }

  it('non-vacuity: a watering row reverses nothing (the guard bind is 0)', async () => {
    const r = await del('watering', null);
    const u = undo(r.sent);
    expect(u.values[3]).toBe(0);
  });
});

describe('feed — a type filter matches every stored spelling of that type', () => {
  const feed = (event_type) => {
    rec.respond = () => [];
    return call('GET', '/api/events/feed', { query: { event_type } });
  };
  const typeBind = (sent) => {
    const q = sent.find((s) => /FROM event_log e/.test(s.text) && /= ANY\(\$\d+::text\[\]\)/.test(s.text));
    expect(q, 'feed query with an ANY(text[]) type filter was not sent').toBeTruthy();
    return q.values.find((v) => Array.isArray(v) && v.some((x) => /reduction_|failed|given_away|watering/.test(x)));
  };

  it('?event_type=reduction_lost also finds rows not yet backfilled', async () => {
    expect(typeBind((await feed('reduction_lost')).sent)).toEqual(['reduction_lost', 'failed']);
  });

  it('a stale bundle\'s ?event_type=failed still finds rows written under the new token', async () => {
    expect(typeBind((await feed('failed')).sent)).toEqual(['reduction_lost', 'failed']);
  });

  it('any other type filters on itself alone', async () => {
    expect(typeBind((await feed('watering')).sent)).toEqual(['watering']);
  });
});

describe('POST — a stale bundle\'s legacy body lands under the canonical token', () => {
  const post = (body) => {
    rec.respond = ({ text }) => {
      if (/FROM public\.plants gn\s+LEFT JOIN public\.plant_projects pp/.test(text)) {
        return [{ id: PLANTING, name: 'Mini Rose', project_id: CONTAINER }];
      }
      if (/SELECT id, name FROM public\.plant_projects/.test(text)) return [{ id: CONTAINER, name: 'House' }];
      if (/SELECT quantity::int AS qty/.test(text)) return [{ qty: 8, harvested: 0, lost: 0, given_away: 0 }];
      if (/AS tz/.test(text)) return [{ tz: 'America/New_York' }];
      if (/INSERT INTO event_log/.test(text)) return [{ id: EVENT, event_type: 'reduction_lost', plant_id: PLANTING }];
      return [];
    };
    return call('POST', '/api/events', { body });
  };
  const insert = (sent) => sent.find((s) => /INSERT INTO event_log/.test(s.text));
  const reduce = (sent) => sent.find((s) => /qty_lost\s*=\s*COALESCE\(p\.qty_lost, 0\) \+/.test(s.text));

  for (const [label, type, meta, canonical, lost] of [
    ['legacy loss', 'failed', { qty_reduced: 2, loss_reason: 'weather' }, 'reduction_lost', 2],
    ['legacy gift', 'given_away', { qty_reduced: 2, giveaway_reason: 'friend' }, 'reduction_given_away', 0],
    ['canonical loss', 'reduction_lost', { qty_reduced: 2, loss_reason: 'weather' }, 'reduction_lost', 2],
  ]) {
    it(`${label}: the row and the counter both see "${canonical}"`, async () => {
      const r = await post({ event_type: type, plant_id: PLANTING, project_id: CONTAINER, metadata: meta });
      const ins = insert(r.sent);
      expect(ins, `no INSERT was sent (status ${r.status}: ${JSON.stringify(r.body).slice(0, 160)})`).toBeTruthy();
      expect(ins.values).toContain(canonical);
      expect(ins.values).not.toContain('failed');
      expect(ins.values).not.toContain('given_away');
      const u = reduce(r.sent);
      expect(u, 'the counter UPDATE was never sent').toBeTruthy();
      expect(u.values).toContain(canonical);
      expect(u.values.slice(0, 3)).toEqual([2, 2, lost]);
    });
  }

  it('the pre-read that ranks the end-status offer sums gifts under EVERY stored spelling', async () => {
    const r = await post({ event_type: 'reduction_lost', plant_id: PLANTING, project_id: CONTAINER,
      metadata: { qty_reduced: 2, loss_reason: 'weather' } });
    const pre = r.sent.find((s) => /SELECT quantity::int AS qty/.test(s.text));
    expect(pre, 'the pre-read was never sent').toBeTruthy();
    expect(pre.values).toContainEqual(['reduction_given_away', 'given_away']);
    expect(pre.text).not.toMatch(/'given_away'/);
  });
});
