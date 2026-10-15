// BUG-LAMBDAVALIDATION-001 (I12) — the events PUT applies the F22 event_date bounds, on a real move only.
//
// POST and batch have always refused an event_date more than 5y back or more than 1h ahead; the PUT
// only checked that the date parsed, so an edit could move any event to 1900 or 2099. The fix shares
// one helper (eventDateBoundsError) across all three, with two PUT-only differences:
//   - a 24h future allowance, because EventDetail re-sends NOON LOCAL on every save (up to ~12h ahead
//     of now for a same-day edit east of UTC);
//   - the PAST bound runs only when the new instant is more than 36h from the stored one, because
//     that same noon-local re-send "moves" an untouched date by up to 14h. Without the gate a
//     notes-only edit of an event older than 5y would 400 forever. The FUTURE bound always runs, so
//     a date cannot be walked forward 36h per PUT.
// Drives the REAL handler with the per-file neon mock (as loss-token-alias.test.js). The clock is
// pinned so the bounds do not drift with the calendar.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import { eventDateBoundsError, PUT_FUTURE_BOUND_MS, validatePostBody, validateBatchBody } from './validators.js';

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
const NOW = '2026-10-15T12:00:00.000Z';

const owned = (event_date) => ({
  id: EVENT, event_type: 'observation', plant_id: PLANTING, event_date,
  flagged_as_issue: false, severity: null, project_id: CONTAINER, location_id: null, harvest_log_id: null,
  project_owner_id: USER, plant_owner_id: USER, plant_project_id: CONTAINER,
});

async function put(stored, body) {
  rec.sent = [];
  rec.respond = ({ text }) => {
    if (/AS plant_project_id/.test(text)) return [owned(stored)];
    if (/UPDATE event_log el/.test(text)) return [{ id: EVENT, event_type: body.event_type, event_date: body.event_date }];
    return [];
  };
  const res = await handler({
    requestContext: { http: { method: 'PUT' } },
    rawPath: `/api/events/${EVENT}`,
    headers: { authorization: 'Bearer stub-token' },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}'), sent: rec.sent };
}
const updates = (sent) => sent.filter((s) => /UPDATE event_log el/.test(s.text));

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

describe('eventDateBoundsError — the one helper, future allowance as an argument', () => {
  const now = Date.parse(NOW);
  it('keeps the three POST messages', () => {
    expect(eventDateBoundsError('not-a-date', now, 3600e3)).toEqual({ status: 400, error: 'event_date invalid' });
    expect(eventDateBoundsError('1900-01-01', now, 3600e3)).toEqual({ status: 400, error: 'event_date too far in past' });
    expect(eventDateBoundsError('2099-01-01', now, 3600e3)).toEqual({ status: 400, error: 'event_date in future' });
  });
  it('the future allowance is the caller\'s: 12h ahead fails at 1h, passes at the PUT\'s 24h', () => {
    const ahead = new Date(now + 12 * 3600e3).toISOString();
    expect(eventDateBoundsError(ahead, now, 3600e3)?.error).toBe('event_date in future');
    expect(eventDateBoundsError(ahead, now, PUT_FUTURE_BOUND_MS)).toBeNull();
    expect(PUT_FUTURE_BOUND_MS).toBe(24 * 3600e3);
  });
  it('now itself passes', () => {
    expect(eventDateBoundsError(NOW, now, 3600e3)).toBeNull();
  });
  it('POST and batch keep the 1h allowance: 12h ahead is refused by both (the PUT\'s 24h did not leak)', () => {
    const ahead = new Date(now + 12 * 3600e3).toISOString();
    expect(validatePostBody({ event_type: 'observation', project_id: 'proj-1', event_date: ahead })?.error)
      .toBe('event_date in future');
    expect(validateBatchBody({ idempotency_key: 'k', event_type: 'watering', scope: { type: 'all' }, event_date: ahead })?.error)
      .toBe('event_date in future');
  });
});

describe('PUT /api/events/:id — the bounds on a real date move', () => {
  it('moving an event to 1900 is refused before any write', async () => {
    const r = await put('2026-09-28T12:00:00.000Z', { event_type: 'observation', event_date: '1900-01-01' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('event_date too far in past');
    expect(updates(r.sent)).toEqual([]);
  });

  it('moving an event two days into the future is refused before any write', async () => {
    const r = await put('2026-09-28T12:00:00.000Z', { event_type: 'observation', event_date: '2026-10-17T12:00:00.000Z' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('event_date in future');
    expect(updates(r.sent)).toEqual([]);
  });

  // S6: the future bound is not gated on a 36h move, so stepping a date forward under 36h is caught.
  it('stored = now, PUT now+30h (a sub-36h step past the 24h allowance) is refused before any write', async () => {
    const r = await put(NOW, { event_type: 'observation', event_date: '2026-10-16T18:00:00.000Z' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('event_date in future');
    expect(updates(r.sent)).toEqual([]);
  });

  it('control: stored = now, PUT now+20h (inside the 24h allowance) saves', async () => {
    const r = await put(NOW, { event_type: 'observation', event_date: '2026-10-16T08:00:00.000Z' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(updates(r.sent)).toHaveLength(1);
  });

  it('an unparseable date keeps its existing 400', async () => {
    const r = await put('2026-09-28T12:00:00.000Z', { event_type: 'observation', event_date: 'garbage' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('event_date invalid');
  });

  it('control: an ordinary move inside the bounds still saves', async () => {
    const r = await put('2026-09-28T12:00:00.000Z', { event_type: 'observation', event_date: '2026-10-01T12:00:00.000Z' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(updates(r.sent)).toHaveLength(1);
  });

  it('control: moving an old event to today, noon local at UTC+14 just after midnight (~10h ahead), saves', async () => {
    // 00:01 on Oct 16 in Kiribati is 10:01Z on Oct 15; its noon local is 22:00Z, ~12h ahead of now.
    vi.setSystemTime(new Date('2026-10-15T10:01:00.000Z'));
    const r = await put('2026-10-01T12:00:00.000Z', { event_type: 'observation', event_date: '2026-10-15T22:00:00.000Z' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe('PUT /api/events/:id — no bounds when the date did not really move', () => {
  // The event was stored at noon UTC more than 5y ago. EventDetail re-sends noon LOCAL for the same
  // calendar day, which is a different instant in every non-UTC timezone.
  const STORED = '2019-06-01T12:00:00.000Z';

  it('a notes-only save re-sending noon-local from UTC-10 (22:00Z, +10h) is 200', async () => {
    const r = await put(STORED, { event_type: 'observation', event_date: '2019-06-01T22:00:00.000Z', notes: 'typo fixed' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(updates(r.sent)).toHaveLength(1);
  });

  it('a notes-only save re-sending noon-local from UTC+14 (22:00Z the day before, -14h) is 200', async () => {
    const r = await put(STORED, { event_type: 'observation', event_date: '2019-05-31T22:00:00.000Z', notes: 'typo fixed' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('a save re-sending the bare stored date is 200', async () => {
    const r = await put(STORED, { event_type: 'observation', event_date: '2019-06-01' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('but a real move of that old event to another old day is still refused', async () => {
    const r = await put(STORED, { event_type: 'observation', event_date: '2019-06-05' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('event_date too far in past');
  });
});
