// Static-source regression guard for the findings read-model handler (slice 6).
// Static (not import): index.js imports @neondatabase/serverless + @clerk/backend + @aws-sdk/* at
// module load, which the jsdom unit run cannot resolve (same constraint as shared-state/index.test.js
// and plants/select-columns.test.js). This guards the load-bearing read-path invariants:
// GET-only, Clerk-authed, household-scoped, soft-delete-filtered, entity-joined, and READ-ONLY.
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

describe('findings Lambda — static read-path invariants', () => {
  const stmts = SRC.match(/sql`[\s\S]*?`/g) || [];

  it('authenticates with Clerk verifyToken', () => {
    expect(SRC).toMatch(/verifyToken\(/);
    expect(SRC).toMatch(/secretKey:\s*secrets\.CLERK_SECRET_KEY/);
  });

  it('is READ-ONLY — issues exactly one SQL statement, a SELECT, with no write verbs', () => {
    expect(stmts.length).toBe(1);
    expect(stmts[0]).toMatch(/SELECT/);
    for (const s of stmts) expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i);
  });

  it('filters soft-deleted rows on every joined table', () => {
    const s = stmts[0];
    expect(s).toMatch(/e\.deleted_at IS NULL/);
    expect(s).toMatch(/p\.deleted_at IS NULL/);
    expect(s).toMatch(/pp\.deleted_at IS NULL/);
    expect(s).toMatch(/ent\.deleted_at IS NULL/);
  });

  it('scopes to the household via container ownership', () => {
    expect(SRC).toMatch(/householdScope\(userId\)/);
    expect(stmts[0]).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('only surfaces flagged issues and joins the canonical entity registry', () => {
    expect(stmts[0]).toMatch(/flagged_as_issue = true/);
    expect(stmts[0]).toMatch(/entity ent[\s\S]*ent\.planting_ref_id = e\.plant_id/);
  });

  it('is GET-only and rejects other methods/paths with 405', () => {
    expect(SRC).toMatch(/method !== 'GET'/);
    expect(SRC).toMatch(/rawPath !== '\/api\/findings'/);
    expect(SRC).toMatch(/405/);
  });

  it('emits the contract via the pure engine, never serve-time-fabricated', () => {
    expect(SRC).toMatch(/composeFinding/);
    expect(SRC).toMatch(/assembleIssueFindings/);
    expect(SRC).toMatch(/schema_version:\s*SCHEMA_VERSION/);
  });
});
