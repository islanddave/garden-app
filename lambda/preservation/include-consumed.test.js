// V4-HARVESTFATE-001 — ?include_consumed=1 on GET /api/preservation/whats-put-up.
//
// STORES and FATE are two questions over one table. The endpoint's default answers the first ("what
// is in the freezer") by dropping a fully-consumed jar, and PlantingDetail asks the second ("where
// did this planting's harvest go"), where dropping it silently rewrites history the day the last jar
// is finished. This flag is the seam between them.
//
// WHAT THIS FILE CAN AND CANNOT DO. lambda/preservation/index.js imports @neondatabase/serverless and
// @clerk/backend at module scope, so it cannot be imported under the root vitest run — these are text
// assertions over its source, and they are pinned to the two things a careless edit loses:
//   (1) the flag is STRICTLY opt-in, so the Put-Up inventory page keeps excluding empty jars;
//   (2) it reaches the whats-put-up query and NOTHING else — use-soon and the collection GET have
//       their own filters and their own meanings, and widening either by accident would put empty
//       jars in the "eat this soon" prompt.
// Behaviour of the filter itself belongs to the integration suite, which has a real Postgres.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('whats-put-up ?include_consumed', () => {
  it('is opt-in on the exact string "1" — never on mere presence of the param', () => {
    // `!= null` or a truthiness read would turn ?include_consumed=0 into a YES, which is the reading
    // a caller writing that param would least expect.
    expect(SRC).toMatch(/const includeConsumed = event\.queryStringParameters\?\.include_consumed === '1';/);
  });

  it('relaxes the fully-consumed exclusion rather than replacing it', () => {
    // The OR keeps both original arms intact: a NULL remaining_count still means "not tracked", not
    // "gone". Swapping the predicate out instead of widening it would change what the DEFAULT call
    // returns, which is the Put-Up inventory page.
    expect(SRC).toMatch(/AND \(\$\{includeConsumed\} OR p\.remaining_count IS NULL OR p\.remaining_count > 0\)/);
  });

  it('touches ONE query — use-soon and the collection GET keep their own filters', () => {
    // Two references by construction (the declaration and the one predicate). More means it leaked.
    expect((SRC.match(/includeConsumed/g) ?? []).length).toBe(2);
    // The unconditional exclusion must still exist somewhere else — that is use-soon, whose whole
    // purpose is a prompt to eat something, and an empty jar cannot be eaten.
    expect((SRC.match(/AND \(p\.remaining_count IS NULL OR p\.remaining_count > 0\)/g) ?? []).length).toBe(1);
  });
});
