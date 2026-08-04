// V4-EVENTSOURCE-001 — this Lambda is the OWNER of event_log.source = 'app_status'.
//
// Why this file exists: lambda/events/event-source.test.js pinned the two values THAT Lambda
// writes and left a comment delegating 'app_status' to lambda/plants + lambda/projects. Nothing
// pinned this side, so the status-change INSERT shipped in v3.97.0 with `source` omitted from its
// column list and re-accumulated NULLs at ~1.4% of event volume, silently. A provenance column is
// only worth having if it is TRUE, and the way it goes false is a writer that forgets.
//
// Static-source (L-072), DB-free: asserts the source text of index.js and the migration SQL.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatusChangeMetadata, STATUS_CHANGE_EVENT_TYPE } from './statusEvents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const MIG = resolve(__dirname, '..', '..', 'migrations', 'v4-eventsource-001');
const DDL = readFileSync(resolve(MIG, '0a-additive-ddl.sql'), 'utf8');
const BACKFILL = readFileSync(resolve(MIG, '0b-backfill-source.sql'), 'utf8');

// Comment-stripped view. The header comment above the constant legitimately names other source
// values while explaining them; only executable text may be asserted against for value literals.
const CODE = SRC.replace(/^[ \t]*\/\/.*$/gm, '');

// Column lists of every event_log INSERT in this file. Kept as one derivation so the
// "every INSERT names source" guard below cannot be satisfied by a partial match.
const INSERT_COLUMN_LISTS = [...SRC.matchAll(/INSERT INTO (?:public\.)?event_log\s*\(([^)]*)\)/g)]
  .map((m) => m[1].split(',').map((c) => c.trim()));

describe('event_log.source — the app_status writer', () => {
  it('declares only values the migration CHECK admits', () => {
    // The column carries a NOT VALID CHECK; a value the constraint does not know 23514s at write.
    const declared = [...SRC.matchAll(/const EVENT_SOURCE_\w+\s*=\s*'([^']+)'/g)].map((m) => m[1]);
    expect(declared).toEqual(['app_status']);
    for (const v of declared) expect(DDL).toContain(`'${v}'`);
  });

  it('EVERY event_log INSERT in this Lambda names source in its column list', () => {
    // The regex must see every INSERT — otherwise a reformatted one slips past unpinned.
    const rawCount = [...SRC.matchAll(/INSERT INTO (?:public\.)?event_log\b/g)].length;
    expect(INSERT_COLUMN_LISTS.length).toBe(rawCount);
    expect(INSERT_COLUMN_LISTS.length).toBeGreaterThan(0);
    for (const cols of INSERT_COLUMN_LISTS) expect(cols).toContain('source');
  });

  it('binds the constant, not a literal, in the VALUES list', () => {
    expect(SRC).toMatch(/VALUES[\s\S]{0,300}\$\{EVENT_SOURCE_STATUS\}/);
    // A bare 'app_status' string anywhere else in code would be a second, divergable copy.
    expect([...CODE.matchAll(/'app_status'/g)].length).toBe(1);
  });
});

describe("the rows this Lambda writes match the predicate 0b classifies them by", () => {
  // 0b keys app_status on event_type='status_change' AND metadata->>'schema'='status_change.v1'.
  // If this writer's contract drifts from that predicate, historical rows and new rows stop
  // agreeing and the column starts lying in a way no single-side test would catch.
  it('emits the event_type the backfill keys on', () => {
    expect(STATUS_CHANGE_EVENT_TYPE).toBe('status_change');
    expect(BACKFILL).toMatch(/e\.event_type = 'status_change'/);
  });

  it('emits the frozen metadata schema the backfill keys on', () => {
    expect(buildStatusChangeMetadata('planning', 'growing', 'project').schema).toBe('status_change.v1');
    expect(BACKFILL).toMatch(/metadata ->> 'schema' = 'status_change\.v1'/);
  });

  it("never writes 'direct' — only a writer that knows it bypassed the API may", () => {
    expect(CODE).not.toMatch(/'direct'/);
  });
});
