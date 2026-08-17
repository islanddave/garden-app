// V4-APIGZIP-001 — /api/plants is the proof case: the largest body the app fetches (591,905 B of
// real prod rows, 113,259 B gzipped — 5.23x). http-response.js's own behavior is tested for real in
// lambda/http-response.test.js; what CANNOT be tested there is that this handler actually routes
// through it, because lambda/plants/index.js imports @neondatabase/serverless + @clerk/backend +
// @aws-sdk/* at module load and is not importable from repo root. Static source is this tier's only
// instrument (same constraint as select-columns.test.js / featured-thumb.test.js).
//
// Two regressions this guards, both of which would ship green without it:
//   · the import reverting to `../http-response.js` — NOT packaged by `cd lambda/plants && zip -r`,
//     so the handler 502s at module load on every request (the household.js/photo-access.js hazard)
//   · a "tidy" reinstating a module-level resp() that JSON.stringifies unconditionally, which
//     silently un-does compression while every existing test stays green
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — this file's own header names strings it
// asserts on, so decommenting is what stops it finding its own epitaph and passing.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('/api/plants responds through the shared negotiated-gzip responder', () => {
  it('imports jsonResponder from ./http-response.js — the per-dir copy, never ../', () => {
    expect(SRC).toMatch(/import \{ jsonResponder \} from '\.\/http-response\.js';/);
    expect(SRC).not.toMatch(/from '\.\.\/http-response\.js'/);
  });

  it('binds resp per invocation from the event, so Accept-Encoding is THIS request\'s', () => {
    expect(SRC).toMatch(/const resp = jsonResponder\(event, CORS\);/);
  });

  it('no module-level resp() survives to bypass negotiation', () => {
    // The exact pre-change shape: a free function that stringified regardless of the request.
    expect(SRC).not.toMatch(/^function resp\(/m);
    expect(SRC).not.toMatch(/body: JSON\.stringify\(body\)/);
  });

  it('the list GET — the measured payload — returns through resp, not a hand-built object', () => {
    expect(SRC).toMatch(/return resp\(200, enriched\);/);
  });

  it('resp is bound before the first use on every path, including the OPTIONS short-circuit', () => {
    const bind = SRC.indexOf('const resp = jsonResponder(event, CORS);');
    const firstUse = SRC.indexOf('resp(', bind + 1);
    expect(bind, 'jsonResponder binding must exist').toBeGreaterThan(-1);
    expect(bind).toBeLessThan(firstUse);
    // and it must live INSIDE the handler — a module-scope binding would capture no event at all
    expect(bind).toBeGreaterThan(SRC.indexOf('export const handler'));
  });
});
