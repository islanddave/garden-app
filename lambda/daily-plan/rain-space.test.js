// BUG-AUTHZLAMBDA-001 — the rain auto-logger, per Space, driven through run().
//
// rain-live-filter.test.js (the writer's owner pass) proves what the rain INSERT and the day cap admit.
// This file proves what run() hands them and in what order, with several Spaces: each Space reads its own
// weather_daily row, is capped on its own, and writes with its own id and its own household; a Space with
// no row (no coordinates) or no owner is skipped without a write; the two cache upserts run once per
// invocation; and there is one rain-log line per invocation, whatever the Space count.
import { describe, it, expect, vi, afterEach } from 'vitest';
import h from './handler.js';

const { run } = h;

const TODAY = '2026-06-20';
const DAY = '2026-06-19';
const A = '5a000000-0000-4000-8000-00000000000a';
const B = '5a000000-0000-4000-8000-00000000000b';
const INDOOR = '00000000-0000-0000-0000-000000000000';   // a real "Indoor" Space may land with no coordinates
const DAVE = 'user_dave';
const JEN = 'user_jen';
const OTHER = 'user_other_house';
const GAUGE = (precip_in) => ({ precip_in, precip_source: 'gauge_merged' });

const space = (id, created_by, coords = true) => ({ id, postal_code: null, created_by,
  weather_lat: coords ? 42.5 : null, weather_lng: coords ? -72.6 : null });

const isRainRead = (sql) => /select precip_in, precip_source from weather_daily/i.test(sql);
const isCap = (sql) => /from event_log e\s+left join garden_node n/i.test(sql);
const isRainInsert = (sql) => /^\s*insert into event_log/i.test(sql);
const isCache = (sql) => /into entity_memory/i.test(sql);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// wx: space id -> the weather_daily row its rain read returns (absent = no row).
// capped: the Space ids whose cap finds hand-logged rain. wrote: rowCount the INSERT reports per Space.
// `env` absent = the full household; `env: undefined` = the key unset.
async function drive({ spaces, wx = {}, capped = [], wrote = {}, dryRun = false, ...o }) {
  vi.stubEnv('GARDEN_HOUSEHOLD_IDS', 'env' in o ? o.env : `${DAVE},${JEN}`);
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const calls = [];
  const pg = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (isRainRead(sql)) return { rows: wx[params[1]] ? [wx[params[1]]] : [] };
      if (/weather_daily/.test(sql)) return { rows: [] };
      if (isCap(sql)) return { rows: capped.includes(params[1]) ? [{ '?column?': 1 }] : [] };
      if (isRainInsert(sql)) return { rows: [], rowCount: wrote[params[3]] ?? 3 };
      if (/from plants/.test(sql)) return { rows: [] };
      if (/from spaces/.test(sql)) return { rows: spaces };
      return { rows: [] };
    }),
  };
  await run({ pg, today: TODAY, dryRun, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 60, highToday: 82, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => null, fetchStation: async () => null, publishAlert: async () => ({ messageId: 'x' }),
    etHour: 2, event: { rainLog: true } });
  const lines = spy.mock.calls.map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { calls, rainLog: lines.filter((l) => l.msg === 'rain-log') };
}
const of = (calls, test) => calls.filter((c) => test(c.sql));

describe('each Space reads its own row and writes its own household', () => {
  it('two Spaces in two households: one read, one cap and one insert per Space, each with its own id and members', async () => {
    const { calls } = await drive({ spaces: [space(A, DAVE), space(B, OTHER)], wx: { [A]: GAUGE(0.4), [B]: GAUGE(0.3) } });
    expect(of(calls, isRainRead).map((c) => c.params)).toEqual([[DAY, A], [DAY, B]]);
    expect(of(calls, isCap).map((c) => c.params)).toEqual([[DAY, A, [DAVE, JEN]], [DAY, B, [OTHER]]]);
    const ins = of(calls, isRainInsert);
    expect(ins).toHaveLength(2);
    expect(ins.map((c) => [c.params[0], c.params[1], c.params[3], c.params[4]])).toEqual([
      [DAY, 0.4, A, [DAVE, JEN]],
      [DAY, 0.3, B, [OTHER]],
    ]);
  });

  it('a Space\'s own row decides for it: a dry Space next to a wet one writes nothing', async () => {
    const { calls, rainLog } = await drive({ spaces: [space(A, DAVE), space(B, OTHER)], wx: { [A]: GAUGE(0.05), [B]: GAUGE(0.3) } });
    expect(of(calls, isRainInsert).map((c) => c.params[3])).toEqual([B]);
    // ...and the dry Space never reached the cap: the decision comes first (droughtsignal.test.js).
    expect(of(calls, isCap).map((c) => c.params[1])).toEqual([B]);
    expect(rainLog[0].spaces).toEqual([
      { space_id: A, logged: 0, skipped: 'below_threshold', amount_in: 0.05 },
      { space_id: B, logged: 3, amount_in: 0.3 },
    ]);
  });

  it('a Space with no coordinates and no row (the Indoor Space) is skipped quietly; the others still log', async () => {
    const { calls, rainLog } = await drive({ spaces: [space(INDOOR, DAVE, false), space(A, DAVE)], wx: { [A]: GAUGE(0.4) } });
    expect(of(calls, isRainInsert).map((c) => c.params[3])).toEqual([A]);
    expect(rainLog).toHaveLength(1);
    expect(rainLog[0].spaces[0]).toEqual({ space_id: INDOOR, logged: 0, skipped: 'no_weather_row', amount_in: null });
  });

  it('an unowned Space is skipped before any read and writes nothing', async () => {
    const { calls, rainLog } = await drive({ spaces: [space(A, null), space(B, '  ')], wx: { [A]: GAUGE(0.4), [B]: GAUGE(0.4) } });
    expect(of(calls, isRainRead)).toHaveLength(0);
    expect(of(calls, isRainInsert)).toHaveLength(0);
    expect(rainLog[0]).toEqual(expect.objectContaining({ logged: 0, skipped: 'space_owner_missing' }));
  });

  it('an env-less run still writes each Space\'s OWNER (fail closed, never open)', async () => {
    const { calls } = await drive({ spaces: [space(A, DAVE)], wx: { [A]: GAUGE(0.4) }, env: undefined });
    expect(of(calls, isRainInsert)[0].params[4]).toEqual([DAVE]);
  });
});

describe('the cap is per Space: no Space suppresses another', () => {
  it('hand-logged rain in one Space skips that Space only', async () => {
    const { calls, rainLog } = await drive({ spaces: [space(A, DAVE), space(B, OTHER)], wx: { [A]: GAUGE(0.4), [B]: GAUGE(0.4) }, capped: [A] });
    expect(of(calls, isRainInsert).map((c) => c.params[3])).toEqual([B]);
    expect(rainLog[0].spaces[0]).toEqual({ space_id: A, logged: 0, skipped: 'already_logged', amount_in: 0.4 });
  });

  it('a dry run reads and caps each Space but writes nothing', async () => {
    const { calls, rainLog } = await drive({ spaces: [space(A, DAVE), space(B, OTHER)], wx: { [A]: GAUGE(0.4), [B]: GAUGE(0.4) }, dryRun: true });
    expect(of(calls, isRainRead)).toHaveLength(2);
    expect(of(calls, isRainInsert)).toHaveLength(0);
    expect(rainLog[0]).toEqual(expect.objectContaining({ logged: 0, skipped: 'dry_run' }));
  });
});

describe('once per invocation: the cache upserts and the rain-log line', () => {
  it('two Spaces writing: exactly two cache upserts, after every insert, and ONE rain-log line with the total', async () => {
    const { calls, rainLog } = await drive({ spaces: [space(A, DAVE), space(B, OTHER)], wx: { [A]: GAUGE(0.4), [B]: GAUGE(0.3) }, wrote: { [A]: 5, [B]: 2 } });
    const cache = of(calls, isCache);
    expect(cache).toHaveLength(2);
    const lastInsert = calls.map((c) => c.sql).findLastIndex(isRainInsert);
    expect(calls.findIndex((c) => isCache(c.sql))).toBeGreaterThan(lastInsert);
    expect(rainLog).toHaveLength(1);
    expect(rainLog[0]).toEqual(expect.objectContaining({ day: DAY, logged: 7 }));
    expect(rainLog[0].skipped).toBeUndefined();
  });

  it('a later run in the window inserts nothing and leaves the cache alone', async () => {
    const { calls, rainLog } = await drive({ spaces: [space(A, DAVE)], wx: { [A]: GAUGE(0.4) }, wrote: { [A]: 0 } });
    expect(of(calls, isRainInsert)).toHaveLength(1);
    expect(of(calls, isCache)).toHaveLength(0);
    expect(rainLog).toHaveLength(1);
    expect(rainLog[0]).toEqual(expect.objectContaining({ logged: 0, skipped: 'already_credited' }));
  });

  it('no Spaces at all: one line, nothing read', async () => {
    const { calls, rainLog } = await drive({ spaces: [] });
    expect(of(calls, isRainRead)).toHaveLength(0);
    expect(rainLog).toEqual([expect.objectContaining({ logged: 0, skipped: 'no_spaces' })]);
  });
});
