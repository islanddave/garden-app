// BUG-SEEDSTAGETZSHIFT-001 — the instant a seed-lot stage entry is dated.
//
// THE DEFECT, as measured on prod 2026-09-17: the route cast SavedSeeds' zoneless `${when}T12:00:00`
// with `::timestamptz` in a GMT session, so every picked day landed at 12:00Z = 08:00 EDT. The
// intake row SaveSeedSheet writes seconds earlier gets now() — the afternoon — and the log is ordered
// entered_at DESC, so "save seed, then Move to stored" filed `stored` UNDER the intake row. Six live
// lots from 2026-09-07 carry it; their real timestamps are the fixture below.
//
// Every instant here is absolute (Z or a stated offset) and every ET reading goes through an explicit
// timeZone, so the file means the same thing under ci.yml's plain run and its TZ=America/New_York
// re-run. Nothing reads the wall clock except the two wire cases, which say so.
import { describe, it, expect, beforeEach } from 'vitest';
import { etDay, etNoon, resolveStageEnteredAt, ET_TZ } from './seed-stage-date.js';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Built from a STATED offset rather than from etNoon, so the fixtures do not lean on the function
// under test. Only used on days with no DST switch, where one offset holds all day.
const wallET = (ymd, h, mi, offsetH) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h + offsetH, mi));
};
const EDT_DAY = '2026-09-07'; // UTC-4 all day
const EST_DAY = '2026-12-07'; // UTC-5 all day

const etClock = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// The route's own ordering, restated: ORDER BY entered_at DESC, created_at DESC.
const routeOrder = (rows) => [...rows].sort((a, b) =>
  (Date.parse(b.entered_at) - Date.parse(a.entered_at)) || (Date.parse(b.created_at) - Date.parse(a.created_at)));

describe('etNoon — 12:00 America/New_York, under both offsets', () => {
  it.each([
    ['an EDT day', EDT_DAY, '2026-09-07T16:00:00.000Z'],
    ['an EST day', EST_DAY, '2026-12-07T17:00:00.000Z'],
    ['spring-forward day (switch at 02:00, EDT by noon)', '2026-03-08', '2026-03-08T16:00:00.000Z'],
    ['the day before spring-forward', '2026-03-07', '2026-03-07T17:00:00.000Z'],
    ['fall-back day (switch at 02:00, EST by noon)', '2026-11-01', '2026-11-01T17:00:00.000Z'],
    ['the day before fall-back', '2026-10-31', '2026-10-31T16:00:00.000Z'],
  ])('%s', (_label, ymd, iso) => {
    expect(etNoon(ymd).toISOString()).toBe(iso);
  });

  it('is noon on the same ET calendar day for every day of 2026 and 2027', () => {
    // The six cases above pin the arithmetic; this pins the invariant across both years' switches.
    let checked = 0;
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 24 * HOUR) {
      const ymd = new Date(t).toISOString().slice(0, 10);
      const at = etNoon(ymd);
      expect(etDay(at), ymd).toBe(ymd);
      expect(etClock.format(at), ymd).toBe('12:00:00');
      checked += 1;
    }
    expect(checked).toBe(730);
  });
});

describe('resolveStageEnteredAt — a day entered at any hour Eastern', () => {
  for (const [label, day, prevDay, offset, prevNoonIso] of [
    ['EDT', EDT_DAY, '2026-09-06', 4, '2026-09-06T16:00:00.000Z'],
    ['EST', EST_DAY, '2026-12-06', 5, '2026-12-06T17:00:00.000Z'],
  ]) {
    it(`${label}: today, at every hour 00:00-23:59 ET, is the request instant and stays on that ET day`, () => {
      for (let h = 0; h < 24; h += 1) {
        for (const mi of [0, 59]) {
          const now = wallET(day, h, mi, offset);
          for (const wire of [`${day}T12:00:00`, day]) {
            const { at } = resolveStageEnteredAt(wire, now);
            expect(at, `${wire} @ ${h}:${mi} ET`).toBe(now.toISOString());
            expect(etDay(new Date(at))).toBe(day);
          }
        }
      }
    });

    it(`${label}: an earlier day, entered at any hour, is noon ET on that day`, () => {
      for (let h = 0; h < 24; h += 1) {
        const { at } = resolveStageEnteredAt(`${prevDay}T12:00:00`, wallET(day, h, 30, offset));
        expect(at).toBe(prevNoonIso);
        expect(etDay(new Date(at))).toBe(prevDay);
        expect(etClock.format(new Date(at))).toBe('12:00:00');
      }
    });
  }

  it('decides "today" in Eastern, not UTC: 23:30 EDT is already tomorrow in UTC', () => {
    // 2026-09-07 23:30 EDT = 2026-09-08 03:30Z. A UTC day test would call Sep 7 "yesterday" and file
    // it at noon, under an intake row written at 23:29.
    const now = wallET(EDT_DAY, 23, 30, 4);
    expect(now.toISOString().slice(0, 10)).toBe('2026-09-08');
    expect(resolveStageEnteredAt(`${EDT_DAY}T12:00:00`, now).at).toBe(now.toISOString());
  });

  it('a phone past its own midnight sends a day Eastern has not reached: noon ET, inside the 48h tolerance', () => {
    // A UTC+14 phone at 00:00 on Sep 8 is 06:00 EDT on Sep 7 — the largest genuine lead the route's
    // future-date tolerance has to clear.
    const now = wallET(EDT_DAY, 6, 0, 4);
    const { at } = resolveStageEnteredAt('2026-09-08T12:00:00', now);
    expect(at).toBe('2026-09-08T16:00:00.000Z');
    expect(Date.parse(at) - now.getTime()).toBe(30 * HOUR);
  });
});

describe('same-day ordering — intake first, then the stage', () => {
  // Live prod, 2026-09-07 (read-only query 2026-09-17). intake = the row SaveSeedSheet wrote with
  // entered_at omitted (DB now()); request = created_at of the follow-up stage row.
  const PROD_0907 = [
    ['Carolina Reaper ad59d62e',        'drying',     'stored', '2026-09-07T16:30:16Z', '2026-09-07T16:30:25Z'],
    ['Dill 7ae3e712',                   'drying',     'stored', '2026-09-07T17:21:00Z', '2026-09-07T17:21:05Z'],
    ['Green Flesh Honeydew bf6331d0',   'drying',     'stored', '2026-09-07T17:22:47Z', '2026-09-07T17:22:57Z'],
    ['Purple Peach Ghost ea6a760d',     'drying',     'stored', '2026-09-07T16:34:59Z', '2026-09-07T16:35:43Z'],
    ['Rosso Sicilian ef4ae33d',         'fermenting', 'drying', '2026-09-07T16:28:40Z', '2026-09-07T16:28:55Z'],
    ['Wiri Wiri a1ea0ee4',              'drying',     'stored', '2026-09-07T16:31:44Z', '2026-09-07T16:32:40Z'],
  ];

  it.each(PROD_0907)('%s: the %s intake stays under the %s entry made seconds later', (_lot, intakeStage, stage, intakeAt, requestAt) => {
    // Non-vacuous: the fixture is one the zoneless cast got WRONG. If this ever stops holding, the
    // assertions below prove nothing about the defect.
    expect(Date.parse(`${EDT_DAY}T12:00:00Z`)).toBeLessThan(Date.parse(intakeAt));

    const { at } = resolveStageEnteredAt(`${EDT_DAY}T12:00:00`, new Date(requestAt));
    expect(Date.parse(at)).toBeGreaterThan(Date.parse(intakeAt));
    const head = routeOrder([
      { stage: intakeStage, entered_at: intakeAt, created_at: intakeAt },
      { stage, entered_at: at, created_at: requestAt },
    ])[0];
    expect(head.stage).toBe(stage);
  });

  it('Rosso Sicilian: fermenting -> drying -> stored inside 26 seconds reads back in that order', () => {
    const t0 = '2026-09-07T16:28:40Z';
    const rows = [{ stage: 'fermenting', entered_at: t0, created_at: t0 }];
    for (const [stage, requestAt] of [['drying', '2026-09-07T16:28:55Z'], ['stored', '2026-09-07T16:29:06Z']]) {
      rows.push({ stage, entered_at: resolveStageEnteredAt(`${EDT_DAY}T12:00:00`, new Date(requestAt)).at, created_at: requestAt });
    }
    expect(routeOrder(rows).map(r => r.stage)).toEqual(['stored', 'drying', 'fermenting']);
  });

  for (const [label, day, offset] of [['EDT', EDT_DAY, 4], ['EST', EST_DAY, 5]]) {
    it(`${label}: an intake at any hour ET, then a stage a minute later, heads the log`, () => {
      for (let h = 0; h < 24; h += 1) {
        const intakeAt = wallET(day, h, 58, offset).toISOString();
        const request = wallET(day, h, 59, offset);
        const { at } = resolveStageEnteredAt(`${day}T12:00:00`, request);
        const head = routeOrder([
          { stage: 'drying', entered_at: intakeAt, created_at: intakeAt },
          { stage: 'stored', entered_at: at, created_at: request.toISOString() },
        ])[0];
        expect(head.stage, `${h}:58 ET intake`).toBe('stored');
      }
    });
  }
});

describe('resolveStageEnteredAt — the shapes that are not a picked day', () => {
  const now = wallET(EDT_DAY, 14, 0, 4);

  it('absent stays absent, so the column default now() applies exactly as before', () => {
    expect(resolveStageEnteredAt(undefined, now)).toEqual({ at: null });
    expect(resolveStageEnteredAt(null, now)).toEqual({ at: null });
  });

  it('a full instant passes through as the same instant, re-emitted in UTC', () => {
    expect(resolveStageEnteredAt('2026-09-01T09:15:00Z', now).at).toBe('2026-09-01T09:15:00.000Z');
    expect(resolveStageEnteredAt('2026-09-01T09:15:00-04:00', now).at).toBe('2026-09-01T13:15:00.000Z');
  });

  it('a zoneless time that is not the noon marker parses exactly as it did before', () => {
    // Not a day marker, so not this fix's to reinterpret: runtime-zone parse, as the old code did.
    const wire = '2026-09-01T08:30:00';
    expect(resolveStageEnteredAt(wire, now).at).toBe(new Date(wire).toISOString());
  });

  it.each(['yesterday-ish', '', '2026-02-30', '2026-02-30T12:00:00', '2026-13-01', '2026-09-31T12:00'])(
    'refuses %j as invalid rather than letting Postgres 500 on it', (wire) => {
      expect(resolveStageEnteredAt(wire, now)).toEqual({ invalid: true });
    });
});

describe('POST /:id/seed-stage binds the resolved instant, never the zoneless literal', () => {
  const USER = 'user_stub_owner';
  const ITEM = '2d6df841-b507-4e65-8db0-97c8659df37c';
  const stagePost = (body) => ({
    requestContext: { http: { method: 'POST' } },
    rawPath: `/api/inventory-items/${ITEM}/seed-stage`,
    headers: { authorization: 'Bearer stub-token' },
    body: JSON.stringify(body),
  });
  // The value bound into `COALESCE(?::timestamptz, NOW())`. The stub joins the template on '?', so a
  // placeholder's value is indexed by the count of '?' before it.
  const boundEnteredAt = (call) => {
    const i = call.text.indexOf('COALESCE(?::timestamptz, NOW())');
    expect(i, 'the INSERT no longer binds entered_at through COALESCE').toBeGreaterThan(-1);
    return call.values[(call.text.slice(0, i + 'COALESCE('.length).match(/\?/g) ?? []).length];
  };

  beforeEach(() => {
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
    stubState.sqlHandler = () => [{ id: 'log-1', inventory_item_id: ITEM, stage: 'stored' }];
  });

  it('an earlier day is bound as noon Eastern on it', async () => {
    const res = await handler(stagePost({ stage: 'stored', entered_at: '2026-09-01T12:00:00' }));
    expect(res.statusCode).toBe(201);
    expect(stubState.sqlCalls).toHaveLength(1);
    expect(boundEnteredAt(stubState.sqlCalls[0])).toBe('2026-09-01T16:00:00.000Z');
  });

  it("today's Eastern day is bound as the request instant (reads the wall clock)", async () => {
    // Retried once if Eastern midnight falls inside the call — the only way the day under test can
    // change between choosing it and the handler resolving it.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = () => [{ id: 'log-1' }];
      const before = Date.now();
      const today = etDay(new Date(before));
      const res = await handler(stagePost({ stage: 'stored', entered_at: `${today}T12:00:00` }));
      const after = Date.now();
      if (etDay(new Date(after)) !== today) continue;
      expect(res.statusCode).toBe(201);
      const bound = boundEnteredAt(stubState.sqlCalls[0]);
      expect(bound).toMatch(/Z$/);
      expect(Date.parse(bound)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(bound)).toBeLessThanOrEqual(after);
      return;
    }
    throw new Error('Eastern midnight fell inside both attempts');
  });

  it('a day Eastern has not reached is accepted, not refused as future (the tolerance is load-bearing)', async () => {
    // Tomorrow in Eastern resolves to its noon ET: 12-36h ahead of server now, whatever the hour. A
    // strict `> now` future check refuses this; it is what a phone past its own midnight sends.
    // Calendar arithmetic, not now + 24h: the fall-back day is 25 hours long. Same midnight retry as
    // the case above.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = () => [{ id: 'log-1' }];
      const today = etDay(new Date());
      const [y, m, d] = today.split('-').map(Number);
      const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
      const res = await handler(stagePost({ stage: 'stored', entered_at: `${tomorrow}T12:00:00` }));
      if (etDay(new Date()) !== today) continue;
      expect(JSON.parse(res.body).error).toBeUndefined();
      expect(res.statusCode).toBe(201);
      // Ahead of now by construction: noon tomorrow is after midnight tonight, which is after now.
      expect(boundEnteredAt(stubState.sqlCalls[0])).toBe(etNoon(tomorrow).toISOString());
      return;
    }
    throw new Error('Eastern midnight fell inside both attempts');
  });

  it('a calendar-invalid day is a named 400 and writes nothing', async () => {
    const res = await handler(stagePost({ stage: 'stored', entered_at: '2026-02-30T12:00:00' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('entered_at must be a valid date');
    expect(stubState.sqlCalls).toHaveLength(0);
  });
});
