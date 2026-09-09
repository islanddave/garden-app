// WS-A1 static-source security regression guard for the project share route.
//
// `/garden/:slug` is served by GET /api/projects/public/:slug. It was an UNAUTHENTICATED
// surface until 2026-09-09; the ordering assertion below has been INVERTED to match, and now
// pins the opposite of what it originally pinned. Three properties, all by inspecting index.js
// source (the house static-test style — same as select-columns.test.js / pubhide.static.test.js):
//
//   1. Ordering: the route is matched + dispatched AFTER the verifyToken() call, so an
//      unauthenticated request 401s and never reaches handlePublicProject. This is the guard
//      that the retired bypass cannot be reinstated by accident.
//   2. Still dispatched: the auth bypass was removed, the dispatch was NOT. This remains the
//      only code path serving the path, so dropping it would 405 the route for signed-in users
//      as well — "no longer public" must not silently become "no longer works".
//   3. Deny-by-default projection: the handlePublicProject body never selects or returns any
//      sensitive column. Kept in full after the auth gate landed — it is a narrower boundary,
//      not a redundant one; a regression that spreads a DB row or widens the SELECT surfaces
//      here rather than in prod.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('WS-A1 public share route', () => {
  it('declares the two-segment public path matcher', () => {
    // Cannot collide with the one-segment by-id idMatch (/api/projects/:id).
    // Source literal is /^\/api\/projects\/public\/([^/]+)$/ — assert the escaped path segment.
    expect(SRC).toContain('projects\\/public\\/([^/]+)$');
  });

  // INVERTED 2026-09-09 (was: "dispatches BEFORE verifyToken (unauthenticated reachability)").
  // The pre-auth early return was the app's last unauthenticated content surface and is retired;
  // this assertion is the thing that stops it coming back. Offsets are compared against the
  // 401-return of the auth block rather than the `verifyToken(` call alone, so moving the dispatch
  // into the middle of the try/catch would not satisfy it.
  it('matches + dispatches the route AFTER verifyToken() (no unauthenticated reachability)', () => {
    const handlerIdx = SRC.indexOf('export const handler');
    expect(handlerIdx).toBeGreaterThan(-1);
    // The dispatch CALL inside the handler (not the function definition above it).
    const callIdx = SRC.indexOf('handlePublicProject(publicMatch[1]', handlerIdx);
    const verifyIdx = SRC.indexOf('verifyToken(', handlerIdx);
    const unauthIdx = SRC.indexOf("return resp(401, { error: 'Unauthorized' })", handlerIdx);
    expect(callIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(unauthIdx).toBeGreaterThan(-1);
    expect(callIdx, 'public-slug dispatch is back above verifyToken — the WS-A1 bypass has returned')
      .toBeGreaterThan(verifyIdx);
    expect(callIdx, 'public-slug dispatch precedes the 401 return, so it is still reachable unauthenticated')
      .toBeGreaterThan(unauthIdx);
  });

  // Non-vacuity for the guard above: the dispatch must still EXIST. Only the auth bypass was
  // removed — this is the sole code path serving /api/projects/public/:slug (the two-segment path
  // cannot match the one-segment by-id idMatch), so deleting it would fall through to the handler's
  // trailing 405 and break the route for signed-in users too. An "is it after verifyToken" test
  // passes trivially against code that no longer serves the route at all; this one does not.
  it('still dispatches the route (removing the bypass must not remove the handler)', () => {
    expect(SRC).toContain('handlePublicProject(publicMatch[1]');
    expect(SRC).toContain('async function handlePublicProject');
  });

  it('only intercepts GET on the public path (other methods fall through to the 405)', () => {
    // Anchored on a COMMENT marker, so the offsets must come from RAW; the extracted block is
    // decommented before matching so the `=== 'GET'` below cannot be satisfied by prose.
    const start = RAW.indexOf('WS-A1 share route, now AUTH-GATED');
    const end = RAW.indexOf('Must check /types routes before idMatch', start);
    expect(start, 'WS-A1 anchor comment not found — this guard has gone blind').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = decomment(RAW.slice(start, end));
    expect(block).toContain("=== 'GET'");
  });

  describe('handlePublicProject deny-by-default projection', () => {
    const start = SRC.indexOf('async function handlePublicProject');
    const end = SRC.indexOf('export const handler', start);
    const publicFn = SRC.slice(start, end);

    it('the public handler body exists and is isolated', () => {
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(publicFn).toContain('public-slug: deny-by-default allowlist');
    });

    // The security assertion: none of these sensitive columns may appear in the public
    // handler's SELECTs or its response object.
    // location_path joined this list 2026-08-27. It was previously PUBLISHED here, so unlike the
    // others it is a removal being pinned, not a column that never shipped: the top-level location
    // names on this site are House / Stable / Drive / Pasture, which disclose the property rather
    // than the garden. Asserted against decommented source, so the explanatory comment left at the
    // removal site in index.js cannot satisfy this guard.
    for (const forbidden of ['private_notes', 'created_by', 'assignee_user_id', 'workspace_id', 'cover_photo_path', 'location_path']) {
      it(`never references ${forbidden}`, () => {
        expect(publicFn, `public handler leaks ${forbidden}`).not.toContain(forbidden);
      });
    }

    it('builds the response key-by-key and never spreads a DB row', () => {
      // No object spread of a row/record inside the public handler.
      expect(publicFn).not.toMatch(/\.\.\.\s*row\b/);
      expect(publicFn).not.toMatch(/\.\.\.\s*rows\[/);
      // The response object carries the expected public keys.
      for (const key of ['name:', 'slug:', 'status:', 'species:', 'variety:', 'description:', 'start_date:', 'events:']) {
        expect(publicFn, `response missing ${key}`).toContain(key);
      }
    });

    it('binds slug as a tagged-template parameter (never string-interpolated into SQL)', () => {
      expect(publicFn).toContain('c.slug = ${slug}');
    });

    // ROW GATE (added 2026-08-24). Independent of the column allowlist above: that boundary
    // controls WHICH COLUMNS a visible row may expose, this one controls WHICH ROWS are visible
    // at all. Both queries must carry it — an is_public project with non-public events would
    // otherwise publish those events' notes. Asserted statically so the gate cannot be dropped
    // without a test failing; the integration suite proves the runtime behaviour separately.
    it('gates the project SELECT on is_public', () => {
      const projQuery = publicFn.slice(publicFn.indexOf('FROM public.container'), publicFn.indexOf('LIMIT 1'));
      expect(projQuery, 'project query missing is_public row gate').toMatch(/AND\s+c\.is_public\s+IS\s+TRUE/);
    });

    it('gates the event SELECT on is_public', () => {
      const evQuery = publicFn.slice(publicFn.indexOf('FROM event_log'), publicFn.indexOf('LIMIT 200'));
      expect(evQuery, 'event query missing is_public row gate').toMatch(/AND\s+is_public\s+IS\s+TRUE/);
    });
  });
});
