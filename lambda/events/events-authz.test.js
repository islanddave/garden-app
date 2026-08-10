// BUG-EVENTSOWN-001 — POST /api/events household ownership gate on every body-supplied parent id.
// Assessment: Projects/Gardening/events-authz-gap-V100-20260804.md (severity MEDIUM, insider-only,
// held there ONLY because the prod Clerk instance is sign_up.mode=restricted).
//
// Static-source (L-072), DB-free — the house pattern for asserting handler shape in a Lambda with
// no DB harness (mirrors hs2-plant-filter.test.js / batch-order.test.js). What matters here is not
// only that the checks EXIST but that they run BEFORE the write and answer with a GENERIC 400, so
// position and message text are both asserted.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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
const TAGS = decomment(readFileSync(resolve(__dirname, '..', 'tags', 'index.js'), 'utf8'));
const CANON = decomment(readFileSync(resolve(__dirname, '..', 'authz-parents.js'), 'utf8'));
const LOCAL_COPY = decomment(readFileSync(resolve(__dirname, 'authz-parents.js'), 'utf8'));

// Strip SQL/JS comments and collapse whitespace, so two copies of a predicate compare on what the
// database actually sees rather than on how each file chose to explain itself.
const bodyOf = (src, fn) => {
  const at = src.indexOf(`function ${fn}(`);
  if (at < 0) return null;
  return src
    .slice(at, src.indexOf('\n}', at))
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

describe('events POST — household ownership gate on body-supplied parent ids', () => {
  it('gates all THREE body-supplied parent columns, not just the two the assessment listed', () => {
    // project_id and plant_id are the assessment's finding; location_id is inserted on the same
    // path with no check either and is the same class. Gating two of three would have left the
    // pattern open in the same handler.
    expect(SRC).toMatch(/loadOwnedProject\(sql, projectId, householdIds\)/);
    expect(SRC).toMatch(/loadOwnedPlantingRef\(sql, body\.plant_id, householdIds\)/);
    expect(SRC).toMatch(/loadOwnedLocation\(sql, body\.location_id, householdIds\)/);
  });

  it('uses the TIGHT planting predicate, not household.js loadOwnedPlanting', () => {
    // household.js loadOwnedPlanting is the same query MINUS the `project_id IS NULL` conjunct, so
    // its own-created_by arm reaches a planting the caller created inside ANOTHER household's
    // container. A brand-new gate must be built on the tight form.
    expect(SRC).not.toMatch(/loadOwnedPlanting\(sql,/);
    // Step 3 landed: the predicate now lives in this dir's authz-parents.js copy, not inline here.
    expect(LOCAL_COPY).toMatch(/gn\.project_id IS NULL AND gn\.created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('answers a rejected id with a GENERIC 400 — never "not found" vs "forbidden"', () => {
    // The distinction is itself a leak: it turns the endpoint into an existence oracle. This is the
    // documented contract of every loadOwned* caller in the codebase.
    for (const col of ['project_id', 'plant_id', 'location_id']) {
      expect(SRC).toContain(`return resp(400, { error: 'Invalid ${col}' });`);
    }
    expect(SRC).not.toMatch(/error: '(project|plant|location) not found'/);
  });

  it('logs the rejection server-side via warnRejectedFk (one-way observability)', () => {
    for (const col of ['project_id', 'plant_id', 'location_id']) {
      expect(SRC).toContain(`warnRejectedFk(userId, 'event_log', '${col}'`);
    }
  });

  it('runs the gate BEFORE the write transaction, not after', () => {
    // A check that runs after sql.transaction() would still have written the row and, worse, still
    // have upserted entity_memory — which is the actual harm (a forged watering suppresses a real
    // care reminder). Position is the assertion.
    const gate = SRC.indexOf("warnRejectedFk(userId, 'event_log', 'project_id'");
    const tx = SRC.indexOf('const txResult = await sql.transaction');
    expect(gate).toBeGreaterThan(-1);
    expect(tx).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(tx);
  });

  it('imports the loaders rather than redefining them inline', () => {
    // Step 3 (2026-08-04): the inline duplicates in index.js were replaced by an import from this
    // dir's authz-parents.js copy. Byte-equality of that copy against the canonical file is now
    // enforced for ALL THREE dirs by lambda/authz-parents-copies-sync.test.js, so the old
    // body-comparison test here would have been a second, weaker copy of that guard.
    // What still needs asserting from this lane is that index.js consumes the shared predicate
    // instead of quietly growing a fourth dialect.
    expect(SRC).toMatch(/import \{[^}]*loadOwnedProject[^}]*\} from '\.\/authz-parents\.js'/);
    expect(SRC).toMatch(/import \{[^}]*loadOwnedPlantingRef[^}]*\} from '\.\/authz-parents\.js'/);
    expect(SRC).not.toMatch(/async function loadOwned(Project|PlantingRef)\(/);
  });

  it('and that predicate is the one BUG-TAGENTOWN-001 shipped in lambda/tags', () => {
    // Third/fourth/fifth instance of ONE pattern, not three findings.
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    expect(norm(TAGS)).toContain(
      norm(`FROM public.plant_projects WHERE id = \${entityId} AND deleted_at IS NULL AND created_by = ANY(\${household})`),
    );
  });

  it('does NOT edit the shared household.js — sibling lane', () => {
    // household.js is copied byte-identical into 17 Lambda dirs (household-copies-sync.test.js).
    // Extending it from this lane would require editing all 17.
    const shared = decomment(readFileSync(resolve(__dirname, 'household.js'), 'utf8'));
    expect(shared).not.toContain('loadOwnedProject');
    // The gate lives in authz-parents.js (imported), never bolted onto the 17-way-copied household.js.
    expect(LOCAL_COPY).toContain('export async function loadOwnedProject(');
  });

  it('the canonical authz-parents.js copy IS present in this dir, and DIRS knows about it', () => {
    // Flipped 2026-08-04 by the photos/plants lane at the orchestrator's direction, from the
    // original "must NOT exist" guard. That guard was written while `DIRS` in the sibling-owned
    // authz-parents-copies-sync.test.js still read ['photos','plants'], so a copy here would have
    // silently escaped byte-equality checking. DIRS now reads ['events','photos','plants'], so the
    // copy is guarded, and this asserts BOTH halves stay true together.
    // REMAINING STEP 3 (events lane): replace the inline loader definitions in index.js with
    // `import { loadOwnedProject, loadOwnedPlantingRef } from './authz-parents.js'`, then delete
    // the byte-identical-in-body test above along with this one's second expectation.
    expect(existsSync(resolve(__dirname, 'authz-parents.js'))).toBe(true);
    const dirsSrc = decomment(readFileSync(resolve(__dirname, '..', 'authz-parents-copies-sync.test.js'), 'utf8'));
    expect(dirsSrc).toMatch(/const DIRS = \[[^\]]*'events'/);
  });
});
