// V5-SPACESENTINELDOC-001 (multi-space Phase 1, step 1.9) — the rain cap after the fold.
//
// migrations/v5-spacefk-001/0a-fold.sql moves ten containers from the nil workspace onto the one Space. The
// rain logger's once-a-day cap (handler.js, `{ rows: already }`) reads a CONTAINER's workspace_id for a rain
// row logged on a container with no planting: `coalesce(n.workspace_id, c.workspace_id) = $2`. Before the
// fold such a row on one of the ten names no Space and never caps a day; after it, it caps the Space's day
// like a container-level rain on any other container (review RIA I4). This is the intended behaviour change,
// stated in the migration README; prod held no such row on 2026-10-16 (read-only count: 0).
//
// rain-space.test.js mocks the cap's answer per Space. Here the mock EVALUATES the cap: it reads the Space
// term and the joins out of the statement run() actually sends, and applies them to fixture rows (events,
// plantings, containers). A statement in a shape this model does not know throws, so a rewrite of the cap
// is a change to re-model here, never a silent pass. rain-live-filter.test.js proves the rest of the cap's
// WHERE by truth table.
import { describe, it, expect, vi, afterEach } from 'vitest';
import h from './handler.js';

const { run } = h;

const TODAY = '2026-06-20';
const DAY = '2026-06-19';
const SPACE = '00000000-0000-0000-0000-000000000001';
const NIL = '00000000-0000-0000-0000-000000000000';
const MAPLE = 'a08de1c6-da94-445b-85e7-f20c4a967ce2';   // one of the ten (Japanese Maple, outdoors)
const MAPLE_TREE = 'a08de1c6-0000-4000-8000-0000000000a1';
const DAVE = 'user_dave';
const JEN = 'user_jen';
const GAUGE = (precip_in) => ({ precip_in, precip_source: 'gauge_merged' });

const flat = (sql) => sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const isRainRead = (sql) => /select precip_in, precip_source from weather_daily/i.test(sql);
const isCap = (sql) => /from event_log e\s+left join garden_node n/i.test(sql);
const isRainInsert = (sql) => /^\s*insert into event_log/i.test(sql);

// The cap, evaluated. The joins and every term are read from the statement; the Space term may be any
// `x.workspace_id` or a coalesce of them over the two joined rows.
function evalCap(sql, [day, spaceId, members], db) {
  const f = flat(sql);
  const need = [
    'left join garden_node n on n.id = e.plant_id',
    'left join container c on c.id = (case when e.plant_id is null then e.project_id else n.container_id end)',
    "e.event_type = 'rain'", 'e.deleted_at is null', 'e.event_date::date = $1',
    "e.metadata->>'precip_source' is null",
    '(c.created_by = any($3::text[]) or (c.id is null and n.created_by = any($3::text[])))',
  ];
  for (const t of need) if (!f.includes(t)) throw new Error(`the rain cap no longer reads "${t}": re-model rain-cap-fold.test.js`);
  const m = f.match(/ and ((?:coalesce\s*\(\s*[nc]\.workspace_id(?:\s*,\s*[nc]\.workspace_id)*\s*\))|[nc]\.workspace_id) = \$2::uuid/);
  if (!m) throw new Error('the rain cap carries no Space term this model can read');
  const cols = [...m[1].matchAll(/([nc])\.workspace_id/g)].map((x) => x[1]);
  const spaceOf = (row) => cols.map((a) => row[a]?.workspace_id ?? null).find((v) => v != null) ?? null;
  return db.events.some((e) => {
    const n = e.plant_id ? db.nodes[e.plant_id] ?? null : null;
    const cid = e.plant_id == null ? e.project_id : n?.container_id;
    const c = cid ? db.containers[cid] ?? null : null;
    const owner = c ? members.includes(c.created_by) : Boolean(n && members.includes(n.created_by));
    return e.event_type === 'rain' && !e.deleted_at && e.date === day && e.precip_source == null
      && spaceOf({ n, c }) === spaceId && owner;
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// One Space, Dave's, wet: the gauge would log rain unless the cap finds hand-logged rain for the day.
async function drive({ db, mutateCap = (s) => s }) {
  vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${DAVE},${JEN}`);
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const calls = [];
  const pg = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (isRainRead(sql)) return { rows: [GAUGE(0.4)] };
      if (/weather_daily/.test(sql)) return { rows: [] };
      if (isCap(sql)) return { rows: evalCap(mutateCap(sql), params, db) ? [{ '?column?': 1 }] : [] };
      if (isRainInsert(sql)) return { rows: [], rowCount: 3 };
      if (/from plants/.test(sql)) return { rows: [] };
      if (/from spaces/.test(sql)) {
        return { rows: [{ id: SPACE, postal_code: null, created_by: DAVE, weather_lat: 42.5, weather_lng: -72.6 }] };
      }
      return { rows: [] };
    }),
  };
  await run({ pg, today: TODAY, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 60, highToday: 82, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => null, fetchStation: async () => null, publishAlert: async () => ({ messageId: 'x' }),
    etHour: 2, event: { rainLog: true } });
  const lines = spy.mock.calls.map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { calls, rainLog: lines.filter((l) => l.msg === 'rain-log') };
}

// The Maple container (one of the ten) carrying `ws`, its one planting on the Space, and one rain event.
function world(ws, event) {
  return {
    containers: { [MAPLE]: { id: MAPLE, workspace_id: ws, created_by: DAVE } },
    nodes: { [MAPLE_TREE]: { id: MAPLE_TREE, workspace_id: SPACE, container_id: MAPLE, created_by: DAVE } },
    events: [{ event_type: 'rain', date: DAY, deleted_at: null, precip_source: null, ...event }],
  };
}
const CONTAINER_RAIN = { plant_id: null, project_id: MAPLE };       // hand-logged on the container itself
const PLANTING_RAIN = { plant_id: MAPLE_TREE, project_id: MAPLE };  // hand-logged on the planting
const capped = ({ calls, rainLog }) => ({
  inserts: calls.filter((c) => isRainInsert(c.sql)).length,
  space: rainLog[0].spaces[0],
});

describe('the fold and the rain cap: a container-level hand-logged rain on one of the ten', () => {
  it('before the fold (container on the nil workspace) it caps nothing: the gauge logs the day', async () => {
    const r = capped(await drive({ db: world(NIL, CONTAINER_RAIN) }));
    expect(r.inserts).toBe(1);
    expect(r.space).toEqual({ space_id: SPACE, logged: 3, amount_in: 0.4 });
  });

  it('after the fold (container on the Space) it caps the Space\'s day, as on every other container', async () => {
    const r = capped(await drive({ db: world(SPACE, CONTAINER_RAIN) }));
    expect(r.inserts).toBe(0);
    expect(r.space).toEqual({ space_id: SPACE, logged: 0, skipped: 'already_logged', amount_in: 0.4 });
  });

  it('a hand-logged rain on the PLANTING caps the day either way (the planting was always on the Space)', async () => {
    for (const ws of [NIL, SPACE]) {
      const r = capped(await drive({ db: world(ws, PLANTING_RAIN) }));
      expect(r.space.skipped, `container on ${ws}`).toBe('already_logged');
    }
  });

  it('an auto-logged container rain (precip_source set) does not cap the day, folded or not', async () => {
    for (const ws of [NIL, SPACE]) {
      const r = capped(await drive({ db: world(ws, { ...CONTAINER_RAIN, precip_source: 'gauge_merged' }) }));
      expect(r.inserts, `container on ${ws}`).toBe(1);
    }
  });

  it('the model reads the statement\'s own Space term (mutants change the answer)', async () => {
    // Planting's Space only: the folded container's row no longer caps.
    const nOnly = (s) => s.replace(/coalesce\(n\.workspace_id, c\.workspace_id\)/, 'n.workspace_id');
    expect(capped(await drive({ db: world(SPACE, CONTAINER_RAIN), mutateCap: nOnly })).inserts).toBe(1);
    // Container's Space only: before the fold even a planting-level row stops capping.
    const cOnly = (s) => s.replace(/coalesce\(n\.workspace_id, c\.workspace_id\)/, 'c.workspace_id');
    expect(capped(await drive({ db: world(NIL, PLANTING_RAIN), mutateCap: cOnly })).inserts).toBe(1);
    // A shape the model does not know throws rather than passing (the handler would swallow the throw
    // into its rain-log line, so this reads the statement run() sent and evaluates it directly).
    const { calls } = await drive({ db: world(SPACE, CONTAINER_RAIN) });
    const cap = calls.find((c) => isCap(c.sql));
    expect(evalCap(cap.sql, cap.params, world(SPACE, CONTAINER_RAIN))).toBe(true);
    const drop = cap.sql.replace(/and coalesce\(n\.workspace_id, c\.workspace_id\) = \$2::uuid/, '');
    expect(drop).not.toBe(cap.sql);
    expect(() => evalCap(drop, cap.params, world(SPACE, CONTAINER_RAIN))).toThrow(/Space term/);
    const noOwner = cap.sql.replace('c.created_by = any($3::text[]) or ', '');
    expect(() => evalCap(noOwner, cap.params, world(SPACE, CONTAINER_RAIN))).toThrow(/no longer reads/);
  });
});
