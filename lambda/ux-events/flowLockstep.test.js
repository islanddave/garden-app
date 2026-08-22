// V4-PHOTOUPLOADINSTR-001 — the client's FLOWS and the Lambda's ALLOWED_FLOWS must agree.
//
// WHY THIS FILE EXISTS, stated as the failure it would have caught. `open_planting` was added to
// src/lib/uxEvents.js on 2026-06-03 (V3-NAV-001) and never added to ALLOWED_FLOWS. The Lambda
// rejects an unknown flow, the client swallows every telemetry error by design, and the result is a
// 200-shaped silence: no console error, no failing test, no missing feature anyone could see.
// Measured on live prod 2026-08-22, 2.5 months later — reach_planting 244 rows, log_watering 215,
// create_project 53, open_planting ZERO. The nav change that introduced it also RETIRED the surface
// feeding reach_planting, so the funnel did not gain a second signal, it drained to nothing.
//
// The two constants live in different deploy units (SPA bundle vs Lambda) and cannot import each
// other, which is exactly the shape that has bitten this repo before — see
// lambda/events/harvest-ready.test.js, where the same duplicate-constant hazard is pinned the same
// way. Duplication is fine; UNPINNED duplication is not.
//
// DIRECTION MATTERS. A client flow missing from the server is a SILENT DATA LOSS and must fail. A
// server flow with no client emitter is merely unused capacity — the server intentionally leads on
// occasion — so that direction is reported, not enforced.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// STATIC-SOURCE ON BOTH SIDES — do NOT import ./index.js. The handler imports
// @neondatabase/serverless, @clerk/backend and @aws-sdk/client-secrets-manager, which live only in
// this Lambda's own package.json and are absent from the root unit run's module graph; the import
// fails at COLLECTION, which reads as a broken test file rather than a broken guard. vi.mock cannot
// rescue it either, because Vite resolves before mocks run. Same reason index.test.js says
// "static-source only" at its head.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

function serverFlows() {
  const src = decomment(readFileSync(join(here, 'index.js'), 'utf-8'));
  const m = src.match(/ALLOWED_FLOWS = new Set\(\[([^\]]*)\]\)/);
  if (!m) throw new Error('ALLOWED_FLOWS Set literal not found in lambda/ux-events/index.js');
  return new Set(m[1].match(/'[^']+'/g).map((x) => x.replace(/'/g, '')));
}

// Parsed from SOURCE rather than imported: src/lib/uxEvents.js pulls in React and import.meta.env,
// neither of which resolves inside the Lambda's module graph. The regex reads the string VALUES of
// the FLOWS object, which is what actually travels over the wire — a key rename is irrelevant here,
// a value change is not.
function clientFlowValues() {
  const src = readFileSync(join(here, '..', '..', 'src', 'lib', 'uxEvents.js'), 'utf-8');
  const block = /export const FLOWS = \{([\s\S]*?)\}/.exec(src);
  if (!block) throw new Error('FLOWS object not found in src/lib/uxEvents.js');
  // Strip // comments first: this file documents flow ids in prose, and an id named in a comment is
  // not an id that ships. Same decomment discipline as harvest-ready.test.js.
  const body = block[1].split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  return [...body.matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('ux-events flow allowlist stays in lockstep with the client', () => {
  it('found both sides (the guard is not vacuous)', () => {
    expect(clientFlowValues().length).toBeGreaterThan(0);
    expect(serverFlows().size).toBeGreaterThan(0);
  });

  // THE ASSERTION THAT MATTERS. Every flow the client can emit must be one the server accepts.
  it('every client FLOWS value is in ALLOWED_FLOWS — an unlisted flow is silently discarded', () => {
    const server = serverFlows();
    const missing = clientFlowValues().filter((f) => !server.has(f));
    expect(missing).toEqual([]);
  });

  // Named explicitly so a future edit that drops either one fails on the specific id rather than on
  // a set-difference message someone has to decode.
  it('carries the two flows that were dropped or newly added', () => {
    const server = serverFlows();
    expect(server.has('open_planting')).toBe(true);
    expect(server.has('photo_upload')).toBe(true);
  });

  it('the pre-existing three are untouched', () => {
    const server = serverFlows();
    for (const f of ['log_watering', 'reach_planting', 'create_project']) {
      expect(server.has(f)).toBe(true);
    }
  });
});
