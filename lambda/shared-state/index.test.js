// Static-source regression guard for the garden_shared_state Lambda (V3-REWARDSTATE-001).
// Why static (not import): index.js imports @neondatabase/serverless + @clerk/backend +
// @aws-sdk/* at module load, which the jsdom unit run cannot resolve (same constraint as
// lambda/plants/select-columns.test.js). Source inspection is the lowest-risk gate for the
// substrate's load-bearing SQL invariants: soft-delete filter, workspace scoping, atomic
// increment, jsonb cast, and partial-index ON CONFLICT predicate.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('shared-state Lambda — static SQL invariants', () => {
  const stmts = SRC.match(/sql`[\s\S]*?`/g) || [];
  // READS ARE DERIVED FROM THE STATEMENT LIST, CASE-INSENSITIVELY.
  // The old expression was `SRC.match(/SELECT[\s\S]*?`/g)` — case-SENSITIVE, so a read written in
  // lowercase `select` was not a read as far as the soft-delete assertion was concerned, and
  // therefore could not fail it. Postgres does not care about the case; neither may this guard.
  // MUTATION that this closes: add a second `select payload from garden_shared_state where
  // workspace_id = ${SENTINEL_WORKSPACE}::uuid` with NO `deleted_at IS NULL` — all 7 tests passed
  // while the endpoint served soft-deleted rows.
  const reads = stmts.filter((s) => /\bSELECT\b/i.test(s));

  it('issues exactly the known SQL statements, all targeting garden_shared_state', () => {
    // EXACT, not >=. A floor of 4 against a population of 4 licensed an unbounded number of NEW
    // statements to appear un-audited; an ADD is a deliberate change, so bump this number with it.
    expect(stmts.length,
      'shared-state SQL statement count changed. Every statement here is scoped to the SENTINEL ' +
      'workspace and soft-delete filtered; a new one must be audited, not absorbed by a floor.')
      .toBe(4);
    for (const s of stmts) expect(s).toMatch(/garden_shared_state/);
  });

  it('every read filters soft-deleted rows (deleted_at IS NULL)', () => {
    expect(reads.length, 'no SELECT statements found — this guard is asserting over nothing').toBe(2);
    for (const r of reads) expect(r).toMatch(/deleted_at IS NULL/);
  });

  it('scopes every statement to the SENTINEL workspace value', () => {
    expect(SRC).toMatch(/SENTINEL_WORKSPACE\s*=\s*'00000000-0000-0000-0000-000000000001'/);
    // every statement references the sentinel — reads via `workspace_id = ${SENTINEL_WORKSPACE}`,
    // writes via the INSERT column list + `VALUES (${SENTINEL_WORKSPACE}...)`.
    for (const s of stmts) expect(s).toMatch(/\$\{SENTINEL_WORKSPACE\}/);
    // reads specifically use the WHERE-scoped form (same case-insensitive read set as above, so a
    // lowercase `select` cannot escape the workspace-scoping assertion either)
    for (const r of reads) expect(r).toMatch(/workspace_id\s*=\s*\$\{SENTINEL_WORKSPACE\}/i);
  });

  it('increments the counter in a single atomic statement (no read-modify-write)', () => {
    expect(SRC).toMatch(/counter\s*=\s*garden_shared_state\.counter\s*\+\s*\$\{by\}/);
    expect(SRC).not.toMatch(/counter\s*\+\s*1\s*;/);
  });

  it('casts payload writes to ::jsonb after JSON.stringify', () => {
    expect(SRC).toMatch(/\$\{JSON\.stringify\(body\.payload\)\}::jsonb/);
  });

  it('targets the soft-delete partial unique index on every upsert (ON CONFLICT ... WHERE deleted_at IS NULL)', () => {
    const conflicts = SRC.match(/ON CONFLICT[\s\S]*?DO UPDATE/gi) || [];
    // EXACT, and case-insensitive for the same reason as the read set above.
    expect(conflicts.length, 'upsert count changed — a new ON CONFLICT must target the partial ' +
      'unique index deliberately, not slip in under a floor').toBe(2);
    for (const c of conflicts) expect(c).toMatch(/WHERE deleted_at IS NULL/);
  });

  it('carries no hardcoded secrets or connection strings', () => {
    expect(SRC).not.toMatch(/postgres(ql)?:\/\//);
    expect(SRC).not.toMatch(/\bsk_(live|test)_/);
    expect(SRC).toMatch(/secrets\.NEON_DATABASE_URL/);
    expect(SRC).toMatch(/secrets\.CLERK_SECRET_KEY/);
  });
});
