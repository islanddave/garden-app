// /api/entity-tags route removal guard (data-audit P1-code, 2026-07-28).
// Evidence W0.6-r1 entity-tags-route: the removed route block was the SOLE consumer of the
// plural `entity_tags` debris table (2 smoke-test rows). The frontend routes ALL entity-tags
// traffic to the tags Lambda (src/lib/api.js '/api/entity-tags' -> VITE_API_TAGS, locked by
// src/__tests__/api.test.js), which uses singular `entity_tag` exclusively. CONFIRMED-DEAD.
// Removal ships BEFORE the entity_tags table drop (P1-data), per plan deploy-before-drop order.
//
// Post-removal contract: /api/entity-tags returns an explicit 404 tombstone. NOTE: a bare
// block deletion would NOT 404 — the trailing unguarded `if (method === 'GET')` list route
// would answer GET /api/entity-tags with the locations list (200). The tombstone pins the
// route dead and keeps the debris-table dependency from silently resurrecting.
//
// Static-source per L-072 house style (handler-invocation is infeasible here: lambda runtime
// deps are absent from the root install — main ci.yml never installs them; see the events
// lambda's resolve-stats-upsert.test.js header). Proves the source shape: tombstone present
// and un-shadowed, zero plural-entity_tags SQL remaining. Does not execute routing.
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

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('locations Lambda — /api/entity-tags route is dead (404 tombstone)', () => {
  it('tombstone: /api/entity-tags answers an explicit 404 Not found', () => {
    expect(SRC).toMatch(/if \(rawPath === '\/api\/entity-tags'\) return resp\(404, \{ error: 'Not found' \}\);/);
  });

  it('tombstone sits BEFORE the generic routing so no fallthrough route can shadow it', () => {
    const tombstone = SRC.indexOf("if (rawPath === '/api/entity-tags') return resp(404");
    const idMatch = SRC.indexOf('const idMatch =');
    const listRoute = SRC.indexOf("if (method === 'GET')");
    expect(tombstone).toBeGreaterThan(-1);
    expect(idMatch).toBeGreaterThan(-1);
    expect(tombstone).toBeLessThan(idMatch);
    expect(listRoute).toBeGreaterThan(tombstone);
  });

  it('no SQL touching plural entity_tags remains anywhere in the lambda', () => {
    // All three SQL verbs the removed block used (SELECT:98 INSERT:112 DELETE:129 at bec15a0):
    expect(SRC).not.toMatch(/FROM entity_tags\b/);
    expect(SRC).not.toMatch(/INSERT INTO entity_tags\b/);
    expect(SRC).not.toMatch(/DELETE FROM entity_tags\b/);
  });
});
