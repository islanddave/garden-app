// BUG-FROSTALERTNOAPP-001 (C3 guard) — a dormancy or overwinter setting cannot silence frost.
//
// THE GUARD'S SOURCE is the ledger, not a switch: "the suppression switch must be scoped so it cannot silence
// frost alerting". No overwintering on/off switch exists in code. What exists, and what this file pins:
//   (a) The frost exposure set has ONE population filter, handler.frostForSpace's careRows: it drops
//       `status === 'dormant'` and cadence `dormant_skip` (Dave 2026-08-10, frost-dormant.test.js) and nothing
//       else. Overwintering is deliberately NOT dormant (overwinter.js "WHY NOT dormant_skip ITSELF"), so an
//       overwintering tender planting is still counted and still named in the frost email.
//   (b) The only 2027-freeze switch in code is src/lib/featureFlags.js SOW_DATED_LINES_FROZEN. Its comment says
//       "It never touches frost alerts". No frost module reads it, or any other non-frost switch.
//
// SEAM for (a): the real handler.frostForSpace (summarize -> frostEval -> frostCoverage), imported the way
// frost-facts.test.js and ingroundsliver.test.js import it (`import h from './handler.js'`). Not run(): the
// population filter and the decision are both inside frostForSpace, so no pg or SNS stub is needed.
// (b) is source text, comment-stripped, the frost-dormant.test.js pattern. It READS the three client files; it
// does not import them, so this file stays out of scripts/ci-telemetry/vitest-node-project.mjs LOADS_SRC.
//
// MUTATIONS that turn it red (each applied, seen red, reverted — lane t3-frosttests-20261011):
//   * careRows also drops a planting whose db_cadence carries `overwintering`          -> (a) the regime cases
//   * frostForSpace returns early on a new process.env.OVERWINTER_QUIET                -> (b) "no switch of its own"
//   * frostEval.js reads process.env.SOW_DATED_LINES_FROZEN                            -> (b) two cases
//   * src/lib/frostAlertLine.js imports SOW_DATED_LINES_FROZEN from ./featureFlags.js  -> (b) two cases
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import h from './handler.js';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import _cf from './_coverFlags.js';

const { frostForSpace } = h;
const { generatePlan } = engine;
const { withCoverFlags } = _cf;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

// ── (a) the real exposure path ────────────────────────────────────────────────────────────────────────────
const REGIMES = [true, { regime: 'protected_productive' }, { regime: 'protected_quiescent' },
  { regime: 'tender_indoors' }, { regime: 'field_hardy' }];
// A cadence-bearing profile (overwinter-engine.test.js's KALE shape, for a tomato): resolveCadence adopts it,
// so the attribute arrives on `c` as well as on the raw p.db_cadence.
const TOMATO = { _seeded: true, crop: 'tomato', water_interval_days_container: 3, water_interval_days_inground: 4,
  water_method: 'deep_even', soil_moisture_target: 'evenly_moist', drought_tolerance: 'medium',
  fertilize_interval_days: 14 };
// Unheated and uncovered: the two exclusions frostClass.summarize DOES make are not what is under test.
const pot = (o) => withCoverFlags({
  id: 'ow1', name: 'Sungold', variety: 'Sungold', genus: 'Solanum', crop_type_slug: 'tomato', status: 'fruiting',
  container_type: 'plastic_pot', container_size: null, project: 'Stable', project_id: 'pj1', project_status: 'active',
  workspace_id: 'sp1', assignee_user_id: 'dave', substrate_start: '2026-04-20', transplant_at: null,
  last_water: '2026-11-16', last_hand_water: '2026-11-16', last_fert: null, covered: false, heated_resolved: false,
  cadence_scopes: ['leaf'], db_cadence: TOMATO, ...o,
});
const overwintering = (attr, o) => pot({ db_cadence: { ...TOMATO, overwintering: attr }, ...o });

// Midwinter, inside every regime's window, so the attribute is ACTIVE on the day frost is judged. frostSeason is
// frostForSpace's own argument (run() derives it); the population filter does not read it.
const WINTER = '2027-01-15';
const frostAt = (rows, { low = 36, lows = null, today = WINTER } = {}) => frostForSpace({
  rows, weather: { tonightLow: low, highToday: low + 20, unit: 'F' },
  hydrology: lows ? { forecast_lows: lows, forecast_dates: ['2027-01-16', '2027-01-17', '2027-01-18'] } : null,
  spaceId: 'sp1', today, frostSeason: true,
}).decision;
const heldByEngine = (row) => generatePlan({
  plantings: [row], cadence: cad, fertModel: fm, today: WINTER, weather: { tonightLow: 36, highToday: 56, unit: 'F' },
  hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave',
}).users.dave.counts.overwinter_held || 0;
const trippedIds = (tier) => (tier.tripped || []).flatMap((c) => c.ids);

describe('BUG-FROSTALERTNOAPP-001 — an overwintering planting stays in the frost exposure set', () => {
  for (const attr of REGIMES) {
    const label = attr === true ? 'true' : attr.regime;
    it(`overwintering ${label}: counted at risk, and named by the "protect tonight" email at 36°F`, () => {
      const row = overwintering(attr);
      // Not a plain tomato: the engine holds this very row out of the summer cadence on this very date.
      expect(heldByEngine(row), 'the fixture must be actively overwintering').toBe(1);
      const d = frostAt([row]);
      expect([d.tier, d.level, d.alert]).toEqual(['imminent', 'protect', true]);
      expect(d.observability.atRiskCount).toBe(1);
      expect(trippedIds(d.imminent)).toEqual(['ow1']);
      expect(d.message).toMatch(/tomatoes \(1\)/);
    });
  }

  it('the attribute read off the raw profile alone (no adopted cadence) changes nothing either', () => {
    // overwinter.readAttr's second read: a leaf profile carrying ONLY the key is not adopted by resolveCadence.
    const d = frostAt([pot({ cadence_scopes: null, db_cadence: { overwintering: { regime: 'tender_indoors' } } })]);
    expect(d.observability.atRiskCount).toBe(1);
    expect(trippedIds(d.imminent)).toEqual(['ow1']);
  });

  it('the advisory tier names it too (a 39°F night two days out, tonight mild)', () => {
    const d = frostAt([overwintering({ regime: 'protected_quiescent' })], { low: 50, lows: [50, 39, 51] });
    expect([d.tier, d.alert]).toEqual(['advisory', true]);
    expect(trippedIds(d.advisoryCrops)).toEqual(['ow1']);
  });

  it('identical to the same planting with no attribute: the decision does not move at all', () => {
    for (const attr of REGIMES) {
      expect(frostAt([overwintering(attr)]), JSON.stringify(attr)).toEqual(frostAt([pot()]));
    }
  });

  it('CONTROL — the one filter that exists still works: the same pot marked dormant is not at risk', () => {
    const d = frostAt([overwintering({ regime: 'tender_indoors' }, { status: 'dormant' })]);
    expect(d.observability.atRiskCount).toBe(0);
    expect(trippedIds(d.imminent)).toEqual([]);
    // ...and with nothing left at risk no email goes out at all. THE STAKE: leaving the exposure set is not a
    // quieter email, it is no email, which is why overwintering must never be folded into this filter.
    expect([d.tier, d.alert]).toEqual([null, false]);
  });
});

// ── (b) no frost module reads a sowing-freeze or overwintering switch ─────────────────────────────────────
// Comment-strip before asserting on source (frost-dormant.test.js): these files' prose names the very things
// the code must not read.
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))   // keep `https://` intact
  .join('\n');
const code = (rel) => strip(readFileSync(resolve(REPO, rel), 'utf8'));

// Every frost*.js module of this Lambda, plus radiativeFrost.js (frostEval requires it).
const LAMBDA_FROST = ['lambda/daily-plan/frostEval.js', 'lambda/daily-plan/frostClass.js', 'lambda/daily-plan/radiativeFrost.js'];
const CLIENT_FROST = ['src/lib/frostAlertLine.js', 'src/lib/tonightLow.js', 'src/components/today/FrostAlertLine.jsx'];
const FLAGS = 'src/lib/featureFlags.js';
// The sowing freeze by its constant, its ledger id, its hook option, or the module it lives in.
const SOW_FREEZE = /SOW_DATED_LINES_FROZEN|sow[_-]?freez|sowLines|featureFlags/i;
const HANDLER = code('lambda/daily-plan/handler.js');
const frostForSpaceBody = () => {
  const from = HANDLER.indexOf('function frostForSpace(');
  const to = HANDLER.indexOf('\n}\n', from);
  return from < 0 || to < 0 ? null : HANDLER.slice(from, to);
};

// Relative imports only: a bare specifier (react) cannot carry an app flag.
const importsOf = (rel) => {
  const out = [];
  const re = /(?:from\s+|import\s*\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  const src = code(rel);
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const base = resolve(REPO, dirname(rel), m[1]);
    const hit = ['', '.js', '.jsx', '/index.js'].map((x) => base + x).find((f) => existsSync(f) && /\.jsx?$/.test(f));
    if (hit) out.push(hit.slice(REPO.length + 1));
  }
  return out;
};
const closure = (roots) => {
  const seen = new Set();
  const walk = (rel) => { if (seen.has(rel)) return; seen.add(rel); importsOf(rel).forEach(walk); };
  roots.forEach(walk);
  return seen;
};

describe('BUG-FROSTALERTNOAPP-001 — no frost module reads the sowing freeze or any switch but its own', () => {
  it('the freeze switch is still the constant this guard names (a rename must move the guard with it)', () => {
    expect(code(FLAGS)).toMatch(/export const SOW_DATED_LINES_FROZEN\s*=/);
    expect(frostForSpaceBody(), 'handler.frostForSpace must be findable').toBeTruthy();
  });

  it('none of the six frost modules, nor the handler, names the sowing freeze in code', () => {
    for (const rel of [...LAMBDA_FROST, ...CLIENT_FROST]) expect(code(rel), rel).not.toMatch(SOW_FREEZE);
    expect(HANDLER).not.toMatch(SOW_FREEZE);
  });

  it('the page\'s frost modules do not reach featureFlags.js through any import chain', () => {
    const reached = closure(CLIENT_FROST);
    for (const rel of CLIENT_FROST) expect(reached.has(rel)).toBe(true);
    expect(reached.size).toBeGreaterThan(CLIENT_FROST.length);      // the walk does follow imports (constants.js)
    expect([...reached]).not.toContain(FLAGS);
  });

  it('the Lambda\'s frost modules read FROST_* env names and nothing else', () => {
    let seen = 0;
    for (const rel of LAMBDA_FROST) {
      const src = code(rel);
      const names = [...src.matchAll(/process\.env\.([A-Za-z_0-9]+)/g), ...src.matchAll(/numEnv\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      seen += names.length;
      for (const n of names) expect(n, `${rel} reads ${n}`).toMatch(/^FROST_/);
      // A computed read is allowed only as numEnv's own body, `process.env[name]`.
      for (const m of src.matchAll(/process\.env\[([^\]]*)\]/g)) expect(m[1], rel).toBe('name');
      expect(src, rel).not.toMatch(/overwinter/i);
    }
    expect(seen).toBeGreaterThan(10);
  });

  it('frostForSpace has no switch of its own: no env read, no overwintering read, one filter', () => {
    const body = frostForSpaceBody();
    expect(body).not.toMatch(/process\.env/);
    expect(body).not.toMatch(/overwinter/i);
    expect(body.match(/\.filter\(/g)).toHaveLength(1);
    // One exit at the function's own indent, and it hands back the decision: no early "say nothing" return.
    const exits = body.split('\n').filter((l) => /^ {2}(if\b.*)?\breturn\b/.test(l));
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatch(/^ {2}return \{ decision, coverage:/);
  });
});
