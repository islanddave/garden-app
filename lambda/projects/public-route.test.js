// WS-A1 static-source security regression guard for the public share route.
//
// `/garden/:slug` is served by GET /api/projects/public/:slug, which MUST be reachable
// WITHOUT auth. Two properties are pinned here, both by inspecting index.js source (the
// house static-test style — same as select-columns.test.js / pubhide.static.test.js):
//
//   1. Ordering: the public route is matched + dispatched BEFORE the verifyToken() call, so
//      an unauthenticated request reaches handlePublicProject and never 401s.
//   2. Deny-by-default projection: the handlePublicProject body never selects or returns any
//      sensitive column. This is the security boundary — a regression that spreads a DB row
//      or widens the SELECT would surface here rather than in prod.

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

  it('matches + dispatches the public route BEFORE verifyToken() (unauthenticated reachability)', () => {
    const handlerIdx = SRC.indexOf('export const handler');
    expect(handlerIdx).toBeGreaterThan(-1);
    // The early-return CALL inside the handler (not the function definition above it).
    const callIdx = SRC.indexOf('handlePublicProject(publicMatch[1]', handlerIdx);
    const verifyIdx = SRC.indexOf('verifyToken(', handlerIdx);
    expect(callIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(verifyIdx);
  });

  it('only intercepts GET on the public path (other methods fall through to auth)', () => {
    // Anchored on a COMMENT marker, so the offsets must come from RAW; the extracted block is
    // decommented before matching so the `=== 'GET'` below cannot be satisfied by prose.
    const start = RAW.indexOf('WS-A1: public project share route.');
    const end = RAW.indexOf('const authHeader', start);
    expect(start).toBeGreaterThan(-1);
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
    for (const forbidden of ['private_notes', 'created_by', 'assignee_user_id', 'workspace_id', 'cover_photo_path']) {
      it(`never references ${forbidden}`, () => {
        expect(publicFn, `public handler leaks ${forbidden}`).not.toContain(forbidden);
      });
    }

    it('builds the response key-by-key and never spreads a DB row', () => {
      // No object spread of a row/record inside the public handler.
      expect(publicFn).not.toMatch(/\.\.\.\s*row\b/);
      expect(publicFn).not.toMatch(/\.\.\.\s*rows\[/);
      // The response object carries the expected public keys.
      for (const key of ['name:', 'slug:', 'status:', 'species:', 'variety:', 'description:', 'start_date:', 'location_path:', 'events:']) {
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
