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
  .filter((d) => exists(join(d, 'index.js')) && /verifyToken\(/.test(readCode(`${d}/index.js`)))
  .sort();
const GATE_IMPORT = /^import \{[^}]*\bhouseholdGate\b[^}]*\} from '\.\/household\.js';?$/m;
const GATE_CALL = /const gateRefusal = householdGate\(userId\);?\n\s*if \(gateRefusal\) return resp\(gateRefusal\.status, gateRefusal\.body\)/;
const WORK = /\bneon\(|checkRateLimit\(|sql`|createClerkClient\(|getUserList\(/;

describe('SEC-13a household gate — every HTTP handler', () => {
  it('SEC-13a: the handlers that verify a Clerk token are exactly the manifest\'s URL functions', () => {
    expect(VERIFY_DIRS.length).toBeGreaterThanOrEqual(20);
    expect(VERIFY_DIRS).toEqual(URL_DIRS);
  });

  for (const d of VERIFY_DIRS) {
    it(`SEC-13a: ${d}/index.js gates right after the empty-sub 401 and before any statement`, () => {
      const src = readCode(`${d}/index.js`);
      expect(src).toMatch(GATE_IMPORT);
      expect(src).toMatch(GATE_CALL);
      const verify = src.indexOf('verifyToken(');
      const sub401 = src.search(/if \(!userId\) return resp\(401/);
      const gate = src.indexOf('householdGate(userId)');
      expect(verify).toBeGreaterThan(-1);
      expect(sub401).toBeGreaterThan(verify);
      expect(gate).toBeGreaterThan(sub401);
      expect(src.slice(verify, gate)).not.toMatch(WORK);
    });
  }
});

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

  it.each(VERIFY_DIRS)('SEC-13a: %s refuses a verified non-member with the generic 403 before any statement', async (d) => {
    const r = await call(d, STRANGER);
    expect(r).toEqual({ status: 403, body: { error: 'Forbidden' } });
    expect(stubState.sqlCalls).toEqual([]);
    expect(stubState.clerkListCalls).toEqual([]);
    expect(denials()).toEqual([{ msg: 'household-membership-denied', userId: STRANGER, reason: 'non-member' }]);
  });

  it.each(VERIFY_DIRS)('SEC-13a: %s admits a listed member past the gate', async (d) => {
    const r = await call(d, MATE);
    expect(r.status).not.toBe(401);
    expect(denials()).toEqual([]);
  });

  it.each(VERIFY_DIRS)('SEC-13a: %s refuses even a member when the list is unset (fails closed)', async (d) => {
    delete process.env.GARDEN_HOUSEHOLD_IDS;
    const r = await call(d, MEMBER);
    expect(r).toEqual({ status: 403, body: { error: 'Forbidden' } });
    expect(stubState.sqlCalls).toEqual([]);
    expect(denials().map((x) => x.reason)).toEqual(['env-missing']);
  });

  it.each(VERIFY_DIRS)('SEC-13a: %s still answers 401 to a token Clerk rejects (the gate never runs first)', async (d) => {
    stubState.verifyTokenResult = new Error('garbage token');
    const { handler } = await import(`./${d}/index.js`);
    const res = await handler({ requestContext: { http: { method: 'GET' } }, rawPath: `/api/${d}`, headers: { authorization: 'Bearer ci.smoke.probe' } });
    expect(res.statusCode).toBe(401);
    expect(denials()).toEqual([]);
  });
});
