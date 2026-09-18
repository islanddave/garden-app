// V5-COLDCARDREACHABLE-001 — the heated SEAM: handler.js SELECT alias -> engine.coldFor's read.
//
// coldcardreachable.test.js proves what coldFor does with `heated_resolved`. Nothing there proves the
// handler ever hands it that key: a typo'd alias, or a projection dropped in a refactor, would leave
// every heated plant carded forever with the whole suite green — the engine's `=== true` fails safe,
// which is exactly what makes the break invisible. So:
//   (1) the alias is read out of the statement the DRIVER RECEIVES (same capture harness as
//       cover-inherit.test.js), flag OFF and ON, never out of the file's text;
//   (2) that captured alias — not a hardcoded key — is what the fixture row carries through the real
//       run() into the stored plan, so renaming either side reds.
// WHAT THIS DOES NOT PROVE: there is no Postgres here, so `l.heated` existing and resolving is not
// executed. The column comes from migrations/v5-locheated-001, which must be applied first (its README).
import { describe, it, expect } from 'vitest';
import h from './handler.js';

const { run } = h;

async function plantingsSql(flagOverrides) {
  let sql = null;
  const pg = { query: async (q) => { if (sql === null) { sql = q; throw new Error('__captured__'); } return { rows: [] }; } };
  try { await run({ pg, today: '2026-09-18', dryRun: true, flagOverrides }); } catch (e) { if (e.message !== '__captured__') throw e; }
  if (sql === null) throw new Error('no statement captured — this guard has gone blind');
  return sql;
}
// A column named in a `--` comment is not a selected column (the SELECT carries prose naming it).
const decomment = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const flat = (s) => decomment(s).replace(/\s+/g, ' ');
const heatedAliases = (sql) => [...flat(sql).matchAll(/\bl\.heated\s+is\s+true\s+as\s+(\w+)/gi)].map((m) => m[1]);

describe('V5-COLDCARDREACHABLE-001 — the plantings SELECT projects locations.heated', () => {
  for (const [label, ovr] of [['flag OFF', null], ['cover-inherit flag ON', { CARE_COVER_INHERIT_ENABLED: true }]]) {
    it(`${label}: exactly one \`l.heated is true as heated_resolved\``, async () => {
      expect(heatedAliases(await plantingsSql(ovr))).toEqual(['heated_resolved']);
    });
  }

  it('reads it off the SAME location row coverage uses (planting first, project fallback)', async () => {
    const sql = flat(await plantingsSql(null));
    expect(sql).toMatch(/left join locations l on l\.id=coalesce\(p\.location_id, pj\.location_id\)/);
    // and no second locations join that `l.heated` could be silently re-pointed at
    expect(sql.match(/\bjoin locations\b/g)).toHaveLength(1);
  });
});

describe('V5-COLDCARDREACHABLE-001 — the captured alias reaches coldFor through the real run()', () => {
  const SPACE = 'sp1';
  const USER = 'user_dave';
  const row = (id, extra) => ({
    id, name: `Pepper ${id}`, project_id: 'pj1', status: 'vegetative', container_type: 'plastic_pot',
    container_size: '1gal', rain_exposed: null, variety: 'Bhut Jolokia', genus: 'Capsicum', project: 'Garden',
    project_status: 'active', workspace_id: SPACE, crop_type_slug: 'pepper', assignee_user_id: USER,
    db_cadence: null, cadence_scopes: null, last_water: '2026-09-17', last_fert: '2026-09-01',
    substrate_start: '2026-05-01', transplant_at: null, rain_exposed_resolved: false, frost_covered_resolved: true,
    ...extra,
  });
  const drive = async (rows) => {
    const pg = { query: async (sql) => {
      if (/from plants/.test(sql)) return { rows };
      if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
      return { rows: [] };
    } };
    const res = await run({
      pg, today: '2026-09-18', dryRun: true, etHour: 2, event: {},
      geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
      fetchNWS: async () => ({ tonightLow: 38, highToday: 60, code: 1, unit: 'F', short: 'Clear' }),
      fetchPrecip: async () => ({ forecast_lows: [null, null, null], forecast_dates: [], recent_precip_in: 0,
        today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0,
        yesterday_precip_actual_in: 0, hourly_frost: null }),
      fetchStation: async () => null,
    });
    return res.plans.flatMap((pl) => pl.plan.tasks.cold).map((c) => c.name);
  };

  it('House row (alias = true) is not carded; Stable row (alias = false) is', async () => {
    const [alias] = heatedAliases(await plantingsSql(null));
    expect(alias, 'no heated alias in the emitted SELECT').toBeTruthy();
    const cold = await drive([row('house', { [alias]: true }), row('stable', { [alias]: false })]);
    expect(cold).toEqual(['Pepper stable']);
  });
});
