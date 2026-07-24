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
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

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
    const start = SRC.indexOf('WS-A1: public project share route.');
    const end = SRC.indexOf('const authHeader', start);
    const block = SRC.slice(start, end);
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
  });
});
