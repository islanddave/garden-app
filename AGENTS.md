# AGENTS.md — house style for garden-app

Follow this for every line you write or touch. Where a nearby file disagrees (heavy comments,
regex-over-source tests, copied helpers), follow this guide; the neighbour is old habit, not precedent.
Old headers that call the heavy style "the house pattern" are superseded; rewrite them when you next touch the file.

## Comments
- Write a comment only if it helps the next agent: why, a trap, an invariant, or the test that guards it.
- A block over about 3 lines must be a trap, an invariant or a pointer to its guarding test.
- History goes in the commit message or the ledger row, never in code. No dates, quotes from people, or "removed X because". A ticket id is fine only as the shortest pointer to a needed why.
- Directives are code, not noise; never delete or reflow them: shebangs, `eslint-`, `@ts-`, `@vite-`, `@vitest-`, `noqa`, `pragma`, `shellcheck`, `istanbul`/`v8`/`c8 ignore`.

Bad: a narrative block (`src/pages/EventNew.jsx:750-753`, the first 4 of 12+ lines of history):
```js
// V4-WEIGHQUEUEKILL-001 (BD-044) — the whole "Weigh-in queue - tap in weighing order" section is
// GONE, on Dave's instruction: "I never use that... it's a nice idea, but it's just not
// functionally useful for me and the way I log these." He asked for the WHOLE section, not only
// the ordering, and confirmed that when asked directly.
```
Good: a trap note (`src/lib/api.js:113-116`):
```js
// DO NOT remove this: without it, a failed offline refresh is indistinguishable from a successful one
// at every layer above the service worker, and dataCache resets its freshness clock on the failure.
export const FROM_CACHE_HEADER = 'X-From-Cache'
export const FROM_CACHE = Symbol.for('garden-app.fromCache')
```

## Structure
- New sections go in their own file. When you touch a big screen (EventNew.jsx is 4,300+ lines), split out what you touch.
- Every new feature flag (`src/lib/featureFlags.js`) states in its comment the condition under which it will be removed.
- Reads go through `useCachedFetch`, writes through `useApiFetch`.
- Memoize Provider `value` props (`useMemo`), or every consumer re-renders.
- Database: read through views, write through base tables. Reads that depend on constraints (existence, uniqueness, FK checks) also use base tables.
- Fix lint warnings only on lines you touch.
- `npm run lint` (eslint plus a madge import-cycle check) must pass before you push.

## Unused is not always dead
Never delete or rename as "unused": the rollback tooling and everything it calls (`skip_version_bump`, `workflow_dispatch` on deploy workflows, `revert-floors.json`, `forward-undo.py`, `revert-to.py`, `snap.py`, `preflight-revert-iam.py`, `gh_api_check.py`, `lambda_fleet.py`, their tests, the revert and rehearsal workflows) and `iconwire3`. Never add a push-to-main trigger or `|| echo "{}"` to a deploy workflow.

## Lambda
- A function zip contains only its own folder, so never import `../` from a handler.
- Shared modules are canonical at `lambda/authz-parents.js`, `lambda/household.js`, `lambda/http-response.js`, `lambda/photo-access.js`, `lambda/rate-limit.js`, `lambda/tags/crop-derive.js`, `lambda/plants/statusEvents.js`, `src/lib/critterSpecies.js` and `src/lib/imageMetadataStrip.js`. `scripts/lambda-copies.json` lists every byte copy.
- To change one: edit and commit the canonical, run `node scripts/gen-lambda-copies.mjs --write`, commit the copies with it. `--write` refuses a hand-edited copy, so drift stops for a human. After any rebase run `--check` only, never `--write`. A new copy: `cp` the canonical, list it in the manifest, run `--check`. Never edit a copy alone.
- New handler code goes in a route module, as the preservation function does: `lambda/preservation/index.js` loads neon, clerk and aws, then delegates to sibling `*Routes.js` files (`jarRoutes.js`, `sourceRoutes.js`, `kitchenRoutes.js`).
  - A route module takes `sql` as an argument and imports only dependency-free siblings, so vitest can execute it.
  - It exports `handleXRoute({ sql, rawPath, method, rawBody, userId, householdIds })`, returning `{ status, body }`, or `null` for "not mine" so index.js falls through (`lambda/preservation/jarRoutes.js:56`, called at `lambda/preservation/index.js:271`).

## Migrations
- Never edit an applied migration's text: tests, gates and audits read it. Copy the shape of a recent bundle (`migrations/v5-spaceguard-001/`: `0a-*.sql`, `0r-rollback.sql`, `gates.yml`, `README.md`).
- Comments in new migration files follow the Comments rules above: a short why block and the traps, no plan citations, ticket narrative or dates.
- A Put-Up train `0a` file keeps `-- schema_version: <stamp>` on line 2 (`integration-test.yml` checks it).

## Tests
Full policy: gardening-docs `project-state/_testpolicy-20261029/POLICY.md` (DEC-TESTPOLICY-001).
- Add cases to the test files your brief names. If none fits, create one with `// new-file: <reason>` on line 1 (new subject, a different module-level mock, or a behaviour split of a file over ~800 lines) and say so first in your hand-back. Never name a file for a round, lane, phase or ticket.
- Lambda handlers are importable (`lambda/_test-stubs`), but the stub never evaluates SQL. A filter, ownership or soft-delete property is proven only on real Postgres (`tests/integration`). Keep its source-text check; removing it follows the deletion rule below.
- Read source text only for: a forbidden pattern, a complete list, two copies that must match, a script slice you execute, a gate input, or a required SQL predicate with no integration twin yet. Every scan asserts it matched at least one item. Before removing or converting a source read, grep `scripts/` and `.github/` for a reader of that file.
- Column contracts: if the directory has a keyed `AUDIT_COLUMNS` file, add a key; if it has an `AUDIT_TABLES` file, add a new file and raise the ceiling (`scripts/count-ratchets.json`). Never both forms in one file: the auditor reads only the first.
- Pages mount the real router (`src/__tests__/helpers/routerHarness`); no new `vi.mock('react-router-dom')`. Layout, geometry and tap targets go in `tests/harness` + layout-gate, never jsdom.
- Prove it can fail: write the regression test first and log it red before the fix. For a new or changed guard on a safety, data-write, authz, deploy or food-safety path, log a mutation table (mutant diff, command, failing test id, quoted red line).
- Never delete or weaken an assertion unless your brief lists it and you name the test that still goes red for its mutation, or the code it tests is deleted in the same change. Files with `// GUARD:` in their first 5 lines are merge-only.
- A new test file's header is 5 lines or fewer: what it guards, the ruling or ticket id, the trap.
