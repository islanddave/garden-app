// V5-SEASONSTATS-001 — the public.stat_* view columns lambda/harvests/season-stats.js reads.
//
// WHY THIS FILE HAS TO SHIP WITH THE ROUTE: Phase 4 of scripts/dev-main-schema-audit.py counts
// (directory, relation) pairs a handler binds in FROM/JOIN that no column contract in that handler's
// OWN directory declares, and fails when the count exceeds scripts/schema-audit-join-baseline.json.
// season-stats.js binds fourteen new relations; without this file the baseline would rise by
// fourteen, and the L-081 ratchet only ever goes down.
//
// WHY A NEW FILE AND NOT A BLOCK IN select-columns.test.js: parse_test_file returns on the keyed
// AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector, so a keyed block dropped
// into an existing contract file SILENTLY DESTROYS that file's own coverage. Always a new file.
//
// WHAT PHASE 1 DOES WITH IT: every column below is checked against prod information_schema.columns,
// which lists views. Until migrations/v5-seasonstats-001 is applied to prod these relations have zero
// columns there and the audit reports the run inconclusive (exit 2) — which is the promote gate
// refusing a handler whose views prod lacks, exactly as intended. Apply order: v5-sourcecontact-001,
// v5-seasonstats-001, then the dev push.
//
// Static source inspection rather than import, because the auditor reads SQL TEXT and reading it the
// same way is the point. The second half of this file cross-checks each list against the named
// columns the migration's own post gates assert, so a column the handler reads that the view does not
// project reds HERE, offline, rather than first in the prod audit.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same comment stripping as scripts/dev-main-schema-audit.py _decomment_js.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the set Phase 4 groups together.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract: exactly the columns season-stats.js names, per view.
const AUDIT_COLUMNS = {
  stat_weather_day: ['day', 'grow_year', 'owner', 'precip_in', 'tmax_f', 'tmin_f'],
  stat_care_day: ['care_kind', 'day', 'grow_year', 'owner'],
  stat_season_pins: ['first_setout', 'first_sow', 'grow_year', 'hottest_day', 'hottest_tmax_f', 'owner', 'weather_from', 'wettest_day', 'wettest_precip_in'],
  stat_weekly_heat_fruit: ['cool_nights', 'grow_year', 'heat_units', 'owner', 'pepper_pods', 'rain_in', 'tomato_fruit', 'week_start'],
  stat_source_mix: ['grow_year', 'owner', 'plantings', 'plants', 'source_group'],
  stat_source_card: ['grow_year', 'kind', 'lb', 'lost', 'name', 'owner', 'picked', 'plantings', 'plants', 'saved_lots', 'source_id'],
  stat_heat_clock_crop: ['crop_name', 'crop_slug', 'first_pick', 'grow_year', 'heat_units', 'origin_date', 'owner'],
  stat_heat_clock_cultivar: ['crop_median_heat', 'crop_slug', 'cultivar', 'days', 'first_pick', 'grow_year', 'heat_band', 'heat_units', 'owner', 'planting_id', 'transplanted_at'],
  stat_heat_ladder: ['band', 'grow_year', 'lb', 'owner', 'plantings', 'plants', 'pods'],
  stat_pepper_best: ['band', 'cultivar', 'grow_year', 'lb', 'owner', 'planting_id', 'pods', 'rank_in_band', 'scoville_max'],
  stat_tomato_keep: ['container_size', 'cultivar', 'fruit', 'g_per_fruit', 'grow_year', 'late_aug', 'lb', 'measured_share', 'median_lb', 'owner', 'planting_id', 'verdict', 'x_median'],
  stat_longest_giving: ['crop_name', 'cultivar', 'first_pick', 'grow_year', 'last_pick', 'lb', 'lb_per_plant_week', 'owner', 'pick_days', 'planting_id', 'plants', 'rank_by_window', 'season_last_pick', 'still_picking', 'window_days'],
  stat_tomato_month_size: ['aug_fruit', 'aug_g', 'aug_grams', 'cultivar', 'fruit_weighted_ratio', 'grow_year', 'owner', 'ratio', 'sep_fruit', 'sep_g', 'sep_grams'],
  stat_saved_lot: ['count_estimated', 'crop_slug', 'cultivar', 'grow_year', 'lot_id', 'owner', 'parent_lb', 'parent_name', 'parent_planting_id', 'saved_at', 'saved_on', 'seed_count', 'source_address', 'source_facebook_url', 'source_id', 'source_instagram_url', 'source_kind', 'source_locality', 'source_name', 'source_website_url', 'stage', 'via_name'],
};

const RELATIONS = Object.keys(AUDIT_COLUMNS);

// Extraction mirrors scripts/dev-main-schema-audit.py: only SQL inside a tagged sql`` template counts.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

// Trailing \b keeps stat_planting from matching stat_planting_harvest, and stat_heat_clock_crop from
// matching nothing else by prefix — several of these names are prefixes of one another.
const bindings = (rel, s) => [...s.matchAll(
  new RegExp(String.raw`\b(?:FROM|JOIN)\s+(?:public\.)?${rel}\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?`, 'gi'),
)].map((m) => (m[1] ?? '').toLowerCase());

const NOT_AN_ALIAS = new Set([
  'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
  'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
]);

const aliasesOf = (rel, s) => [...new Set(bindings(rel, s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
const unaliasedIn = (rel, s) => bindings(rel, s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;
const columnsOf = (rel, s) => [...new Set(aliasesOf(rel, s).flatMap((a) => [...s.matchAll(
  new RegExp(String.raw`\b${a}\.([a-z_][a-z0-9_]*)\b`, 'gi'),
)].map((m) => m[1].toLowerCase())))];

const ALL_STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)]
    .map((m) => m[1].replace(DISTINCT_FROM, ' '))
    .map((sql) => ({ file: f, sql }));
});
const statementsFor = (rel) => ALL_STATEMENTS.filter((s) => bindings(rel, s.sql).length > 0);

// The named columns each view's post gate asserts (generated from the views' real output on prod).
const GATES = readFileSync(resolve(__dirname, '../../migrations/v5-seasonstats-001/gates.yml'), 'utf8');
function gateColumns(rel) {
  const m = GATES.match(new RegExp(String.raw`table_name = '${rel}'\s+AND column_name IN \(([^)]*)\)`));
  return m ? [...m[1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]) : null;
}

describe('V5-SEASONSTATS-001 — lambda/harvests stat_* view column contract', () => {
  it('finds the statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS).toContain('season-stats.js');
    // Exactly one read per view: a second statement should be reviewed against the contract rather
    // than inherit it. Update in the same commit that adds one.
    for (const rel of RELATIONS) {
      expect(statementsFor(rel), rel).toHaveLength(1);
      expect(statementsFor(rel)[0].file, rel).toBe('season-stats.js');
    }
  });

  it('every stat_* relation any handler here binds has a contract entry', () => {
    const bound = new Set(ALL_STATEMENTS.flatMap((s) => [...s.sql.matchAll(/\b(?:FROM|JOIN)\s+(?:public\.)?(stat_[a-z0-9_]+)/gi)].map((m) => m[1])));
    expect([...bound].sort()).toEqual([...RELATIONS].sort());
  });

  for (const rel of RELATIONS) {
    it(`${rel}: no unaliased read, and the columns read are exactly the contract`, () => {
      expect(statementsFor(rel).reduce((n, s) => n + unaliasedIn(rel, s.sql), 0)).toBe(0);
      const referenced = [...new Set(statementsFor(rel).flatMap((s) => columnsOf(rel, s.sql)))].sort();
      expect(referenced.length).toBeGreaterThan(0);
      expect(referenced).toEqual([...AUDIT_COLUMNS[rel]].sort());
    });

    it(`${rel}: every contract column is one the migration's post gate asserts the view projects`, () => {
      const projected = gateColumns(rel);
      expect(projected, `no post gate names ${rel}'s columns`).not.toBeNull();
      expect(AUDIT_COLUMNS[rel].filter((c) => !projected.includes(c))).toEqual([]);
    });
  }
});
