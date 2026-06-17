// Static-source regression guard for the daily-plan read-model handler (DRG-TODAY-002).
// Static (not import): index.js imports @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module
// load, which the jsdom unit run cannot resolve (same constraint as findings/index.test.js). Guards the
// load-bearing read-path invariants: GET-only, Clerk-authed, PER-USER, soft-delete-filtered, READ-ONLY,
// server-computed plan_date.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('daily-plan-read Lambda — static read-path invariants', () => {
  const stmts = SRC.match(/sql`[\s\S]*?`/g) || [];

  it('authenticates with Clerk verifyToken against CLERK_SECRET_KEY', () => {
    expect(SRC).toMatch(/verifyToken\(/);
    expect(SRC).toMatch(/secretKey:\s*secrets\.CLERK_SECRET_KEY/);
  });

  it('is READ-ONLY — exactly one SQL statement, a SELECT, no write verbs', () => {
    expect(stmts.length).toBe(1);
    expect(stmts[0]).toMatch(/SELECT/);
    for (const s of stmts) expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i);
  });

  it('scopes PER-USER to the authenticated subject (never household-widened)', () => {
    expect(stmts[0]).toMatch(/dp\.user_id = \$\{userId\}/);
    expect(SRC).not.toMatch(/householdScope/);
  });

  it('filters soft-deleted plans', () => {
    expect(stmts[0]).toMatch(/dp\.deleted_at IS NULL/);
  });

  it('computes plan_date server-side in America/New_York (client clock cannot shift the day)', () => {
    expect(stmts[0]).toMatch(/America\/New_York/);
    expect(stmts[0]).toMatch(/plan_date/);
  });

  it('is GET-only and rejects other methods/paths with 405', () => {
    expect(SRC).toMatch(/method !== 'GET'/);
    expect(SRC).toMatch(/rawPath !== '\/api\/daily-plan'/);
    expect(SRC).toMatch(/405/);
  });

  it('returns the contract envelope (schema_version + has_plan + plan)', () => {
    expect(SRC).toMatch(/schema_version:\s*SCHEMA_VERSION/);
    expect(SRC).toMatch(/has_plan:/);
    expect(SRC).toMatch(/plan:\s*row\.items/);
  });

  it('returns 401 on auth failure and 500 on query error', () => {
    expect(SRC).toMatch(/return resp\(401/);
    expect(SRC).toMatch(/return resp\(500/);
  });
});
