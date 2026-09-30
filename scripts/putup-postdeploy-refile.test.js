// scripts/putup-postdeploy-refile.mjs — the Put-Up 1b post-deploy pesto re-file. What this proves without a database:
// the argument and environment refusals; which jars are re-filed, left alone or refused; that the dry run's printed
// "after" is exactly what the PATCH binds (the same jar through the real handleJarRoute, mock driver); and that main()
// writes only through the handler, only with --i-mean-it, once per jar, as that jar's owner. What it cannot: that
// the SQL runs — the local PG 17 replica proof and the real-Neon integration case do that.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleJarRoute } from '../lambda/preservation/jarRoutes.js';
import {
  parseArgs, basilEvidence, planRefile, main, day, AUDIT_WATCHED, ENV_KEY, TO_METHOD,
} from './putup-postdeploy-refile.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const J1 = 'b7111a27-d5e5-4947-aba1-a676f054028d';
const J2 = 'd6cb0640-44a1-492c-87d3-4e46ae3733a4';
const J3 = '10000000-0000-4000-8000-000000000009';

// The driver parses a `date` column into a local-midnight Date; the fixtures do the same.
const d = (s) => { const [y, m, dd] = s.split('-').map(Number); return new Date(y, m - 1, dd); };
// A jar as the script's read returns it: the two prod pestos' shape (basil, put up 2026-08-19, a deep freezer).
const jar = (over = {}) => ({
  id: J1, user_id: 'user_dave', method: 'passata', method_other_text: null, label: null, container_label: null,
  notes: null, is_raw: null, in_oil: null, texture: null, crop_type_slug: 'basil', crop_display_name: 'Basil',
  variety_name: null, variety_crop_type_slug: null, storage_location_id: 'loc-1', storage_kind: 'deep_freezer',
  storage_label: 'Meat deep freezer', preserved_at: d('2026-08-19'), preserved_at_precision: null,
  use_by_target: d('2027-08-19'), use_by_basis: 'table', storage_moved_at: null, package_count: 1, remaining_count: 1,
  deleted_at: null, ...over,
});

describe('parseArgs — dry run unless --i-mean-it; targets only by explicit uuid', () => {
  it('reads repeated --jar in both spellings, lowercased and de-duplicated, and defaults to a dry run', () => {
    expect(parseArgs(['--jar', J1.toUpperCase(), `--jar=${J2}`, '--jar', J1])).toEqual({ jars: [J1, J2], write: false });
    expect(parseArgs(['--jar', J1, '--i-mean-it'])).toEqual({ jars: [J1], write: true });
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it('refuses no target, a non-uuid, a dangling --jar and an unknown flag', () => {
    expect(parseArgs([]).error).toMatch(/at least one --jar/);
    expect(parseArgs(['--i-mean-it']).error).toMatch(/at least one --jar/);
    expect(parseArgs(['--jar', 'b7111a27']).error).toMatch(/needs a jar id/);
    expect(parseArgs(['--jar']).error).toMatch(/needs a jar id/);
    expect(parseArgs(['--jar', J1, '--i-mean-t']).error).toBe('unknown flag: --i-mean-t');
  });

  it('refuses a connection string on the command line without echoing any of it', () => {
    for (const a of ['postgresql://user:hunter2@ep-x.neon.tech/neondb', 'user:hunter2@host', `--jar=postgres://a@b/${J1}`]) {
      const { error } = parseArgs(['--jar', J1, a]);
      expect(error).toMatch(/looks like a connection string/);
      expect(error).not.toMatch(/hunter2|neon\.tech|user:/);
    }
    expect(parseArgs(['--jar', J1, 'hunter2']).error).toBe('argument 3 is not recognised (value not shown)');
  });
});

describe('basilEvidence — what makes a jar recognisably the basil pesto', () => {
  it('finds basil or pesto in the label, crop, variety or notes, any case, and says where', () => {
    expect(basilEvidence(jar({ notes: 'Pesto (Genovese)' }))).toEqual([
      { field: 'crop_type_slug', value: 'basil' }, { field: 'crop_display_name', value: 'Basil' },
      { field: 'notes', value: 'Pesto (Genovese)' },
    ]);
    expect(basilEvidence(jar({ crop_type_slug: null, crop_display_name: null, label: 'Summer pestos' })))
      .toEqual([{ field: 'label', value: 'Summer pestos' }]);
    expect(basilEvidence(jar({ crop_type_slug: null, crop_display_name: null, variety_name: 'Thai Basil' })))
      .toEqual([{ field: 'variety_name', value: 'Thai Basil' }]);
  });

  it('finds nothing on a tomato passata, and does not read "pasta" or "basilica" words as basil', () => {
    expect(basilEvidence(jar({ crop_type_slug: 'tomato', crop_display_name: 'Tomato', notes: 'sauce for pasta' }))).toEqual([]);
    expect(basilEvidence(jar({ crop_type_slug: 'tomato', crop_display_name: 'Tomato', label: 'pastes' }))).toEqual([]);
  });
});

describe('planRefile — the verdict, and the date the PATCH will store', () => {
  it('the prod shape: a never-moved deep-freezer table date re-derives to the same day (pesto there is 12 months too)', () => {
    const p = planRefile(jar({ notes: 'pesto' }));
    expect(p.verdict).toBe('refile');
    expect(p.before).toEqual({ method: 'passata', use_by_target: '2027-08-19', use_by_basis: 'table' });
    expect(p.after).toEqual({ method: TO_METHOD, use_by_target: '2027-08-19', use_by_basis: 'table' });
    expect(p.rule).toMatch(/never moved: re-derived from its stored put-up date 2026-08-19; pesto in a deep_freezer: 12 months/);
  });

  it('follows pesto\'s figure for the place: 4 months in a fridge-freezer, 10 with no recorded place, none on a shelf', () => {
    expect(planRefile(jar({ storage_kind: 'fridge_freezer' })).after)
      .toEqual({ method: 'pesto', use_by_target: '2026-12-19', use_by_basis: 'table' });
    expect(planRefile(jar({ storage_kind: null, storage_location_id: null })).after)
      .toEqual({ method: 'pesto', use_by_target: '2027-06-19', use_by_basis: 'table' });
    expect(planRefile(jar({ storage_kind: 'pantry', use_by_target: d('2027-08-19') })).after)
      .toEqual({ method: 'pesto', use_by_target: null, use_by_basis: 'none' });
  });

  it('a moved jar loses its table date; a typed or recipe date survives', () => {
    const moved = planRefile(jar({ storage_moved_at: new Date('2026-09-01T12:00:00Z') }));
    expect(moved.after).toEqual({ method: 'pesto', use_by_target: null, use_by_basis: 'none' });
    expect(moved.rule).toMatch(/moved since it was put up/);
    for (const basis of ['typed', 'recipe']) {
      const kept = planRefile(jar({ use_by_basis: basis, use_by_target: d('2026-12-01') }));
      expect(kept.after).toEqual({ method: 'pesto', use_by_target: '2026-12-01', use_by_basis: basis });
      expect(kept.rule).toMatch(/date kept/);
    }
  });

  it('refuses a jar the 0p backfill has not reached, a non-basil passata, another method, and a deleted jar', () => {
    const refused = (over) => planRefile(jar(over));
    expect(refused({ use_by_basis: null })).toMatchObject({ verdict: 'refuse', reasons: [expect.stringMatching(/0p backfill/)] });
    expect(refused({ crop_type_slug: 'tomato', crop_display_name: 'Tomato' }))
      .toMatchObject({ verdict: 'refuse', reasons: [expect.stringMatching(/says basil or pesto/)] });
    expect(refused({ method: 'whole_freeze' }))
      .toMatchObject({ verdict: 'refuse', reasons: [expect.stringMatching(/not passata/)] });
    expect(refused({ deleted_at: new Date() })).toMatchObject({ verdict: 'refuse', reasons: ['the jar is deleted'] });
  });

  it('a jar that is already pesto is a no-op (a second run), unless it is deleted', () => {
    expect(planRefile(jar({ method: 'pesto' }))).toMatchObject({ verdict: 'noop', reasons: ['already pesto'] });
    expect(planRefile(jar({ method: 'pesto', deleted_at: new Date() }))).toMatchObject({ verdict: 'refuse' });
  });
});

// The dry run prints planRefile's "after"; the real run stores what the PATCH binds. Same jar, both paths.
function mockSql(queue = []) {
  const fn = (strings, ...values) => {
    const call = { norm: strings.raw.join(' ? ').replace(/\s+/g, ' ').trim(), values };
    return { call, then: (ok, err) => (queue.length ? Promise.resolve(queue.shift()) : Promise.reject(new Error('extra query'))).then(ok, err) };
  };
  fn.batches = [];
  fn.transaction = async (qs) => { fn.batches.push(qs.map((q) => q.call)); return qs.map(() => queue.shift()); };
  return fn;
}
const bound = (call, needle) => {
  const n = needle.replace(/\s+/g, ' ');
  const at = call.norm.indexOf(n);
  expect(at, `SQL lacks ${n}`).toBeGreaterThan(-1);
  return call.values[(call.norm.slice(0, at + n.length).match(/\?/g) ?? []).length];
};

describe('the plan the dry run prints is what the PATCH binds', () => {
  const shapes = [
    ['deep freezer, never moved (prod)', {}],
    ['fridge-freezer', { storage_kind: 'fridge_freezer' }],
    ['no recorded place', { storage_kind: null, storage_location_id: null }],
    ['pantry shelf', { storage_kind: 'pantry' }],
    ['moved', { storage_moved_at: new Date('2026-09-01T12:00:00Z') }],
    ['typed date', { use_by_basis: 'typed', use_by_target: d('2026-12-01') }],
  ];
  it.each(shapes)('%s', async (_, over) => {
    const j = jar(over);
    const plan = planRefile(j);
    const sql = mockSql([[{ ...j, row_version: '7' }], [], [{ ...j, method: TO_METHOD }]]);
    const r = await handleJarRoute({
      sql, rawPath: `/api/preservation/${j.id}`, method: 'PATCH', rawBody: JSON.stringify({ method: TO_METHOD }),
      userId: j.user_id, householdIds: [j.user_id],
    });
    expect(r.status).toBe(200);
    const [guc, update] = sql.batches[0];
    expect(guc.norm).toMatch(/set_config\('app\.actor_clerk_sub', \? , true\)/);
    expect(guc.values).toEqual([j.user_id]);
    expect(bound(update, 'method = CASE WHEN ? ::boolean THEN')).toBe(plan.after.method);
    const writesDate = bound(update, 'use_by_target = CASE WHEN');
    const stored = writesDate
      ? { use_by_target: day(bound(update, 'use_by_target = CASE WHEN ? ::boolean THEN')), use_by_basis: bound(update, 'use_by_basis = CASE WHEN ? ::boolean THEN') }
      : { use_by_target: plan.before.use_by_target, use_by_basis: plan.before.use_by_basis };
    expect(stored).toEqual({ use_by_target: plan.after.use_by_target, use_by_basis: plan.after.use_by_basis });
  });
});

describe('main — writes only through the handler, only with --i-mean-it, as each jar\'s owner', () => {
  const ENV = { [ENV_KEY]: 'postgresql://owner:hunter2@ep-test.neon.tech/neondb' };
  let out;
  afterEach(() => vi.restoreAllMocks());
  const capture = () => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => out.push(a.join(' ')));
  };

  // Scripted driver + handler. `stored` is what the re-read returns after a PATCH; `audits` what audit_events holds.
  function harness(rows, { status = 200, stored = (j) => ({ method: 'pesto', use_by_target: '2027-08-19', use_by_basis: 'table', updated_at: 'u1', user_id: j.user_id }), audits = () => [] } = {}) {
    const calls = { handler: [], reads: 0, loadedHandler: 0 };
    const stubState = {};
    let current = null;
    const sql = (strings) => {
      const text = strings.join('?');
      if (/FROM preservation_log p\s+LEFT JOIN storage_location/.test(text)) { calls.reads += 1; return Promise.resolve(rows); }
      if (/now\(\)::text AS t0/.test(text)) return Promise.resolve([{ t0: '2026-09-30 00:00:00+00', prior: { method: 'passata', use_by_target: '2027-08-19', use_by_basis: 'table', updated_at: 'u0' } }]);
      if (/to_jsonb\(p\) AS row/.test(text)) return Promise.resolve([{ row: stored(current) }]);
      if (/FROM audit_events/.test(text)) return Promise.resolve(audits(current));
      return Promise.reject(new Error(`unexpected SQL: ${text}`));
    };
    const deps = {
      loadDriver: async () => ({ neon: () => sql, version: 'test' }),
      loadHandler: async () => {
        calls.loadedHandler += 1;
        return {
          stubState,
          handler: async (event) => {
            current = rows.find((r) => event.rawPath.endsWith(r.id));
            calls.handler.push({ path: event.rawPath, verb: event.requestContext.http.method, body: event.body, sub: stubState.verifyTokenResult?.sub });
            return { statusCode: status, body: '{}' };
          },
        };
      },
    };
    return { calls, deps };
  }

  it('a dry run reads and never invokes the handler', async () => {
    capture();
    const { calls, deps } = harness([jar(), jar({ id: J2 })]);
    expect(await main(['--jar', J1, '--jar', J2], ENV, deps)).toBe(0);
    expect(calls.reads).toBe(1);
    expect(calls.handler).toEqual([]);
    expect(out.join('\n')).toMatch(/DRY RUN: 2 jar\(s\) would be re-filed as pesto\. Nothing was written/);
  });

  it('one refused target writes nothing, even with --i-mean-it', async () => {
    capture();
    const { calls, deps } = harness([jar(), jar({ id: J3, crop_type_slug: 'tomato', crop_display_name: 'Tomato' })]);
    expect(await main(['--jar', J1, '--jar', J3, '--i-mean-it'], ENV, deps)).toBe(2);
    expect(calls.handler).toEqual([]);
    const missing = harness([jar()]);
    expect(await main(['--jar', J1, '--jar', J2, '--i-mean-it'], ENV, missing.deps)).toBe(2);
    expect(missing.calls.handler).toEqual([]);
    expect(out.join('\n')).toMatch(/no such jar/);
  });

  it('already pesto is a no-op, even with --i-mean-it', async () => {
    capture();
    const { calls, deps } = harness([jar({ method: 'pesto' })]);
    expect(await main(['--jar', J1, '--i-mean-it'], ENV, deps)).toBe(0);
    expect(calls.handler).toEqual([]);
    expect(out.join('\n')).toMatch(/Nothing to do/);
  });

  it('--i-mean-it sends exactly PATCH {"method":"pesto"} per jar, as that jar\'s owner', async () => {
    capture();
    const { calls, deps } = harness([jar(), jar({ id: J2, user_id: 'user_jen' })]);
    expect(await main(['--jar', J1, '--jar', J2, '--i-mean-it'], ENV, deps)).toBe(0);
    expect(calls.handler).toEqual([
      { path: `/api/preservation/${J1}`, verb: 'PATCH', body: '{"method":"pesto"}', sub: 'user_dave' },
      { path: `/api/preservation/${J2}`, verb: 'PATCH', body: '{"method":"pesto"}', sub: 'user_jen' },
    ]);
    expect(out.join('\n')).toMatch(/no audit_events row\. .*no watched column changed/);
  });

  it('fails (exit 3) when the handler refuses, when the stored row differs from the plan, or when the audit is wrong', async () => {
    capture();
    expect(await main(['--jar', J1, '--i-mean-it'], ENV, harness([jar()], { status: 409 }).deps)).toBe(3);
    // A 200 whose stored row is not the plan: the method did not land, or the date is not the rule's. Each case is
    // otherwise clean (no watched column moved, or its audit row is the owner's), so only the plan check can fail it.
    const unmoved = harness([jar()], { stored: () => ({ method: 'passata', use_by_target: '2027-08-19', use_by_basis: 'table', updated_at: 'u1' }) });
    expect(await main(['--jar', J1, '--i-mean-it'], ENV, unmoved.deps)).toBe(3);
    const drifted = harness([jar()], {
      stored: () => ({ method: 'pesto', use_by_target: '2027-06-19', use_by_basis: 'table', updated_at: 'u1' }),
      audits: () => [{ id: 'a0', action: 'UPDATE', actor_clerk_sub: 'user_dave', ts: new Date(), before_jsonb: {}, after_jsonb: { updated_at: 'u1' } }],
    });
    expect(await main(['--jar', J1, '--i-mean-it'], ENV, drifted.deps)).toBe(3);
    // A watched column moved (use_by_target) and the trigger wrote nothing.
    const unaudited = harness([jar({ storage_kind: 'fridge_freezer' })], { stored: () => ({ method: 'pesto', use_by_target: '2026-12-19', use_by_basis: 'table', updated_at: 'u1' }) });
    expect(await main(['--jar', J1, '--i-mean-it'], ENV, unaudited.deps)).toBe(3);
    // The trigger wrote a row, but not as the jar's owner (the GUC was lost).
    const system = harness([jar({ storage_kind: 'fridge_freezer' })], {
      stored: () => ({ method: 'pesto', use_by_target: '2026-12-19', use_by_basis: 'table', updated_at: 'u1' }),
      audits: () => [{ id: 'a1', action: 'UPDATE', actor_clerk_sub: 'system', ts: new Date(), before_jsonb: {}, after_jsonb: { updated_at: 'u1' } }],
    });
    expect(await main(['--jar', J1, '--i-mean-it'], ENV, system.deps)).toBe(3);
    const owner = harness([jar({ storage_kind: 'fridge_freezer' })], {
      stored: () => ({ method: 'pesto', use_by_target: '2026-12-19', use_by_basis: 'table', updated_at: 'u1' }),
      audits: () => [{ id: 'a1', action: 'UPDATE', actor_clerk_sub: 'user_dave', ts: new Date(), before_jsonb: {}, after_jsonb: { updated_at: 'u1' } }],
    });
    expect(await main(['--jar', J1, '--i-mean-it'], ENV, owner.deps)).toBe(0);
  });

  it('never prints the database URL, refuses without it, and loads nothing before its own checks pass', async () => {
    capture();
    const ok = harness([jar()]);
    expect(await main(['--jar', J1], ENV, ok.deps)).toBe(0);
    expect(out.join('\n')).toMatch(/target ep-test\.neon\.tech\/neondb/);
    const none = harness([jar()]);
    expect(await main(['--jar', J1], {}, none.deps)).toBe(1);
    expect(await main(['--jar', J1, ENV[ENV_KEY]], ENV, none.deps)).toBe(1);
    expect(none.calls.loadedHandler).toBe(0);
    expect(out.join('\n')).not.toMatch(/hunter2|owner:/);
  });
});

describe('the audit explanation is the trigger\'s own list', () => {
  it('AUDIT_WATCHED is exactly what v5-putupmake-001 0a gives trg_audit_preservation_log_upd, and not method', () => {
    const ddl = readFileSync(join(here, '..', 'migrations', 'v5-putupmake-001', '0a-additive-ddl.sql'), 'utf8');
    const m = ddl.match(/CREATE TRIGGER trg_audit_preservation_log_upd[\s\S]*?audit_stmt_update\(([\s\S]*?)\);/);
    expect(m, 'trigger definition not found').not.toBeNull();
    expect([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toEqual(AUDIT_WATCHED);
    expect(AUDIT_WATCHED).not.toContain('method');
  });
});
