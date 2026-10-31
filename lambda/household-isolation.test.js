// GUARD: security (OPS-SECREVIEW-001 do-not-remove list)
// HOUSEHOLD-MODE isolation guard (G3).
// Asserts householdScope is imported in EXACTLY the 6 in-scope surfaces and in NONE of
// the out-of-scope Lambdas. Catches accidental scope creep (a future edit that widens an
// out-of-scope handler) and accidental scope loss (an in-scope file losing the import).
// Static-source / filesystem scan — DB-free.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from './_test-stubs/state.js';
import { setHouseholdDefault } from './_test-stubs/householdDefault.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = __dirname;

// In-scope: the 6 surfaces that import householdScope.
const IN_SCOPE = [
  'projects/index.js',
  'plants/index.js',
  'events/index.js',
  'inventory-items/index.js',
  'photos/index.js',
  'dashboard/handlers.js',
  'locations/index.js',
  'findings/index.js', // DRG findings read model — household-scoped reads (created_by = ANY(householdIds))
  'tags/index.js', // V4-TAGSUB faceted tag visibility — shared tags widen to householdScope
  'daily-plan-read/index.js', // V4-ASSIGNLENS-001 — OPT-IN ?include=household widening (default stays per-user)
  'preservation/index.js', // V4-HARVESTCENTER-001 — Put-Up log is household-shared inventory (user_id = ANY(householdIds))
  'storage-location/index.js', // V4-HARVESTCENTER-001 — Put-Up storage vocab, household-scoped like locations
  'harvests/index.js', // V4-HARVESTVIEW-001 — Harvests read model, household-scoped (plant_projects.created_by = ANY(householdIds))
  'facebook-share/index.js', // V4-FBSHARE-001 — admin-only FB share; photo fetch scoped to household (photos.created_by = ANY(householdIds))
  'members/index.js', // 0A.6 — caretaker roster filtered to the caller household (Clerk list ∩ householdScope; was every Clerk user w/ email)
  // V4-VARIETYHOUSEHOLD-001 — MOVED here from OUT_OF_SCOPE (2026-08-07, Dave-approved). PUT/DELETE
  // /api/varieties/:id were owner-only, which left the 25 cultivars stamped by offline intake/repair
  // principals uneditable by every human. Writes are now household-scoped plus a membership-gated
  // managed-principal arm (varieties/authz.js). READS were already global and are unchanged.
  'varieties/index.js',
  // BUG-AUTHZFKENUM-001 (2026-08-10) — MOVED here from having no scoping at all. The handler's own
  // header carried a "HOUSEHOLD NOTE (V1.1, at wire time): add household-scoped write authz" TODO;
  // the audit found it was shipping two body-settable FKs (evidence.garden_node_id and the
  // planting-typed arm of evidence.entity_id) with existence checks only, so the TODO is discharged
  // now rather than at wire time. Reads are unaffected — this Lambda is POST-only.
  'evidence-ingest/index.js',
];

// Out-of-scope: must NOT import householdScope.
const OUT_OF_SCOPE = [
  'achievements/index.js',
  'favorites/index.js',
  'xp-reconcile/index.js',
  'app-events/index.js',
  'dashboard/index.js', // wrapper — householdScope is computed inside builders, not the wrapper
  // The critter stickerbook is per person even with GARDEN_HOUSEHOLD_IDS set (Dave's ruling, SEC-13a):
  // its rows are scoped to the caller's own sub. Twin on real Postgres: tests/integration/critter.int.test.js.
  'critter/index.js',
];

const IMPORT_RE = /import \{[^}]*\bhouseholdScope\b[^}]*\} from '\.\/household\.js'/;

function read(rel) {
  return readFileSync(resolve(LAMBDA_ROOT, rel), 'utf8');
}

// A construct NAMED IN A COMMENT is not that construct: an `import { householdScope } ...` line
// left behind in a comment after the real import was deleted satisfies IMPORT_RE and the in-scope
// guard below passes with the surface unscoped. The `//` arm is URL-safe (the `[^:]` guard keeps
// `https://` intact); the `--` arm requires surrounding space so a JS decrement is never read as a
// SQL comment. Used for the POSITIVE assertion only — the out-of-scope census stays on raw text,
// where a merely-commented mention is still worth flagging.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const readCode = (rel) => decomment(read(rel));

function exists(rel) {
  try { statSync(resolve(LAMBDA_ROOT, rel)); return true; } catch { return false; }
}

describe('Household Mode — surface isolation (G3)', () => {
  for (const f of IN_SCOPE) {
    it(`${f} imports householdScope (in scope)`, () => {
      expect(readCode(f)).toMatch(IMPORT_RE);
    });
  }

  for (const f of OUT_OF_SCOPE) {
    it(`${f} does NOT import householdScope (out of scope)`, () => {
      if (!exists(f)) return; // tolerate absent optional lambdas
      expect(read(f)).not.toMatch(/householdScope/);
    });
  }

  it('no Lambda outside the 6 in-scope surfaces references householdScope', () => {
    // Walk all index.js + handlers.js under lambda/ and assert householdScope appears
    // ONLY in the in-scope set. This catches any new out-of-scope file we did not enumerate.
    const inScopeAbs = new Set(IN_SCOPE.map(r => resolve(LAMBDA_ROOT, r)));
    const offenders = [];
    for (const entry of readdirSync(LAMBDA_ROOT)) {
      const dir = join(LAMBDA_ROOT, entry);
      let isDir = false;
      try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
      if (!isDir) continue;
      for (const name of ['index.js', 'handlers.js']) {
        const abs = join(dir, name);
        if (!exists(abs)) continue;
        const src = readFileSync(abs, 'utf8');
        if (/householdScope/.test(src) && !inScopeAbs.has(abs)) {
          offenders.push(`${entry}/${name}`);
        }
      }
    }
    expect(offenders, `unexpected householdScope reference(s): ${offenders.join(', ')}`).toEqual([]);
  });
});

// ── SEC-13a: the household-member gate in every HTTP handler ─────────────────────────────────────────────────────
// Every handler that verifies a Clerk token must refuse a caller outside GARDEN_HOUSEHOLD_IDS with the one generic
// 403, after verifyToken and the empty-sub 401 (an unauthenticated or garbage token stays 401: deploy.yml's prod
// smoke needs exactly 401) and before neon(), a rate limit, a Clerk call, a read or a write. The row predicates are
// the second layer; the integration suite tests them member against member.
const MANIFEST = JSON.parse(readFileSync(resolve(LAMBDA_ROOT, '../scripts/lambda-config-expected.json'), 'utf8'));
const URL_DIRS = Object.entries(MANIFEST)
  .filter(([fn, spec]) => fn.startsWith('garden-') && spec && spec.url !== null && typeof spec.url === 'object')
  .map(([fn]) => fn.slice('garden-'.length))
  .sort();
const VERIFY_DIRS = readdirSync(LAMBDA_ROOT)
  .filter((d) => exists(join(d, 'index.js')) && /verifyToken\(|requestContext\(/.test(readCode(`${d}/index.js`)))
  .sort();
const GATE_IMPORT = /^import \{[^}]*\bhouseholdGate\b[^}]*\} from '\.\/household\.js';?$/m;
const GATE_CALL = /const gateRefusal = householdGate\(userId\);?\n\s*if \(gateRefusal\) return resp\(gateRefusal\.status, gateRefusal\.body\)/;
const WORK = /\bneon\(|checkRateLimit\(|sql`|createClerkClient\(|getUserList\(/;
// D2 sign-in kit (lambda/request-context.js). A handler whose index.js calls requestContext( signs in through its dir's
// kit copy, which ships in the same zip and is held byte-equal to the master below and by gen-lambda-copies --check, so
// the per-handler checks read that copy. The kit spells the three refusal lines as the handlers did.
const KIT_IMPORT = /^import \{[^}]*\brequestContext\b[^}]*\} from '\.\/request-context\.js';?$/m;
const KIT_CALL = /const ctx = await requestContext\(event\b[\s\S]*?\);\n\s*if \(ctx\.response\) return ctx\.response;/;
const KIT_FN = 'export async function requestContext(';
const HANDLER_START = /export (?:const handler\b|async function handler\b)/;
const usesKit = (d) => /requestContext\(/.test(readCode(`${d}/index.js`));
const signInSource = (d) => readCode(usesKit(d) ? `${d}/request-context.js` : `${d}/index.js`);

describe('SEC-13a household gate — every HTTP handler', () => {
  it('SEC-13a: the handlers that verify a Clerk token are exactly the manifest\'s URL functions', () => {
    expect(VERIFY_DIRS.length).toBeGreaterThanOrEqual(20);
    expect(VERIFY_DIRS).toEqual(URL_DIRS);
  });

  for (const d of VERIFY_DIRS) {
    it(`SEC-13a: ${d}/index.js gates right after the empty-sub 401 and before any statement`, () => {
      const src = signInSource(d);
      expect(src).toMatch(GATE_IMPORT);
      expect(src).toMatch(GATE_CALL);
      const verify = src.indexOf('verifyToken(');
      const sub401 = src.search(/if \(!userId\) return resp\(401/);
      const gate = src.indexOf('householdGate(userId)');
      expect(verify).toBeGreaterThan(-1);
      expect(sub401).toBeGreaterThan(verify);
      expect(gate).toBeGreaterThan(sub401);
      expect(src.slice(verify, gate)).not.toMatch(WORK);
      if (usesKit(d)) {
        // The handler hands the kit the request before anything else: nothing before the call may issue a statement,
        // answer early or wait on anything, and it must not sign in a second way of its own.
        const index = readCode(`${d}/index.js`);
        expect(index).toMatch(KIT_IMPORT);
        expect(index).toMatch(KIT_CALL);
        expect(index).not.toMatch(/verifyToken\(/);
        const start = index.search(HANDLER_START);
        expect(start).toBeGreaterThan(-1);
        const beforeKit = index.slice(start, index.search(KIT_CALL));
        expect(beforeKit).not.toMatch(WORK);
        expect(beforeKit).not.toMatch(/\breturn\b|\bawait\b/);
        expect(read(`${d}/request-context.js`)).toBe(read('request-context.js'));
      }
    });
  }

  // Sliced from the function so the helper definitions above it (getSecrets, azpAllowed) cannot stand in for the calls.
  it('D2: the sign-in kit refuses in order before any statement: OPTIONS, secrets, Clerk, azp, empty sub, gate, then neon and scope', () => {
    const master = readCode('request-context.js');
    expect(master.indexOf(KIT_FN)).toBeGreaterThan(-1);
    const kit = master.slice(master.indexOf(KIT_FN));
    const steps = ["'OPTIONS'", 'getSecrets(', 'verifyToken(', 'azpAllowed(', 'if (!userId) return resp(401', 'householdGate(userId)', 'neon(', 'scope('];
    const at = steps.map((s) => kit.indexOf(s));
    expect(at[0], steps[0]).toBeGreaterThan(-1);
    for (let i = 1; i < steps.length; i += 1) expect(at[i], `${steps[i]} after ${steps[i - 1]}`).toBeGreaterThan(at[i - 1]);
    expect(kit.slice(0, at[steps.indexOf('householdGate(userId)')])).not.toMatch(WORK);
  });

  // T8 (D2 F, secreview C6): every handler signs in through its kit copy, and no other non-test file in its dir calls
  // Clerk's verifyToken, so neither the allow-list nor the azp rule has a second way around it.
  it('D2 T8: every handler signs in through its kit, and no other non-test file in a handler dir calls verifyToken(', () => {
    const jsFiles = (dir) => readdirSync(join(LAMBDA_ROOT, dir)).flatMap((e) => {
      const rel = `${dir}/${e}`;
      if (e === 'node_modules') return [];
      if (statSync(join(LAMBDA_ROOT, rel)).isDirectory()) return jsFiles(rel);
      return /\.[cm]?js$/.test(e) && !/\.test\.[cm]?js$/.test(e) ? [rel] : [];
    });
    expect(URL_DIRS.length).toBeGreaterThanOrEqual(20);
    expect(URL_DIRS.filter((d) => !usesKit(d))).toEqual([]);
    expect(URL_DIRS.filter((d) => !/verifyToken\(/.test(readCode(`${d}/request-context.js`)))).toEqual([]);
    const callers = URL_DIRS.flatMap(jsFiles).filter((f) => !f.endsWith('/request-context.js') && /verifyToken\(/.test(readCode(f)));
    expect(callers).toEqual([]);
  });
});

// T7: one member request per handler that reaches the routes. `binds`: some statement binds the member's sub, so a
// handler that hands its routes the wrong variable reds here. members proves it through the Clerk roster filter,
// facebook-share through its admin check (flag off: 503 only once isAdmin(userId) passed), shared-state by reaching a
// statement (its reads are not per user). `rows` is what every statement returns.
const WIRING = {
  achievements: { binds: true },
  'app-events': { method: 'POST', path: '/api/app-events', body: { event_name: 'wiring' }, binds: true },
  critter: { path: '/api/critters/collection', binds: true },
  'daily-plan-read': { path: '/api/daily-plan', binds: true },
  dashboard: { binds: true },
  events: { binds: true },
  'evidence-ingest': {
    method: 'POST',
    path: '/api/evidence',
    body: { entity_id: '11111111-1111-4111-8111-111111111111', schema_version: 1, tier: 'first_party_log', axis: 'local', polarity: 'supporting', observed_at: '2026-06-16T00:00:00Z' },
    rows: [{ id: '11111111-1111-4111-8111-111111111111', planting_ref_id: '22222222-2222-4222-8222-222222222222' }],
    binds: true,
  },
  'facebook-share': { method: 'POST', path: '/api/share/facebook', admin: true },
  favorites: { binds: true },
  findings: { binds: true },
  harvests: { binds: true },
  'inventory-items': { binds: true },
  locations: { binds: true },
  members: { roster: true },
  photos: { binds: true },
  plants: { binds: true },
  preservation: { binds: true },
  projects: { binds: true },
  'shared-state': { path: '/api/shared-state/featured-of-day' },
  'storage-location': { binds: true },
  tags: { binds: true },
  'ux-events': { method: 'POST', path: '/api/ux-events', body: { flow_id: 'log_watering', session_id: 'wiring' }, binds: true },
  varieties: { path: '/api/varieties/deleted', binds: true },
};

describe('SEC-13a household gate — every handler, executed under the stubs', () => {
  const MEMBER = 'user_sec13a_member';
  const MATE = 'user_sec13a_mate';
  const STRANGER = 'user_sec13a_stranger';
  let warn;
  const denials = () => warn.mock.calls
    .map((c) => { try { return JSON.parse(c[0]); } catch { return null; } })
    .filter((o) => o?.msg === 'household-membership-denied');
  const call = async (d, sub) => {
    stubState.verifyTokenResult = { sub };
    const { handler } = await import(`./${d}/index.js`);
    const res = await handler({
      requestContext: { http: { method: 'GET' } },
      rawPath: `/api/${d}`,
      headers: { authorization: 'Bearer sec13a' },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };

  beforeEach(() => {
    resetStubs();
    setHouseholdDefault(false);
    vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${MEMBER},${MATE}`);
    vi.stubEnv('S3_PHOTOS_BUCKET', 'garden-photos-stub'); // facebook-share throws at module load without it
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each(URL_DIRS)('SEC-13a: %s refuses a verified non-member with the generic 403 before any statement', async (d) => {
    const r = await call(d, STRANGER);
    expect(r).toEqual({ status: 403, body: { error: 'Forbidden' } });
    expect(stubState.sqlCalls).toEqual([]);
    expect(stubState.clerkListCalls).toEqual([]);
    expect(denials()).toEqual([{ msg: 'household-membership-denied', userId: STRANGER, reason: 'non-member' }]);
  });

  it.each(URL_DIRS)('SEC-13a: %s admits a listed member past the gate', async (d) => {
    const r = await call(d, MATE);
    expect(r.status).not.toBe(401);
    expect(denials()).toEqual([]);
  });

  it.each(URL_DIRS)('SEC-13a: %s refuses even a member when the list is unset (fails closed)', async (d) => {
    delete process.env.GARDEN_HOUSEHOLD_IDS;
    const r = await call(d, MEMBER);
    expect(r).toEqual({ status: 403, body: { error: 'Forbidden' } });
    expect(stubState.sqlCalls).toEqual([]);
    expect(denials().map((x) => x.reason)).toEqual(['env-missing']);
  });

  it.each(URL_DIRS)('SEC-13a: %s still answers 401 to a token Clerk rejects (the gate never runs first)', async (d) => {
    stubState.verifyTokenResult = new Error('garbage token');
    const { handler } = await import(`./${d}/index.js`);
    const res = await handler({ requestContext: { http: { method: 'GET' } }, rawPath: `/api/${d}`, headers: { authorization: 'Bearer ci.smoke.probe' } });
    expect(res.statusCode).toBe(401);
    expect(denials()).toEqual([]);
  });

  // SEC-60: Clerk passes `sub: ''`; householdScope('') is [''] and matches every row owned by ''.
  it.each(URL_DIRS)('SEC-60: %s answers 401 to a verified token with an empty subject, before the gate and any statement', async (d) => {
    const r = await call(d, '');
    expect(r).toEqual({ status: 401, body: { error: 'Unauthorized' } });
    expect(stubState.sqlCalls).toEqual([]);
    expect(stubState.clerkListCalls).toEqual([]);
    expect(denials()).toEqual([]);
  });

  // T8 (D2 F): azp is the kit's own rule (Clerk lets a token with no azp through). The stub's azp default is off, so
  // the payload really has none; a listed member is used so only the azp rule can refuse it.
  it.each(URL_DIRS)('D2 T8: %s answers 401 to a verified token with no azp and no issuer, before the gate and any statement', async (d) => {
    stubState.azpDefault = false;
    const r = await call(d, MEMBER);
    expect(r).toEqual({ status: 401, body: { error: 'Unauthorized' } });
    expect(stubState.sqlCalls).toEqual([]);
    expect(stubState.clerkListCalls).toEqual([]);
    expect(denials()).toEqual([]);
  });

  it.each(URL_DIRS)('D2 wiring: %s hands its routes the signed-in member', async (d) => {
    const w = WIRING[d];
    expect(w, `${d} needs a WIRING row`).toBeDefined();
    if (w.admin) {
      vi.stubEnv('ADMIN_CLERK_SUBS', MEMBER);
      vi.stubEnv('FB_SHARE_ENABLED', '0');
    }
    if (w.rows) stubState.sqlHandler = () => w.rows;
    stubState.verifyTokenResult = { sub: MEMBER };
    const { handler } = await import(`./${d}/index.js`);
    const res = await handler({
      requestContext: { http: { method: w.method ?? 'GET' } },
      rawPath: w.path ?? `/api/${d}`,
      headers: { authorization: 'Bearer wiring' },
      body: w.body ? JSON.stringify(w.body) : undefined,
    });
    expect(denials()).toEqual([]);
    const bound = stubState.sqlCalls.flatMap((c) => c.values.flat(Infinity));
    if (w.admin) {
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe('facebook_sharing_disabled');
    } else if (w.roster) {
      expect(stubState.clerkListCalls.map((c) => c.userId)).toContainEqual(expect.arrayContaining([MEMBER]));
    } else {
      expect(stubState.sqlCalls.length).toBeGreaterThan(0);
      if (w.binds) expect(bound).toContain(MEMBER);
    }
  });
});
