// BUG-EVENTPROJPLANTPAIR-001 — the event anchor pair must agree with its planting.
//
// THE INVARIANT: when event_log.plant_id is non-NULL, event_log.project_id MUST equal that
// planting's project_id. 43 rows on prod violate it (39 live), the newest minted 2026-08-14 — so
// this is an open wound, and these tests exist to close the writers rather than the data.
//
// THE BEHAVIOURAL HALF LIVES IN tests/integration/anchor-pair.int.test.js. It used to live here,
// driving the real handler over a recording `sql`, on the stated grounds that the repo-wide rule
// "no lambda unit test imports a handler — the Lambda runtime deps are not installed at the repo
// root, so import './index.js' fails at Vite transform time" (header of
// lambda/varieties/authz-household.test.js) was stale. IT WAS NOT STALE. That version passed
// locally and failed CI on dev 32993a3:
//
//   Error: Failed to resolve import "@neondatabase/serverless" from "lambda/events/index.js"
//
// @neondatabase/serverless, @clerk/backend and @aws-sdk/client-secrets-manager appear in NO
// package.json in this repo — not as a dependency, not as a devDependency — so `npm ci` cannot
// install them and the unit run cannot resolve them. vitest.config.ts says so out loud where it
// excludes tests/integration/**: "so `npm test` doesn't try to resolve @neondatabase/serverless".
// The probe that reported them resolvable was run in a worktree whose node_modules had been CLONED
// from a sibling lane that carried them — a local green CI could never reproduce. Whether to make
// them installable is ledger row OPS-LAMBDATESTIMPORT-001, not a matter for a test file.
//
// So this file keeps exactly the two layers that need no handler import: the rule as a pure
// function, and a source scan proving the write sites READ that rule. The integration layer, where
// the workflow installs those three packages on purpose, asserts the row Postgres actually holds —
// which is strictly stronger than the parameter binds this file used to read.
//
// MUTATION-CHECKED. Each integration case was confirmed RED against the pre-fix source and GREEN
// after — recorded in the lane report. A guard that stays green when you revert the thing it guards
// is worth less than no guard at all.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveEventProjectId } from './validators.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'index.js'), 'utf8');

// The planting's REAL project, and the different one a request would claim. The whole ticket is
// the gap between these two values.
const PROJ_TRUE = '11111111-1111-4111-8111-111111111111';
const PROJ_CLAIMED = '22222222-2222-4222-8222-222222222222';
const PLANT = '33333333-3333-4333-8333-333333333333';

describe('deriveEventProjectId — the rule, in isolation', () => {
  it('a planting-bearing event takes its project FROM THE PLANTING, discarding the request value', () => {
    expect(deriveEventProjectId({
      plantId: PLANT, plantProjectId: PROJ_TRUE, requestedProjectId: PROJ_CLAIMED,
    })).toBe(PROJ_TRUE);
  });

  it('a planting-less event may still take project_id from the request — nothing to disagree with', () => {
    expect(deriveEventProjectId({
      plantId: null, plantProjectId: null, requestedProjectId: PROJ_CLAIMED,
    })).toBe(PROJ_CLAIMED);
  });

  it('a project-less planting yields a project-less event, rather than keeping the claimed project', () => {
    // This is the Bucket B shape (3 live rows). Deriving to NULL is legal — event_log_has_anchor is
    // satisfied by plant_id — and is now SAFE, because the PUT ownership SELECT, the PUT UPDATE and
    // the DELETE route all carry the two-arm `project_id IS NULL` predicate. Keeping the claimed
    // project instead is precisely how those rows were minted.
    expect(deriveEventProjectId({
      plantId: PLANT, plantProjectId: null, requestedProjectId: PROJ_CLAIMED,
    })).toBeNull();
  });

  it('never invents a project for a bare event', () => {
    expect(deriveEventProjectId({ plantId: null, plantProjectId: PROJ_TRUE, requestedProjectId: null })).toBeNull();
  });
});

describe('the derivation is USED — not merely present', () => {
  // The integration layer proves the value is right for real rows. These prove the WIRING: that the
  // write sites read the derived binding, and that nothing re-introduces a body-sourced project_id.
  it('POST derives projectId through deriveEventProjectId and binds THAT', () => {
    expect(SRC).toMatch(/const projectId = deriveEventProjectId\(\{[\s\S]{0,220}?requestedProjectId,\s*\}\);/);
    expect(SRC, 'the POST INSERT must bind the derived projectId')
      .toMatch(/INSERT INTO event_log[\s\S]*?VALUES \(\s*\$\{projectId\}/);
  });

  it('PUT derives newProjectId through deriveEventProjectId and binds THAT', () => {
    expect(SRC).toMatch(/const newProjectId\s*=\s*deriveEventProjectId\(\{/);
    expect(SRC).toMatch(/project_id\s*=\s*\$\{newProjectId\}::uuid/);
  });

  it('neither arm still takes project_id straight from the body', () => {
    // The exact pre-fix spellings. Either one reappearing is the bug returning.
    expect(SRC).not.toMatch(/const projectId = body\.project_id \?\? null;/);
    expect(SRC).not.toMatch(/const newProjectId\s*=\s*body\.project_id \?\? oldProjectId;/);
  });

  it('the planting ref carries project_id, which is what makes the derivation free', () => {
    const authz = readFileSync(join(here, 'authz-parents.js'), 'utf8');
    expect(authz).toMatch(/SELECT gn\.id, gn\.name, gn\.project_id/);
  });

  it('the PUT pre-read exposes the current planting\'s project WITHOUT the soft-delete filter', () => {
    // Reading it through the `pn` join would return NULL for the 39 live events whose planting is
    // soft-deleted, and silently clear a project_id that was never wrong.
    expect(SRC).toMatch(/\(SELECT gn2\.container_id FROM public\.garden_node gn2\s*\n\s*WHERE gn2\.id = el\.plant_id\) AS plant_project_id/);
  });

  it('BUG-EMPROJGUARD-001: BOTH project-keyed entity_memory upserts self-guard on a NULL project', () => {
    // The derivation made newProjectId nullable, which re-opened on the PUT's re-anchor arm the
    // exact hole BUG-EMPROJGUARD-001 closed on the POST arm: a NULL bind with no other parent
    // violates the VALIDATED CHECK entity_memory_exactly_one_parent and aborts the cache
    // transaction AFTER the event_log UPDATE has committed. Two guards, asserted as a pair so a
    // future arm cannot be added without one.
    expect(SRC.match(/WHERE \$\{projectId\}::uuid IS NOT NULL/g) ?? [],
      'the POST arm lost its guard').toHaveLength(1);
    expect(SRC.match(/WHERE \$\{newProjectId\}::uuid IS NOT NULL/g) ?? [],
      'the PUT re-anchor arm lost its guard').toHaveLength(1);
  });
});
