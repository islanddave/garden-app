// DRG-NIGHTLYTIMEOUT-001 — nightly 30s timeout fix.
// (a) Static source guard that every external fetch in index.js carries an AbortSignal bound and the
//     null-fallback catches survive (index.js pulls AWS/neon at module load so the unit suite cannot
//     import it — same constraint that put resolveInvokeOptions in handler.js; mirrors
//     archived-exclusion.test.js). The DB Pool must stay UNBOUNDED (cold-resume is waited out).
// (b) Behavioral: a timed-out (AbortError/TimeoutError) geocode degrades to null weather/hydrology
//     instead of crashing the run (the new guards in weatherForSpace/hydrologyForSpace).
// (c) Behavioral: run() emits the progress markers (db-ready / station-fetched / space-wx) with ms.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import h from './handler.js';
const { run, weatherForSpace, hydrologyForSpace } = h;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const fnBody = (name) => {
  const i = SRC.indexOf(`async function ${name}`);
  expect(i, `async function ${name} present in index.js`).toBeGreaterThan(-1);
  const j = SRC.indexOf('async function', i + 1);
  return SRC.slice(i, j === -1 ? undefined : j);
};
// AbortError as undici/node20 fetch rejects it on AbortSignal.timeout expiry.
const timeoutErr = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('index.js per-fetch bounds (static source guard)', () => {
  it('geocodeZip bounded at 4000ms', () => {
    expect(fnBody('geocodeZip')).toContain('AbortSignal.timeout(4000)');
  });
  it('both fetchNWS requests + inner Open-Meteo bounded at 6000ms; null-fallback catch survives', () => {
    const b = fnBody('fetchNWS');
    expect(b.match(/AbortSignal\.timeout\(6000\)/g)?.length).toBe(3);
    expect(b).toMatch(/catch[\s\S]*return null/);
  });
  it('fetchPrecip (Open-Meteo hydrology) bounded at 6000ms; null-fallback catch survives', () => {
    const b = fnBody('fetchPrecip');
    expect(b).toContain('AbortSignal.timeout(6000)');
    expect(b).toMatch(/catch[\s\S]*return null/);
  });
  it('fetchStation stays bounded (awnGet 8000ms) with its null-fallback catch', () => {
    expect(SRC).toContain('AbortSignal.timeout(8000)');
    expect(fnBody('fetchStation')).toMatch(/catch[\s\S]*return null/);
  });
  it('DB Pool stays UNBOUNDED — no connect/query timeout on the Neon Pool (cold-resume must be waited out)', () => {
    expect(SRC).toMatch(/new Pool\(\{ connectionString: NEON_DATABASE_URL \}\)/);
  });
  it('A0.2-EVENT-OVERRIDES sentinel is intact (rerun-daily-plan.sh greps for it)', () => {
    expect(SRC).toContain('A0.2-EVENT-OVERRIDES sentinel');
  });
});

describe('bounded-timeout degrade paths (never a new crash)', () => {
  const noLoc = { weather_lat: null, weather_lng: null, postal_code: '01341' };
  it('weatherForSpace: geocode AbortError -> null weather, no throw', async () => {
    await expect(weatherForSpace(noLoc, {
      geocodeZip: async () => { throw timeoutErr(); },
      fetchNWS: async () => { throw new Error('must not be reached'); },
    })).resolves.toBeNull();
  });
  it('hydrologyForSpace: geocode AbortError -> null hydrology, no throw', async () => {
    await expect(hydrologyForSpace(noLoc, {
      geocodeZip: async () => { throw timeoutErr(); },
      fetchPrecip: async () => { throw new Error('must not be reached'); },
    })).resolves.toBeNull();
  });
  it('weatherForSpace: cached coords unaffected by the guard (happy path intact)', async () => {
    const wx = { tonightLow: 40, highToday: 70, code: 1, unit: 'F', short: 'Sunny' };
    await expect(weatherForSpace(
      { weather_lat: 42.5, weather_lng: -72.6, postal_code: '01341' },
      { geocodeZip: async () => { throw new Error('should not geocode'); }, fetchNWS: async () => wx },
    )).resolves.toEqual(wx);
  });
});

describe('run() progress markers', () => {
  afterEach(() => vi.restoreAllMocks());
  it('emits db-ready -> station-fetched -> space-wx with elapsed ms', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pg = {
      query: vi.fn(async (sql) => sql.includes('from spaces')
        ? { rows: [{ id: 'sp1', postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] }
        : { rows: [] }),
    };
    const res = await run({
      pg, today: '2026-07-22', dryRun: true,
      geocodeZip: async () => { throw timeoutErr(); },
      fetchNWS: async () => null, fetchPrecip: async () => null, fetchStation: async () => null,
    });
    expect(res.rows).toBe(0);
    expect(pg.query).toHaveBeenCalledTimes(2); // dry run: no upsert
    const msgs = spy.mock.calls
      .map(([l]) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const byMsg = Object.fromEntries(msgs.map((m) => [m.msg, m]));
    expect(byMsg['db-ready']).toBeTruthy();
    expect(byMsg['db-ready'].ms).toBeTypeOf('number');
    expect(byMsg['db-ready'].rows).toBe(0);
    expect(byMsg['station-fetched']).toMatchObject({ present: false });
    expect(byMsg['station-fetched'].ms).toBeTypeOf('number');
    expect(byMsg['space-wx']).toMatchObject({ space: 'sp1', wx: false, hy: false });
    expect(byMsg['space-wx'].ms).toBeTypeOf('number');
    const order = msgs.map((m) => m.msg);
    expect(order.indexOf('db-ready')).toBeLessThan(order.indexOf('station-fetched'));
    expect(order.indexOf('station-fetched')).toBeLessThan(order.indexOf('space-wx'));
  });
});
