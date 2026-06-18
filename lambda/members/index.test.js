// PLANT-ASSIGN-001 members lambda static-source guards. Mirrors the other lambdas' static test pattern
// (index.js imports @clerk/backend + @aws-sdk at module load, so we assert on source text, not by invoking).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('members lambda (GET /api/members)', () => {
  it('is Clerk-authed via verifyToken', () => {
    expect(SRC).toMatch(/verifyToken\(/);
    expect(SRC).toMatch(/CLERK_SECRET_KEY/);
  });
  it('sources the roster from Clerk, not the DB (no neon import)', () => {
    expect(SRC).toMatch(/createClerkClient/);
    expect(SRC).toMatch(/getUserList/);
    expect(SRC).not.toMatch(/@neondatabase\/serverless/);
  });
  it('is GET-only on /api/members and 405s otherwise', () => {
    expect(SRC).toMatch(/rawPath !== '\/api\/members'/);
    expect(SRC).toMatch(/Method not allowed/);
  });
  it('returns a members array with id + display_name', () => {
    expect(SRC).toMatch(/members/);
    expect(SRC).toMatch(/display_name/);
  });

  it('excludes the System bot by a stable marker, never Jen’s sub (DRG-ASSIGN-FIX)', () => {
    expect(SRC).toMatch(/islanddave\+clerk\+system@gmail\.com/);
    expect(SRC).not.toMatch(/user_3E2xA85kQhr1vSZhiv4W1GLudJV/);
  });
});
