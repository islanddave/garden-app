// resolveContainerForCultivar — server-side container assignment for new plantings.
//
// THE BUG: projects were sunset from the UI, so CaptureFlow ("Snap") posts `project_id: null` on
// every create (src/pages/CaptureFlow.jsx:386). Nothing filled the gap, so plantings landed with
// container_id NULL — 7 of them in prod between 2026-08-13 and 2026-08-30, against 269/269 carrying
// one on 2026-08-04. A project-less harvest then took the public site's hourly publisher down.
//
// WHY THE PREDICATE'S SHAPE IS THE POINT, and why these tests assert it rather than just "returns
// something": the container's NAME IS THE PUBLISHED CROP on gam-site. Assigning a merely-plausible
// container publishes a tomato to the world as a pepper, so a wrong answer here is worse than the
// null it replaces. The purity guard is the safety property; a test suite that let it be dropped
// while staying green would be worse than no suite.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveContainerForCultivar } from './authz-parents.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOUSE = ['user_a', 'user_b'];
const CULTIVAR = '00000000-0000-4000-8000-0000000000aa';
const CONTAINER = '11111111-1111-4111-8111-111111111111';

// Fake neon tagged-template, same shape as authz-write-fk.test.js: records SQL text + bound values.
function fakeSql(result = []) {
  const calls = [];
  const fn = (strings, ...values) => { calls.push({ text: strings.join('?'), values }); return Promise.resolve(result); };
  fn.calls = calls;
  return fn;
}

describe('resolveContainerForCultivar', () => {
  it('returns the container id when the query matches one', async () => {
    const sql = fakeSql([{ id: CONTAINER }]);
    expect(await resolveContainerForCultivar(sql, CULTIVAR, HOUSE)).toBe(CONTAINER);
  });

  // Null is the status quo — the state every caller already handles — so "no confident match"
  // must degrade to it rather than to a guess.
  it('returns null when nothing matches', async () => {
    const sql = fakeSql([]);
    expect(await resolveContainerForCultivar(sql, CULTIVAR, HOUSE)).toBeNull();
  });

  // Short-circuit BEFORE any SQL: a malformed id must not reach the database and 22P02 its way to
  // an opaque 500, matching the guard every other loader in this file carries.
  it('short-circuits a malformed cultivar id without issuing SQL', async () => {
    const sql = fakeSql([{ id: CONTAINER }]);
    expect(await resolveContainerForCultivar(sql, 'not-a-uuid', HOUSE)).toBeNull();
    expect(sql.calls).toHaveLength(0);
  });

  it('short-circuits a null cultivar — a planting with no variety has nothing to derive from', async () => {
    const sql = fakeSql([{ id: CONTAINER }]);
    expect(await resolveContainerForCultivar(sql, null, HOUSE)).toBeNull();
    expect(sql.calls).toHaveLength(0);
  });

  // Exactly two bound values, in this order. The cultivar is bound ONCE — the two crop-type
  // comparisons both read it back through the `target` CTE rather than re-binding it, which is why
  // this is [CULTIVAR, HOUSE] and not [CULTIVAR, CULTIVAR, HOUSE]. Asserting the exact array is
  // deliberate: it fails if a future edit interpolates anything unbound into this SQL.
  it('binds the cultivar and the household ids, and nothing else', async () => {
    const sql = fakeSql([]);
    await resolveContainerForCultivar(sql, CULTIVAR, HOUSE);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].values).toEqual([CULTIVAR, HOUSE]);
  });

  // THE SAFETY PROPERTY, asserted structurally because it cannot be observed through a fake sql:
  // a candidate must hold the target crop and NOTHING ELSE. Without `other = 0` a mixed bed that
  // happens to contain one tomato becomes "the tomato container".
  it('requires the candidate container to be pure for the crop', async () => {
    const sql = fakeSql([]);
    await resolveContainerForCultivar(sql, CULTIVAR, HOUSE);
    const text = sql.calls[0].text.replace(/\s+/g, ' ');
    expect(text).toMatch(/other\s*=\s*0/);
    expect(text).toMatch(/same\s*>\s*0/);
    expect(text).toMatch(/IS DISTINCT FROM/);
  });

  it('scopes to the household and excludes deleted and archived containers', async () => {
    const sql = fakeSql([]);
    await resolveContainerForCultivar(sql, CULTIVAR, HOUSE);
    const text = sql.calls[0].text.replace(/\s+/g, ' ');
    expect(text).toMatch(/pp\.created_by\s*=\s*ANY/);
    expect(text).toMatch(/pp\.deleted_at IS NULL/);
    expect(text).toMatch(/pp\.archived_at IS NULL/);
    expect(text).toMatch(/pl\.deleted_at IS NULL/);
  });
});

// A resolver nobody invokes protects nothing — the same static-guard layer authz-write-fk.test.js
// uses, and the regression that would otherwise reappear silently the next time this handler is
// refactored. Asserts the INSERT binds the RESOLVED value, not the raw body field.
describe('POST /api/plants actually uses the resolver', () => {
  const src = readFileSync(join(here, 'plants', 'index.js'), 'utf8');

  it('imports resolveContainerForCultivar', () => {
    expect(src).toMatch(/import\s*\{[^}]*resolveContainerForCultivar[^}]*\}\s*from\s*'\.\/authz-parents\.js'/);
  });

  it('calls it when the body supplies no project_id', () => {
    expect(src).toMatch(/resolvedProjectId\s*=\s*await\s+resolveContainerForCultivar\(/);
  });

  // The load-bearing assertion. `${body.project_id}` in the VALUES list is the exact defect this
  // change removes; if a future edit puts it back, every Snap planting silently goes null again.
  it('binds the resolved value in the INSERT, never body.project_id', () => {
    const values = src.slice(src.indexOf('INSERT INTO public.garden_node'));
    const head = values.slice(0, values.indexOf('RETURNING'));
    expect(head).toMatch(/\$\{resolvedProjectId\}/);
    expect(head).not.toMatch(/\$\{body\.project_id\}/);
  });

  // A supplied id must still be ownership-gated: the resolver is a fallback, not a replacement for
  // the check that stops a caller hanging a planting off another household's container.
  it('still gates a caller-supplied project_id through loadOwnedProject', () => {
    expect(src).toMatch(/loadOwnedProject\(sql,\s*resolvedProjectId,\s*householdIds\)/);
  });
});
