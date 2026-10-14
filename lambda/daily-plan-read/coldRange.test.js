// V5-WXCOLDBAND-001 — readColdRange / shapeColdRange, EXECUTED against a recording sql stub.
// What a stub cannot prove (that the WHERE really refuses a partial or future row on Postgres) is
// pinned below by the statement text; the row rules themselves are the README's
// (migrations/v5-wxcoldband-001/README.md, "For the two lanes that follow").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readColdRange, shapeColdRange } from './coldRange.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeSql(rows = []) {
  const calls = [];
  const sql = (strings, ...params) => {
    calls.push({ text: strings.join('?'), params });
    return Promise.resolve(rows);
  };
  sql.calls = calls;
  return sql;
}

const ROW = {
  night_date: '2026-10-14',
  init_time: new Date('2026-10-14T00:00:00Z'),
  p10_min_f: '38.40',
  p50_min_f: '43.10',
  created_at: new Date('2026-10-14T10:05:00Z'),
};

describe('readColdRange', () => {
  it('serves the newest complete row for tonight, numbers as numbers', async () => {
    const sql = makeSql([ROW]);
    await expect(readColdRange(sql, ['user_dave', 'user_jen'])).resolves.toEqual({
      night_date: '2026-10-14',
      low_f: 38.4,
      mid_f: 43.1,
      init_time: '2026-10-14T00:00:00.000Z',
      wn3_generated_at: '2026-10-14T10:05:00.000Z',
    });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].params).toEqual([['user_dave', 'user_jen']]);
  });

  it('serves null when there is no row (the job did not run)', async () => {
    await expect(readColdRange(makeSql([]), ['user_dave'])).resolves.toBeNull();
  });

  it('never queries without an owner set', async () => {
    for (const ids of [[], null, undefined, 'user_dave']) {
      const sql = makeSql([ROW]);
      await expect(readColdRange(sql, ids)).resolves.toBeNull();
      expect(sql.calls).toHaveLength(0);
    }
  });

  it('lets a DB error through, so the handler can tell a failed read from no row', async () => {
    const sql = () => Promise.reject(new Error('relation "weather_cold_range" does not exist'));
    await expect(readColdRange(sql, ['user_dave'])).rejects.toThrow(/weather_cold_range/);
  });

  it('asks only for a complete row, for tonight in ET, run before the night began, newest first', async () => {
    const sql = makeSql([]);
    await readColdRange(sql, ['user_dave']);
    const text = sql.calls[0].text.replace(/\s+/g, ' ');
    expect(text).toMatch(/JOIN spaces s ON s\.id = w\.space_id/);
    expect(text).toMatch(/s\.created_by = ANY\(\?\)/);
    expect(text).toMatch(/w\.night_date = \(now\(\) AT TIME ZONE 'America\/New_York'\)::date/);
    expect(text).toMatch(/w\.leads_read = w\.leads_expected/);
    expect(text).toMatch(/w\.init_time <= now\(\)/);
    expect(text).toMatch(/w\.init_time < \(\(w\.night_date \+ time '18:00'\) AT TIME ZONE 'America\/New_York'\)/);
    expect(text).toMatch(/ORDER BY w\.init_time DESC, w\.created_at DESC LIMIT 1/);
    // The writer never sends created_at; the read serves it as the freshness stamp.
    expect(text).toMatch(/w\.created_at AS created_at/);
  });
});

describe('shapeColdRange', () => {
  it('keeps a row with no middle value', () => {
    expect(shapeColdRange({ ...ROW, p50_min_f: null })).toMatchObject({ low_f: 38.4, mid_f: null });
  });

  it('refuses a row it cannot trust, whole', () => {
    expect(shapeColdRange(undefined)).toBeNull();
    expect(shapeColdRange({ ...ROW, p10_min_f: null })).toBeNull();
    expect(shapeColdRange({ ...ROW, p10_min_f: 'NaN' })).toBeNull();
    expect(shapeColdRange({ ...ROW, p50_min_f: 'x' })).toBeNull();
    expect(shapeColdRange({ ...ROW, p50_min_f: '30.00' })).toBeNull();   // middle below the cold end
    expect(shapeColdRange({ ...ROW, night_date: new Date('2026-10-14') })).toBeNull();
    expect(shapeColdRange({ ...ROW, created_at: null })).toBeNull();
  });

  it('reads a negative and a zero low as numbers, not as missing', () => {
    expect(shapeColdRange({ ...ROW, p10_min_f: '0.00', p50_min_f: '2.00' }).low_f).toBe(0);
    expect(shapeColdRange({ ...ROW, p10_min_f: '-3.50', p50_min_f: null }).low_f).toBe(-3.5);
  });
});

describe('the handler wiring', () => {
  const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

  it('reads the range for the household, inside its own try/catch, after the plan is built', () => {
    const at = SRC.indexOf('readColdRange(sql, householdScope(userId))');
    expect(at).toBeGreaterThan(SRC.indexOf('const body = {'));
    const block = SRC.slice(SRC.lastIndexOf('try {', at), SRC.indexOf('body.cold_range = coldRange;', at));
    expect(block).toMatch(/catch \(e\) \{ console\.error\('cold-range read \(non-fatal\):'/);
  });

  it('adds no SQL to index.js, so the positional template guards in index.test.js stay put', () => {
    expect(SRC).not.toMatch(/weather_cold_range/);
  });
});
