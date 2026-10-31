// V3-REPARENT-001 regression guard (projects). Static-source per L-072 (DB-free).
// Runtime correctness (move/closure/cycle/dedup/version/restore) is proven separately
// against a Neon COW branch in the build session; this pins the wiring against drift.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import { handler, reparentCore } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const SRC = decomment(RAW);

describe('projects Lambda — V3-REPARENT-001 reparent + restore', () => {
  it('defines the /reparent and /reparent/restore matchers (extra segment, before idMatch)', () => {
    expect(SRC).toMatch(/reparentMatch = rawPath\.match\(\/\^\\\/api\\\/projects\\\/\(\[\^\/\]\+\)\\\/reparent\$\/\)/);
    expect(SRC).toMatch(/reparentRestoreMatch = rawPath\.match\(\/\^\\\/api\\\/projects\\\/\(\[\^\/\]\+\)\\\/reparent\\\/restore\$\/\)/);
    const idi = SRC.indexOf('const idMatch =');
    expect(SRC.indexOf('reparentMatch =')).toBeGreaterThan(-1);
    // restore handler must be checked before the bare reparent handler
    expect(SRC.indexOf('if (reparentRestoreMatch)')).toBeLessThan(SRC.indexOf('if (reparentMatch)'));
    // both handlers must run before the by-id block
    // The by-id block is delimited by a COMMENT banner, so this ordering check reads RAW offsets
    // (mixing RAW and decommented offsets would compare positions in two different strings).
    expect(RAW.indexOf('// --- /api/projects/:id ---')).toBeGreaterThan(-1);
    expect(RAW.indexOf('if (reparentMatch)')).toBeLessThan(RAW.indexOf('// --- /api/projects/:id ---'));
    expect(idi).toBeGreaterThan(-1);
  });

  it('reparent handler is POST-only and requires op_id + numeric expected_version', () => {
    const i = SRC.indexOf('if (reparentMatch)');
    const block = SRC.slice(i, i + 900);
    expect(block).toMatch(/method !== 'POST'/);
    expect(block).toMatch(/op_id is required/);
    expect(block).toMatch(/typeof body\.expected_version !== 'number'/);
    expect(block).toMatch(/new_parent_id \?\? null/); // null = move to root
  });

  it('restore handler resolves old_parent_id from the source reparent_event', () => {
    const i = SRC.indexOf('if (reparentRestoreMatch)');
    const block = SRC.slice(i, i + 1100);
    expect(block).toMatch(/source_op_id is required/);
    expect(block).toMatch(/SELECT old_parent_id FROM reparent_event/);
    expect(block).toMatch(/newParentId: src\[0\]\.old_parent_id/);
  });

  it('core is idempotent (op_id replay), version-guarded, snapshot-writing, cycle-aware', () => {
    const i = SRC.indexOf('export async function reparentCore');
    const block = SRC.slice(i);
    // idempotent replay short-circuit before any write
    expect(block).toMatch(/SELECT subject_id, new_parent_id, moved_at FROM reparent_event WHERE op_id = \$\{opId\}/);
    expect(block).toMatch(/replayed: true/);
    // optimistic concurrency
    expect(block).toMatch(/Version conflict/);
    expect(block).toMatch(/current_version/);
    // atomic CTE: snapshot -> event -> version-bumped update
    expect(block).toMatch(/INSERT INTO reparent_event/);
    expect(block).toMatch(/jsonb_build_object/);
    expect(block).toMatch(/version = version \+ 1/);
    expect(block).toMatch(/AND version = \$\{expectedVersion\}/);
    // trigger raises on cycle -> mapped to 422
    expect(block).toMatch(/cycle/i);
    expect(block).toMatch(/status: 422/);
    // op_id unique race -> replay, FK miss -> 422
    expect(block).toMatch(/reparent_op_uniq\|duplicate key/);
  });

  it('writes the base table plant_projects so the closure/acyclicity trigger fires', () => {
    const i = SRC.indexOf('export async function reparentCore');
    const block = SRC.slice(i);
    expect(block).toMatch(/UPDATE plant_projects/);
    expect(block).toMatch(/SET parent_project_id = \$\{newParentId\}/);
    // subject enum cast for the event row
    expect(block).toMatch(/'container'::node_class/);
  });
});

// D2b: the refusals a client branches on carry a stable code beside their unchanged text. Executed.
describe('projects Lambda — D2b codes on the refusals the client reads', () => {
  const USER = 'user_projects_codes';
  const P = '11111111-1111-4111-8111-111111111111';
  const Q = '22222222-2222-4222-8222-222222222222';
  const OWN_PARENT = { status: 400, body: { error: 'A project cannot be its own parent', code: 'project_own_parent' } };
  const call = async (method, rawPath, body) => {
    const r = await handler({
      requestContext: { http: { method } }, rawPath, headers: { authorization: 'Bearer stub-token' },
      body: JSON.stringify(body), queryStringParameters: {},
    });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  // reparentCore's reads in order: the op_id replay, the target, the new parent; then the move, which may throw.
  const core = (newParentId, moveError) => {
    const reads = [[], [{ id: P, old_parent: null, version: 3 }], [{ id: Q }]];
    const sql = async (strings) => {
      if (moveError && strings.join('?').includes('WITH tgt AS')) throw moveError;
      return reads.shift() ?? [];
    };
    return reparentCore(sql, { subjectId: P, newParentId, opId: 'op-1', expectedVersion: 3, userId: USER, householdIds: [USER] });
  };

  beforeEach(() => {
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  const loggedAt = (level) => console[level].mock.calls.map((a) => { try { return JSON.parse(a[0]); } catch { return null; } }).filter(Boolean);
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ADMIN_CLERK_SUBS;
  });

  it('reparentCore: a move under itself is 400 project_own_parent', async () => {
    expect(await core(P)).toEqual(OWN_PARENT);
  });

  it('PATCH: parent_project_id equal to the project is 400 project_own_parent', async () => {
    process.env.ADMIN_CLERK_SUBS = USER;
    expect(await call('PATCH', `/api/projects/${P}`, { parent_project_id: P })).toEqual(OWN_PARENT);
  });

  it('PUT: parent_project_id equal to the project is 400 project_own_parent', async () => {
    expect(await call('PUT', `/api/projects/${P}`, { parent_project_id: P })).toEqual(OWN_PARENT);
  });

  it('reparentCore: the trigger\'s cycle RAISE is 422 reparent_cycle', async () => {
    const raise = Object.assign(new Error('reparent would create a cycle'), { code: 'P0001' });
    expect(await core(Q, raise)).toEqual({ status: 422, body: { error: 'Move would create a cycle (target is a descendant of itself)', code: 'reparent_cycle' } });
  });

  it('reparentCore: a parent gone by the move is 422 reparent_parent_missing', async () => {
    const fk = Object.assign(new Error('insert or update on table "plant_projects" violates foreign key constraint "plant_projects_parent_project_id_fkey"'), { code: '23503' });
    expect(await core(Q, fk)).toEqual({ status: 422, body: { error: 'New parent does not exist', code: 'reparent_parent_missing' } });
  });

  it('a duplicate slug is 409 project_slug_conflict (it was a 500), naming neither the slug nor the constraint', async () => {
    stubState.sqlHandler = () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "plant_projects_slug_key"'), {
        code: '23505', constraint: 'plant_projects_slug_key', detail: 'Key (slug)=(tomatoes-2026) already exists.',
      });
    };
    expect(await call('POST', '/api/projects', { name: 'Tomatoes', slug: 'tomatoes-2026' }))
      .toEqual({ status: 409, body: { error: 'Slug already exists', code: 'project_slug_conflict' } });
    // A person's own duplicate is expected: WARN, so post-promote-check's `errors` does not count it.
    expect(loggedAt('warn')).toMatchObject([{ msg: 'projects lambda error', code: '23505', constraint: 'plant_projects_slug_key' }]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('any other unique collision is 409 unique_violation, not the slug code', async () => {
    stubState.sqlHandler = () => { throw Object.assign(new Error('duplicate key value violates unique constraint "x_key"'), { code: '23505', constraint: 'x_key' }); };
    expect(await call('POST', '/api/projects', { name: 'Tomatoes', slug: 'tomatoes-2026' }))
      .toEqual({ status: 409, body: { error: 'Unique violation', code: 'unique_violation' } });
    expect(loggedAt('error')).toMatchObject([{ msg: 'projects lambda error', code: '23505', constraint: 'x_key' }]);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
