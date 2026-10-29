# AGENTS.md — house style for garden-app

Follow this for every line you write or touch. Where a nearby file disagrees (heavy comments,
regex-over-source tests, copied helpers), follow this guide; the neighbour is old habit, not precedent.
Old headers that call the heavy style "the house pattern" are superseded; rewrite them when you next touch the file.

## Comments
- Write a comment only if it helps the next agent: why, a trap, an invariant, or the test that guards it.
- A block over about 3 lines must be a trap, an invariant or a pointer to its guarding test.
- History goes in the commit message or the ledger row, never in code. No dates, ticket ids, quotes from people, or "removed X because".
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

## Unused is not always dead
Never delete or rename as "unused": the rollback tooling and everything it calls (`skip_version_bump`, `workflow_dispatch` on deploy workflows, `revert-floors.json`, `forward-undo.py`, `revert-to.py`, `snap.py`, `preflight-revert-iam.py`, `gh_api_check.py`, `lambda_fleet.py`, their tests, the revert and rehearsal workflows) and `iconwire3`. Never add a push-to-main trigger or `|| echo "{}"` to a deploy workflow.

## Lambda (changes when D1 lands: a planned generator replaces the hand copying below)
- A function zip contains only its own folder, so never import `../` from a handler.
- Shared modules are canonical at `lambda/authz-parents.js`, `lambda/household.js`, `lambda/http-response.js`, `lambda/photo-access.js`, `lambda/tags/crop-derive.js` and `src/lib/imageMetadataStrip.js`.
- Each is copied into every function folder that uses it, guarded by `lambda/*-copies-sync.test.js`. Edit the canonical and every copy in the same change; never a copy alone.
- New handler code goes in a route module, as the preservation function does: `lambda/preservation/index.js` loads neon, clerk and aws, then delegates to sibling `*Routes.js` files (`jarRoutes.js`, `sourceRoutes.js`, `kitchenRoutes.js`).
  - A route module takes `sql` as an argument and imports only dependency-free siblings, so vitest can execute it.
  - It exports `handleXRoute({ sql, rawPath, method, rawBody, userId, householdIds })`, returning `{ status, body }`, or `null` for "not mine" so index.js falls through (`lambda/preservation/jarRoutes.js:56`, called at `lambda/preservation/index.js:271`).

## Tests
- Test new Lambda behaviour by calling the handler (stub drivers in `lambda/_test-stubs/`) or through the integration harness (`tests/integration/`). Never regex over `index.js`.
- Source-text checks are only for whole-codebase invariants (a rule that must hold in every file).
- Extend the nearest existing test file rather than adding a new one.
- Removing a flag or mechanism removes its tests in the same change.
