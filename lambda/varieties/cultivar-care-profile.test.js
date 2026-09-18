// BUG-CULTIVARNOPROFILE-001 — creating a cultivar must also create its cadence profile ROW.
//
// THE BUG THESE TESTS EXIST TO KEEP CLOSED. POST /api/varieties wrote plant_varieties and nothing
// else, so every cultivar minted in the app arrived with no cultivar-scope care_profile row.
// v4-cadencerefill-001's standing guard (post_no_live_planting_lacks_a_cadence_profile) asserts
// exactly that row exists for every live planting's variety, and this path re-opened it THREE times
// in seven days — 2026-09-10, 09-11 and 09-17, each one Dave correcting a misidentification by
// minting a cultivar and re-pointing the planting onto it. The 09-17 recurrence tripled a container
// pepper's watering interval (1d -> 3d) and relabelled it `crop: unknown` in the daily plan.
// It recurred three times because NOTHING FAILED LOUDLY in code; the only alarm was a migration gate
// running against prod, after the fact, on data someone then hand-backfilled.
//
// WHY THESE RUN THE HANDLER rather than scanning source, per source-routes.test.js's rationale:
// every assertion below is about what the create path actually WRITES, and no regex over the source
// can see which statements a given request issues. The mock is that file's mock verbatim — the four
// vitest.config.ts stub aliases make `./index.js` importable, and the one gap is `sql.transaction`,
// which the shared stub does not implement.
//
// WHAT THESE TESTS DO NOT PROVE, stated here rather than left to be discovered: the Lambda unit
// suite is MOCK-SQL. No statement below ever reaches Postgres, so these tests prove the handler
// ISSUES the right INSERT with the right bindings — not that Postgres accepts it, not that the
// `public.cultivar` view takes an explicit `id`, not that the transaction is atomic under a real
// failure, and not that v_resolved_care.cadence_scopes actually stays empty. Those need an
// integration run against a real branch (vitest.integration.config.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

vi.mock('@neondatabase/serverless', async () => {
  const { stubState: state } = await import('../_test-stubs/state.js');
  return {
    neon: () => {
      const tagged = async (strings, ...values) => {
        const text = Array.isArray(strings) ? strings.join('?') : String(strings);
        state.sqlCalls.push({ text, values });
        return state.sqlHandler(text, values);
      };
      // Each element is an already-running statement promise, so ordering in sqlCalls matches the
      // order the statements appear in the transaction array.
      tagged.transaction = (stmts) => Promise.all(stmts);
      return tagged;
    },
  };
});

const { handler } = await import('./index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — see the identical helper in
// admin-source-id.test.js for the failure that made every raw-source guard find its own epitaph.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const USER = 'user_stub_owner';
const NEW_ID = 'ffffffff-1111-4222-8333-444444444444';

// The three keys v_resolved_care.cadence_scopes is computed from (migrations/v4-seededgate-001/
// 0a-view.sql:80-91). A cultivar profile carrying ANY of them puts 'cultivar' into that array, which
// makes engine.js's resolveCadence ADOPT the row (engine.js:83-86) instead of falling through to the
// bundled cadence-data-v2.json ladder. The create path has no evidence for a number, so writing one
// would be a horticultural claim wearing a researched row's clothes.
const CADENCE_KEYS = ['water_interval_days', 'water_interval_days_container', 'water_interval_days_inground'];

// The keys engine.js reads off the RAW db_cadence, BYPASSING the cadence_scopes adopt gate — so
// unlike a stray `crop`, any of these would change a live verdict the day the row is written.
// waterSuppression (engine.js:916-921) and feedSuppression (:939-943) read both `c` and
// p.db_cadence; soil_moisture_target is read raw at :1044 and :1085; `_seeded` is the legacy
// flag-OFF adopt marker at :85.
const ADOPT_BYPASSING_KEYS = ['no_calendar_water', 'water_rule', 'no_calendar_feed', 'soil_moisture_target', '_seeded'];

const isRateLimit = (t) => t.includes('INSERT INTO public.rate_limit_buckets');
const isSetConfig = (t) => t.includes('set_config');
const isCultivarInsert = (t) => t.includes('INSERT INTO public.cultivar');
const isProfileInsert = (t) => t.includes('INSERT INTO public.care_profile');

// A DB that answers only what the create path asks and nothing else, so a statement this file does
// not describe returns [] rather than inheriting a fixture's rows.
function db({ allowRate = true, similar = [] } = {}) {
  stubState.sqlHandler = (text, values) => {
    if (isRateLimit(text)) return allowRate ? [{ count: 1 }] : [];
    if (isSetConfig(text)) return [{ set_config: values[0] }];
    if (isProfileInsert(text)) return [];
    if (isCultivarInsert(text)) {
      // values[0] is the client-minted id — echo it back the way RETURNING id would.
      return [{ id: values[0], name: values[1], species: values[2], genus: values[3] }];
    }
    if (text.includes('FROM public.cultivar')) return similar;   // the fuzzy-match SELECT
    if (text.includes('FROM public.crop_types')) return [];      // applyDerive, fail-open
    return [];
  };
}

const call = (method, rawPath, body) => handler({
  requestContext: { http: { method } },
  rawPath,
  headers: { authorization: 'Bearer stub-token' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const post = async (path, body) => {
  const res = await call('POST', path, body);
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};
const find = (pred) => stubState.sqlCalls.find((c) => pred(c.text));
const profileWrite = () => {
  const c = find(isProfileInsert);
  if (!c) return null;
  // Bindings are positional in the order they appear in the template: scope_id, then profile.
  const raw = c.values.find((v) => typeof v === 'string' && v.trim().startsWith('{'));
  return { call: c, scopeId: c.values[0], profile: raw == null ? null : JSON.parse(raw) };
};

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  db();
});

// ── the existence invariant the gate asserts ────────────────────────────────────────────────────

describe('POST /api/varieties — the cadence profile row', () => {
  it('creates a cultivar-scope care_profile row for the cultivar it just minted', async () => {
    // THE test. Delete the care_profile INSERT from index.js and this is the one that reds.
    const { status } = await post('/api/varieties', { name: 'Unknown Sweet Long', crop_type_slug: 'pepper' });
    expect(status).toBe(201);

    const w = profileWrite();
    expect(w, 'create-cultivar issued no care_profile INSERT').not.toBeNull();
    expect(w.call.text).toMatch(/scope,\s*scope_id,\s*profile,\s*model_version/);
    expect(w.call.text).toMatch(/'cultivar'::care_scope/);
  });

  it('binds the SAME id the cultivar row was inserted with', async () => {
    // The gate joins plants.variety_id -> care_profile.scope_id. A profile keyed to any other id
    // satisfies nothing; it just adds an orphan row. This is why the id is minted client-side.
    const { status, body } = await post('/api/varieties', { name: 'Unknown Sweet Long' });
    expect(status).toBe(201);

    const cultivar = find(isCultivarInsert);
    const w = profileWrite();
    expect(cultivar.values[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(w.scopeId).toBe(cultivar.values[0]);
    expect(body.id).toBe(cultivar.values[0]);   // and it is the id handed back to the client
  });

  it('satisfies the gate predicate — a planting pointed at this cultivar has a profile', async () => {
    // post_no_live_planting_lacks_a_cadence_profile in migrations/v4-cadencerefill-001/gates.yml,
    // evaluated against what this request wrote. Restated as the gate states it so a future reader
    // can see the two are the same assertion, not two similar ones.
    await post('/api/varieties', { name: 'Unknown Sweet Long', crop_type_slug: 'pepper' });
    const varietyId = find(isCultivarInsert).values[0];

    const cultivarScopedProfiles = stubState.sqlCalls
      .filter((c) => isProfileInsert(c.text))
      .map((c) => c.values[0]);
    const gateViolations = [{ variety_id: varietyId }]
      .filter((p) => !cultivarScopedProfiles.includes(p.variety_id));
    expect(gateViolations).toHaveLength(0);
  });

  it('writes exactly one profile row per created cultivar', async () => {
    await post('/api/varieties', { name: 'One' });
    expect(stubState.sqlCalls.filter((c) => isProfileInsert(c.text))).toHaveLength(1);
  });

  it('does NOT write a profile when the create is refused', async () => {
    // A 409 near-duplicate returns before the transaction. A profile row minted for a cultivar that
    // was never created is an orphan, and orphans are what make a row-existence gate untrustworthy.
    db({ similar: [{ id: NEW_ID, name: 'Sunbright', species: null, genus: 'Capsicum' }] });
    const { status } = await post('/api/varieties', { name: 'Sunbright' });
    expect(status).toBe(409);
    expect(find(isProfileInsert)).toBeUndefined();
  });
});

// ── gap vs decision: the distinction the whole guard rests on ───────────────────────────────────

describe('the created row is a GAP, not a DECISION', () => {
  // In this data model an EMPTY profile row MEANS SOMETHING: Collards' row omits every watering key
  // on purpose ("watering/thresholds intentionally omitted so resolution still falls to system
  // default"), and post_collards_silence_is_still_intact guards that silence. An ABSENT row is a
  // gap. Writing `{}` here would make every future gap indistinguishable from a deliberate
  // decision — it would turn the guard green while destroying the thing the guard is about.
  it('is not an empty row', async () => {
    await post('/api/varieties', { name: 'Unknown Sweet Long' });
    const { profile } = profileWrite();
    expect(profile).not.toEqual({});
    expect(Object.keys(profile).length).toBeGreaterThan(0);
  });

  it('carries the _basis:"unresearched" sentinel', async () => {
    await post('/api/varieties', { name: 'Unknown Sweet Long' });
    const { profile } = profileWrite();
    expect(profile._basis).toBe('unresearched');
  });

  it('does NOT claim to be a decision', async () => {
    // _basis:'dave_decision' is v4-cadencerefill-001's label for a ratified judgement, and
    // post_judgement_rows_stay_labelled_as_judgement exists because "a guess wearing a
    // measurement's clothes is how a decision gets laundered into evidence". An auto-created row is
    // neither a guess nor a measurement — it is an admission that nobody has looked yet.
    await post('/api/varieties', { name: 'Unknown Sweet Long' });
    const { profile } = profileWrite();
    expect(profile._basis).not.toBe('dave_decision');
    expect(profile._source).toBeTruthy();   // provenance, so every auto-created row is findable
  });

  it('is distinguishable from a hand-authored watering-free row by the sentinel alone', async () => {
    // The Collards shape, as it exists on prod: watering-free AND deliberate. Both rows are
    // watering-free, so key-absence cannot tell them apart — only _basis can. If this assertion can
    // ever be satisfied by inspecting watering keys instead, the sentinel has stopped being load-bearing.
    const COLLARDS_LIKE = { _scope_note: 'container-sizing only; watering/thresholds intentionally omitted' };
    await post('/api/varieties', { name: 'Unknown Sweet Long' });
    const { profile } = profileWrite();

    const wateringFree = (p) => CADENCE_KEYS.every((k) => !(k in p));
    expect(wateringFree(COLLARDS_LIKE)).toBe(true);
    expect(wateringFree(profile)).toBe(true);
    expect(profile._basis).not.toBe(COLLARDS_LIKE._basis);
  });
});

// ── the row must not change a single watering verdict ───────────────────────────────────────────

describe('the created row is behaviourally inert', () => {
  it('carries none of the three cadence keys, so cadence_scopes stays empty', async () => {
    await post('/api/varieties', { name: 'Unknown Sweet Long', crop_type_slug: 'pepper' });
    const { profile } = profileWrite();
    for (const k of CADENCE_KEYS) expect(profile, `profile must not carry ${k}`).not.toHaveProperty(k);
  });

  it('carries none of the keys engine.js reads past the adopt gate', async () => {
    await post('/api/varieties', { name: 'Unknown Sweet Long', crop_type_slug: 'pepper' });
    const { profile } = profileWrite();
    for (const k of ADOPT_BYPASSING_KEYS) expect(profile, `profile must not carry ${k}`).not.toHaveProperty(k);
  });

  it('does not mint a free-text crop string or a genus', async () => {
    // BUG-WATERIDENTITYFREETEXT-001 is open on `crop` being uncontrolled free text (149 distinct
    // strings across 265 profiles, engine.js:107). `crop` is inert while the row carries no cadence
    // key, but it goes live the moment anyone adds one — and minting identity strings at app-write
    // rate is the wrong direction for that defect. genus is not derivable at all: crop_types has no
    // genus column, so any slug->genus map would be invention rather than data.
    await post('/api/varieties', { name: 'Unknown Sweet Long', crop_type_slug: 'pepper', genus: 'Capsicum' });
    const { profile } = profileWrite();
    expect(profile).not.toHaveProperty('crop');
    expect(profile).not.toHaveProperty('genus');
  });

  it('writes the same profile whatever the caller supplies', async () => {
    // The row says "nobody has researched this yet", which is true regardless of how complete the
    // create form was. A profile that varied with the payload would be inferring care from identity
    // — the exact move the two bullets above refuse.
    await post('/api/varieties', { name: 'Bare' });
    const bare = profileWrite().profile;
    resetStubs(); stubState.verifyTokenResult = { sub: USER }; db();
    await post('/api/varieties', {
      name: 'Rich', genus: 'Capsicum', species: 'annuum', crop_type_slug: 'pepper',
      lifecycle: 'tender_perennial', scoville_min: 100, scoville_max: 500,
    });
    expect(profileWrite().profile).toEqual(bare);
  });
});

// ── atomicity: source guards, because the mock cannot see a transaction ─────────────────────────

describe('the profile write is inside the cultivar transaction (static guards)', () => {
  // The mock flattens sql.transaction() to Promise.all, so no runtime assertion here can tell an
  // in-transaction statement from a post-commit one. That distinction is the difference between an
  // invariant and a best-effort, so it is pinned against the source instead: a post-commit write
  // fails OPEN (the applyDerive idiom two lines below it), and failing open on an existence
  // invariant silently re-creates the gap this change closes.
  const txStart = SRC.indexOf('await sql.transaction([', SRC.indexOf('const newVarietyId'));
  const txEnd = SRC.indexOf(']);', txStart);

  it('the transaction array contains both INSERTs', () => {
    expect(txStart).toBeGreaterThan(-1);
    expect(txEnd).toBeGreaterThan(txStart);
    const block = SRC.slice(txStart, txEnd);
    expect(block).toContain('INSERT INTO public.cultivar');
    expect(block).toContain('INSERT INTO public.care_profile');
  });

  it('the profile INSERT comes after the cultivar INSERT', () => {
    const block = SRC.slice(txStart, txEnd);
    expect(block.indexOf('INSERT INTO public.care_profile')).toBeGreaterThan(block.indexOf('INSERT INTO public.cultivar'));
  });

  it('there is no care_profile write outside the transaction', () => {
    // Catches the repair-by-relocation that would pass every behavioural test above while giving up
    // atomicity: move the INSERT below the transaction, next to applyDerive, and everything else
    // still goes green.
    const all = [...SRC.matchAll(/INSERT INTO public\.care_profile/g)].map((m) => m.index);
    expect(all).toHaveLength(1);
    expect(all[0]).toBeGreaterThan(txStart);
    expect(all[0]).toBeLessThan(txEnd);
  });

  it('binds scope_id as ::uuid and leaves workspace_id to the column default', () => {
    // scope_id needs the explicit cast: the parameter arrives as text and Postgres cannot infer the
    // type across the ON CONFLICT arm (L-086 class, documented in plants/overwinterAttr.js:148-149).
    const block = SRC.slice(txStart, txEnd);
    const stmt = block.slice(block.indexOf('INSERT INTO public.care_profile'));
    expect(stmt).toMatch(/\$\{newVarietyId\}::uuid/);
    expect(stmt).not.toContain('workspace_id');
  });

  it('never clobbers an existing profile', () => {
    // DO NOTHING, not DO UPDATE. Unreachable on a uuid minted three lines earlier, but it is what
    // makes this statement safe to re-point at existing cultivars — the obvious next use is
    // backfilling the rows created before this shipped, and a DO UPDATE there would flatten
    // researched cadence numbers back to 'unresearched'.
    const block = SRC.slice(txStart, txEnd);
    const stmt = block.slice(block.indexOf('INSERT INTO public.care_profile'));
    expect(stmt).toMatch(/ON CONFLICT \(scope, scope_id\) WHERE scope <> 'system' DO NOTHING/);
    expect(stmt).not.toMatch(/DO UPDATE/);
  });
});
