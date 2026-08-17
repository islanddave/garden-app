import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// BUG-ENTITYMEMSTALE-001 — the enforcement half of the fix.
//
// The bug was not a missing line; it was that nothing REQUIRED the line. merge.js repointed
// event_log onto the winner and left a comment claiming an inference job would rebuild the
// winner's entity_memory row. No such job exists, so five prod winners went permanently BEHIND
// their own event log and the continuous gate post_no_cache_behind_event_log went red.
//
// Adding one more call site would have reproduced the failure mode this repo has already paid for
// (a contract with "THREE enforcement points" that grew a fourth nobody wired). So the raw repoint
// statement is BANNED everywhere except lambda/plants/plantMemoryRepoint.js, whose single builder
// hands back the repoint and the rebuild it owes as one frozen object. A future repointer cannot
// write the SQL by hand — this test fails — and cannot obtain it from the module without the
// rebuild coming along in the same return value.
const here = dirname(fileURLToPath(import.meta.url));

const MODULE = 'plants/plantMemoryRepoint.js';
const CANONICAL = 'events/index.js';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) out.push(p);
  }
  return out;
}
const FILES = walk(here).map((p) => relative(here, p)).sort();

// A construct NAMED IN A COMMENT is not that construct — this module's own header quotes the
// banned statement to explain why it is banned. Same decommenter merge.test.js uses.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const src = (f) => decomment(readFileSync(join(here, f), 'utf8'));
// Bind names differ between copies ($ {plantId} vs $ {newPlantId}); the SQL must not.
const norm = (s) => s.replace(/\$\{[^}]*\}/g, '${P}').replace(/\s+/g, ' ');

const REPOINT_RE = /UPDATE\s+event_log\s+SET\s+plant_id\s*=/;

describe('plant-keyed entity_memory repoint contract', () => {
  // Vacuity floors: an enumeration that silently walks nothing passes every assertion below.
  it('enumerates the fleet and finds both anchors', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES).toContain(MODULE);
    expect(FILES).toContain(CANONICAL);
  });

  it('routes every event_log plant repoint through the one builder', () => {
    const offenders = FILES.filter((f) => f !== MODULE && REPOINT_RE.test(src(f)));
    expect(offenders,
      `these files repoint event_log.plant_id by hand and therefore skip the entity_memory rebuild: ${offenders.join(', ')}`
    ).toEqual([]);
    // …and the builder really does still carry it, so the ban is not passing because the statement
    // vanished from the codebase entirely.
    expect(REPOINT_RE.test(src(MODULE))).toBe(true);
  });

  it('makes every consumer take the rebuild along with the repoint', () => {
    const consumers = FILES.filter((f) => f !== MODULE && /buildPlantEventRepoint/.test(src(f)));
    expect(consumers.length, 'nothing imports the builder — the ban above is vacuous').toBeGreaterThan(0);
    for (const f of consumers) {
      const s = src(f);
      expect(s, `${f} uses the repoint half without the rebuild half`).toMatch(/\.repoint\b/);
      expect(s, `${f} uses the repoint half without the rebuild half`).toMatch(/\.recompute\b/);
    }
  });

  it('keeps ONE definition of truth — the rebuild matches the canonical plant-keyed recompute', () => {
    // Every MAX(event_date) probe in the module must appear verbatim (modulo bind name) in
    // lambda/events/index.js, where the PUT's newPlantId arm has always defined what "rebuild a
    // plant's care cache from event_log" means. Drift here is a SECOND definition of truth, which
    // is how a heal script and the app end up disagreeing about the same row.
    const probes = norm(src(MODULE)).match(/\(SELECT MAX\(e\.event_date\) FROM event_log e WHERE [^)]*\)\)?/g) ?? [];
    expect(probes.length, 'no truth probes found in the module').toBe(7);
    const canonical = norm(src(CANONICAL));
    for (const p of probes) {
      expect(canonical, `probe absent from ${CANONICAL}: ${p}`).toContain(p);
    }
    expect(canonical).toContain(norm('ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL DO UPDATE SET'));
  });
});
