// BUG-FBSHAREBYTES-001 — bounded-concurrency map.
//
// Extracted into its own module rather than inlined in index.js for one reason: index.js imports
// @neondatabase/serverless, @clerk/backend and two AWS SDK clients at module scope, none of which
// live in the ROOT package.json, so it CANNOT be imported by the unit run at all (vi.mock does not
// help — Vite resolves specifiers before mocks apply). Anything left inside it can only ever be
// covered by a source-text guard that asserts the shape of the code rather than what it does.
//
// This file imports nothing. So the batching — the part with the off-by-one risk and the ordering
// contract — gets real execution coverage, and index.js keeps only the call.

/**
 * Run `fn` over `items`, at most `size` at a time, preserving input order in the result.
 *
 * Sequential batches, parallel within a batch. This is a MEMORY bound, not a rate limit: the caller
 * downloads multi-megabyte originals and holds the bytes, so what matters is how many are alive at
 * once, not how fast they are issued.
 *
 * ORDER IS PART OF THE CONTRACT, not an implementation detail. The caller's `prepared[0]` is the
 * carousel cover — the photo the user picked first — so a result array that merely contains the
 * right items is not good enough.
 *
 * Rejects on the first failing item, exactly like Promise.all, because the caller's error path
 * (failAll + orphan cleanup) is written against that behaviour. Items in later, unstarted batches
 * are never begun; items in the SAME batch are already in flight and are not cancelled — there is
 * no cancellation to do, they simply settle and are discarded.
 */
export async function mapInBatches(items, size, fn) {
  const list = Array.isArray(items) ? items : [];
  // A non-positive or non-finite size would make the loop below never advance. Falling back to
  // "one batch" reproduces Promise.all rather than hanging: a bad constant should degrade to the
  // old behaviour, not to an invocation that burns its 180 s and dies with no output.
  const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : list.length || 1;
  const out = [];
  for (let i = 0; i < list.length; i += n) {
    out.push(...await Promise.all(list.slice(i, i + n).map((item, j) => fn(item, i + j))));
  }
  return out;
}
