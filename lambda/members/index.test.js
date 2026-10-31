// PLANT-ASSIGN-001 members lambda static-source guards, plus the R1-11 roster case executed under
// lambda/_test-stubs (whose @clerk/backend stub serves createClerkClient).
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
// index.js signs in through its copy of the D2 kit (same zip); lambda/household-isolation.test.js holds the copy
// byte-equal to lambda/request-context.js and checks its refusal order.
const KIT = decomment(readFileSync(resolve(__dirname, 'request-context.js'), 'utf8'));

describe('members lambda (GET /api/members)', () => {
  it('is Clerk-authed via verifyToken', () => {
    expect(SRC).toMatch(/const ctx = await requestContext\(event\b[\s\S]*?\);\n\s*if \(ctx\.response\) return ctx\.response;/);
    expect(KIT).toMatch(/verifyToken\(/);
    expect(KIT).toMatch(/CLERK_SECRET_KEY/);
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

  // 0A.6 (devops-review plan): /api/members previously returned EVERY Clerk user — email
  // included — to ANY authenticated caller. With open signup treated as the conservative
  // default (D5), that is a roster+email leak to strangers.
  it('roster is scoped to the caller household via householdScope (0A.6)', () => {
    expect(SRC).toMatch(/import \{ householdScope \} from '\.\/household\.js'/);
    expect(SRC).toMatch(/householdScope\(userId\)/);
    // The Clerk list is filtered to household members, not just de-botted.
    expect(SRC).toMatch(/hh\.has\(u\.id\)/);
  });

  it('response drops email — no consumer renders it (0A.6 consumer grep 2026-07-28)', () => {
    // AssigneePicker/Garden/Findings/Today consume { id, display_name } only.
    // displayName() may still USE email server-side as a label fallback — that is fine;
    // the response map itself must not carry an email field.
    const i = SRC.indexOf('.map((u) => ({');
    expect(i).toBeGreaterThan(-1);
    const block = SRC.slice(i, SRC.indexOf('}))', i) + 3);
    // No email FIELD in the response object (comments mentioning the drop are fine).
    expect(block).not.toMatch(/email\s*:/);
    expect(block).not.toMatch(/emailAddresses/);
  });
});

describe('members roster, executed under the stubs (lambda/_test-stubs)', () => {
  it('R1-11: the roster asks Clerk for the household\'s ids, so a member beyond Clerk\'s first page still appears', async () => {
    const { stubState, resetStubs } = await import('../_test-stubs/state.js');
    resetStubs();
    process.env.GARDEN_HOUSEHOLD_IDS = 'user_r111_a,user_r111_b';
    try {
      const filler = Array.from({ length: 58 }, (_, i) => ({ id: `user_r111_other_${i}`, firstName: `Other${i}` }));
      stubState.clerkUsers = [...filler.slice(0, 54), { id: 'user_r111_a', firstName: 'Ann' }, { id: 'user_r111_b', firstName: 'Bea' }, ...filler.slice(54)];
      stubState.verifyTokenResult = { sub: 'user_r111_a' };
      const { handler } = await import('./index.js');
      const res = await handler({ requestContext: { http: { method: 'GET' } }, rawPath: '/api/members', headers: { authorization: 'Bearer t' } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).members.map((m) => m.id)).toEqual(['user_r111_a', 'user_r111_b']);
      expect(stubState.clerkListCalls).toEqual([{ userId: ['user_r111_a', 'user_r111_b'], limit: 2 }]);
    } finally {
      delete process.env.GARDEN_HOUSEHOLD_IDS;
    }
  });
});
