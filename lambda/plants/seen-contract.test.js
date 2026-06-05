// V3-SEEN-001 seen-contract write-path regression guard.
// Static-source assertion — same rationale as select-columns.test.js / variety-clear.test.js:
// lambda/plants/index.js imports @neondatabase/serverless + @clerk/backend + @aws-sdk/* at
// module load, so there is no runtime-handler test seam without a handlers.js split (out of
// scope). Static inspection is the lowest-risk CI-runnable gate for this contract.
//
// Guards the seen-contract write endpoint (POST /api/plants/:id/seen):
//  (a) the /seen route regex is present;
//  (b) it INSERTs into seen_event;
//  (c) it enforces household ownership (created_by = ANY) within the seen branch;
//  (d) it uses a non-`p` alias (`ln`) for the plants table in the seen insert, so it adds NO
//      new `FROM plants p` block — the exactly-3-blocks invariant in select-columns.test.js holds.
//
// Fails loudly if a future edit drops the route, removes ownership scoping, or reintroduces a
// `FROM plants p` alias on the seen path (which would silently break select-columns.test.js).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// Isolate the seen branch body so ownership/alias assertions are scoped to it,
// not satisfied by an unrelated match elsewhere in the handler.
function seenBranch(src) {
  const start = src.indexOf('if (seenMatch) {');
  expect(start, 'seen branch (if (seenMatch) {) not found').toBeGreaterThan(-1);
  // Take a generous window from the branch open to the next top-level `if (idMatch) {`.
  const end = src.indexOf('if (idMatch) {', start);
  return src.slice(start, end > -1 ? end : src.length);
}

describe('plants Lambda — seen-contract write path (V3-SEEN-001)', () => {
  it('(a) declares a /seen route regex', () => {
    expect(
      /rawPath\.match\(\/\^\\\/api\\\/plants\\\/\(\[\^\/\]\+\)\\\/seen\$\/\)/.test(SRC),
      'seen route regex (…/([^/]+)/seen$) missing',
    ).toBe(true);
  });

  it('(b) inserts into seen_event', () => {
    expect(seenBranch(SRC).includes('INSERT INTO seen_event')).toBe(true);
  });

  it('(c) enforces household ownership (created_by = ANY) within the seen branch', () => {
    expect(
      /created_by\s*=\s*ANY\(\$\{householdIds\}\)/.test(seenBranch(SRC)),
      'seen branch missing created_by = ANY(${householdIds}) ownership scope',
    ).toBe(true);
  });

  it('(d) uses a non-`p` alias (ln) for plants in the seen insert', () => {
    // Strip // line comments first — they intentionally mention `FROM plants p` to
    // document WHY the alias is `ln`; the assertion targets executable SQL, not prose.
    const branch = seenBranch(SRC).replace(/\/\/[^\n]*/g, '');
    expect(branch.includes('FROM plants ln'), 'seen insert must alias plants as ln').toBe(true);
    // No new `FROM plants p` introduced on the seen path (would break select-columns.test.js).
    expect(/FROM\s+plants\s+p\b/.test(branch), 'seen branch must NOT add a FROM plants p block').toBe(false);
  });
});
