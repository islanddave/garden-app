// Unit tests for lambda/facebook-share/orphans.js
//
// This path decides whether a failed multi-photo post leaves invisible published=false media on a
// PUBLIC Facebook Page, and whether share_log tells the truth about it. Before this file it had no
// execution coverage at all — it lived inside index.js, which the root vitest run cannot import
// (AWS/Clerk/Neon deps live in this directory's own package.json).
//
// The defect under test: the previous implementation discarded every delete result and marked every
// row 'orphan_cleaned' regardless, so a delete that never happened was recorded as a completed
// cleanup.

import { describe, it, expect, vi } from 'vitest';
import { cleanupOrphanMedia, strandedError } from './orphans.js';

const MEDIA = [
  { photo_id: 'p1', media_fbid: 'm1' },
  { photo_id: 'p2', media_fbid: 'm2' },
  { photo_id: 'p3', media_fbid: 'm3' },
];

function harness({ deleteMedia }) {
  const markCleaned = vi.fn().mockResolvedValue(undefined);
  const markStranded = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  return { deleteMedia, markCleaned, markStranded, log };
}

describe('cleanupOrphanMedia', () => {
  it('marks every row cleaned when every delete is confirmed', async () => {
    const h = harness({ deleteMedia: vi.fn().mockResolvedValue(true) });
    const res = await cleanupOrphanMedia({ media: MEDIA, ...h });

    expect(res.cleaned.map((o) => o.photo_id)).toEqual(['p1', 'p2', 'p3']);
    expect(res.stranded).toEqual([]);
    expect(h.markCleaned).toHaveBeenCalledTimes(3);
    expect(h.markStranded).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalled();
  });

  // THE REGRESSION GUARD. A false return is the delete helper's own swallowed-error signal. Marking
  // this row 'orphan_cleaned' is the bug: it asserts a clean Page while m2 is still on it.
  it('does NOT mark a row cleaned when its delete was not confirmed', async () => {
    const deleteMedia = vi.fn(async (id) => id !== 'm2');
    const h = harness({ deleteMedia });
    const res = await cleanupOrphanMedia({ media: MEDIA, ...h });

    expect(res.cleaned.map((o) => o.photo_id)).toEqual(['p1', 'p3']);
    expect(res.stranded.map((o) => o.photo_id)).toEqual(['p2']);

    const cleanedIds = h.markCleaned.mock.calls.map((c) => c[0]);
    expect(cleanedIds).toEqual(['p1', 'p3']);
    expect(cleanedIds).not.toContain('p2');
    expect(h.markStranded).toHaveBeenCalledWith('p2', 'm2');
  });

  it('treats a delete that THROWS as not-confirmed, and still deletes the others', async () => {
    const deleteMedia = vi.fn(async (id) => {
      if (id === 'm1') throw new Error('network down');
      return true;
    });
    const h = harness({ deleteMedia });
    const res = await cleanupOrphanMedia({ media: MEDIA, ...h });

    expect(deleteMedia).toHaveBeenCalledTimes(3);          // one thrower does not abort the rest
    expect(res.stranded.map((o) => o.photo_id)).toEqual(['p1']);
    expect(res.cleaned.map((o) => o.photo_id)).toEqual(['p2', 'p3']);
    expect(h.markStranded).toHaveBeenCalledWith('p1', 'm1');
  });

  it('logs loudly, and only, when something is stranded', async () => {
    const h = harness({ deleteMedia: vi.fn().mockResolvedValue(false) });
    await cleanupOrphanMedia({ media: MEDIA, ...h });
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log.mock.calls[0][0]).toMatch(/FAILED for 3 of 3/);
    expect(h.log.mock.calls[0][1]).toBe('m1,m2,m3');
  });

  // Audit writes must never mask the publish failure that brought us here.
  it('does not throw when a status write fails', async () => {
    const h = harness({ deleteMedia: vi.fn().mockResolvedValue(true) });
    h.markCleaned.mockRejectedValue(new Error('db gone'));
    await expect(cleanupOrphanMedia({ media: MEDIA, ...h })).resolves.toBeTruthy();
  });

  it('does not throw when a stranded status write fails', async () => {
    const h = harness({ deleteMedia: vi.fn().mockResolvedValue(false) });
    h.markStranded.mockRejectedValue(new Error('db gone'));
    await expect(cleanupOrphanMedia({ media: MEDIA, ...h })).resolves.toBeTruthy();
  });

  it('no-ops on an empty or absent media list without calling the delete seam', async () => {
    const h = harness({ deleteMedia: vi.fn() });
    expect(await cleanupOrphanMedia({ media: [], ...h })).toEqual({ cleaned: [], stranded: [] });
    expect(await cleanupOrphanMedia({ media: undefined, ...h })).toEqual({ cleaned: [], stranded: [] });
    expect(h.deleteMedia).not.toHaveBeenCalled();
  });

  it('names the specific media id in the stranded error so it can be removed by hand', () => {
    const msg = strandedError('m9');
    expect(msg).toContain('m9');
    expect(msg).toMatch(/still on the Page/i);
  });
});
