// BUG-FBSHAREBYTES-001 — real execution coverage for the bounded-concurrency map.
//
// Worth stating why this file can exist when facebook-share/index.js has no execution coverage at
// all: batch.js imports NOTHING, so the unit run can load it. That is the whole reason the batching
// was extracted rather than left inline — see the note at the top of batch.js.
import { describe, it, expect } from 'vitest';
import { mapInBatches } from './batch.js';

// A deferred promise per call, so a test can hold items open and observe how many are in flight.
// Without this the batching is invisible: every assertion would be about the RESULT, and a plain
// Promise.all produces exactly the same result as a batched one. Concurrency is the thing under
// test, so concurrency has to be observable.
function tracker() {
  const state = { inFlight: 0, peak: 0, started: [], resolvers: [] };
  const fn = (item, i) => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    state.started.push(item);
    return new Promise((resolve) => {
      state.resolvers.push(() => { state.inFlight -= 1; resolve(`${item}@${i}`); });
    });
  };
  const flush = async () => {
    // Drain whatever has started, then yield so the next batch can begin.
    while (state.resolvers.length) state.resolvers.shift()();
    await Promise.resolve();
  };
  return { state, fn, flush };
}

const items = (n) => Array.from({ length: n }, (_, i) => `p${i}`);

describe('mapInBatches', () => {
  it('never runs more than `size` at once', async () => {
    const { state, fn, flush } = tracker();
    const run = mapInBatches(items(10), 3, fn);
    // Nothing has resolved yet, so whatever started is batch one and nothing more.
    expect(state.inFlight).toBe(3);
    expect(state.peak).toBe(3);
    for (let i = 0; i < 5; i += 1) await flush();
    await run;
    expect(state.peak).toBe(3);
  });

  it('starts ONLY the first batch before anything resolves — the memory bound', async () => {
    // The failure this guards is the one that was live: all ten originals downloaded at once. If the
    // implementation regressed to Promise.all, started would be all 10 here.
    const { state, fn, flush } = tracker();
    const run = mapInBatches(items(10), 3, fn);
    expect(state.started).toEqual(['p0', 'p1', 'p2']);
    for (let i = 0; i < 5; i += 1) await flush();
    await run;
  });

  it('preserves input order — prepared[0] is the carousel cover', async () => {
    // Resolving in REVERSE within each batch: a result array built from completion order rather
    // than input order would come back shuffled, and the cover photo would silently change.
    const out = await mapInBatches(items(7), 3, async (item, i) => {
      await new Promise((r) => setTimeout(r, (7 - i) * 2));
      return `${item}@${i}`;
    });
    expect(out).toEqual(['p0@0', 'p1@1', 'p2@2', 'p3@3', 'p4@4', 'p5@5', 'p6@6']);
  });

  it('passes the ORIGINAL index, not the index within the batch', async () => {
    const seen = [];
    await mapInBatches(items(7), 3, async (item, i) => { seen.push(i); return item; });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('handles a batch size that does not divide the input evenly', async () => {
    const out = await mapInBatches(items(7), 3, async (item) => item);
    expect(out).toHaveLength(7);
    expect(out[6]).toBe('p6');            // the ragged final batch of one is not dropped
  });

  it('rejects on the first failure, like Promise.all — the caller’s error path expects it', async () => {
    await expect(mapInBatches(items(6), 2, async (item) => {
      if (item === 'p3') throw new Error('strip failed');
      return item;
    })).rejects.toThrow('strip failed');
  });

  it('does not START a later batch once one has failed', async () => {
    // Matters for real money: each started item is a multi-megabyte S3 GET. A failure in batch two
    // must not go on to download batches three and four.
    const started = [];
    await expect(mapInBatches(items(9), 3, async (item) => {
      started.push(item);
      if (item === 'p4') throw new Error('boom');
      return item;
    })).rejects.toThrow('boom');
    expect(started).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);   // batch 3 never begins
  });

  it('degrades to ONE batch on a nonsense size rather than hanging', async () => {
    // A loop incremented by 0 never advances: the invocation would burn its 180 s and die with no
    // output. A bad constant should degrade to the old Promise.all behaviour, not to a timeout.
    for (const bad of [0, -1, NaN, undefined, null, 'three']) {
      await expect(mapInBatches(items(4), bad, async (i) => i)).resolves.toEqual(items(4));
    }
  });

  it('handles the empty and single-item cases', async () => {
    expect(await mapInBatches([], 3, async (i) => i)).toEqual([]);
    expect(await mapInBatches(undefined, 3, async (i) => i)).toEqual([]);
    expect(await mapInBatches(['solo'], 3, async (i) => i)).toEqual(['solo']);
  });
});
