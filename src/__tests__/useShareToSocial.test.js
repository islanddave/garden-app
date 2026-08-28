// Unit tests for src/hooks/useShareToSocial.js — the combined Facebook + Instagram publish hook.
//
// The assertions that matter here are not "does it post". They are the two defects the rescued
// lane-igtrack-20260821 version carried, which together form ONE loop:
//
//   the client aborts at the 15s app default -> the Lambda runs on to its 180s budget (a Function URL
//   is not cancelled by client disconnect) and posts anyway -> the user sees a failure for a live
//   post -> reloads the PWA -> a useRef-held key is GONE -> retry mints a fresh id -> the server's
//   replay lookup misses -> the same photos post to a public surface A SECOND TIME.
//
// So there are two tests here that would each pass trivially against the old code in isolation, and
// one — 'a timeout THEN a reload still replays' — that reproduces the whole loop. That one is the
// reason this file exists. On Instagram the stakes are asymmetric: a mistaken IG post cannot be
// deleted through the API (verified 2026-08-21, DELETE -> code 10).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }));
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }));

import {
  useShareToSocial, captionLimitFor, validateForTargets,
  countHashtags, countMentions, FB_CAPTION_MAX, IG_CAPTION_MAX,
} from '../hooks/useShareToSocial.js';
import { SHARE_TIMEOUT_MS } from '../hooks/useShareToFacebook.js';

const BOTH = { facebook: true, instagram: true };
const FB_ONLY = { facebook: true };
const IG_ONLY = { instagram: true };

const callFor = (path) => fetchSpy.mock.calls.find(([p]) => p === path);
const bodyFor = (path) => JSON.parse(callFor(path)[1].body);
const idFor = (path) => bodyFor(path).client_request_id;
const callsFor = (path) => fetchSpy.mock.calls.filter(([p]) => p === path);

const rejectWith = (props) => Object.assign(new Error(props.message ?? 'x'), props);

// Slots are PERSISTED by design (src/lib/shareIdempotency.js), so they outlive a hook instance.
// Clear between tests or one case's slot answers the next case's assertion.
beforeEach(() => {
  fetchSpy.mockReset();
  try { globalThis.localStorage?.clear(); } catch { /* jsdom always has it; guard matches the lib */ }
});

describe('useShareToSocial — request shape', () => {
  it('posts to both targets, Facebook first, with a stable order', async () => {
    fetchSpy.mockResolvedValue({ post_id: 'p1' });
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', BOTH); });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/share/facebook');
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/share/instagram');
    expect(result.current.state).toBe('success');
  });

  it('posts only the selected target', async () => {
    fetchSpy.mockResolvedValue({ media_id: 'm1' });
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', IG_ONLY); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/share/instagram');
  });

  it('trims the caption and sends null when blank', async () => {
    fetchSpy.mockResolvedValue({});
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], '  hi  ', FB_ONLY); });
    expect(bodyFor('/api/share/facebook').caption).toBe('hi');

    fetchSpy.mockReset(); fetchSpy.mockResolvedValue({});
    const { result: r2 } = renderHook(() => useShareToSocial());
    await act(async () => { await r2.current.share(['a'], '   ', FB_ONLY); });
    expect(bodyFor('/api/share/facebook').caption).toBeNull();
  });

  it('does nothing without photos or without a target', async () => {
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share([], 'hi', BOTH); });
    await act(async () => { await result.current.share(['a'], 'hi', {}); });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useShareToSocial — the timeout half of the double-post loop', () => {
  it('overrides the 15s app default on BOTH targets', async () => {
    fetchSpy.mockResolvedValue({});
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', BOTH); });

    // The Lambda's own budget is 180s. Aborting sooner does not stop the post, it only stops us
    // watching it — which is what manufactures the failure that leads to the duplicate.
    expect(SHARE_TIMEOUT_MS).toBeGreaterThan(180_000);
    expect(callFor('/api/share/facebook')[1].timeoutMs).toBe(SHARE_TIMEOUT_MS);
    expect(callFor('/api/share/instagram')[1].timeoutMs).toBe(SHARE_TIMEOUT_MS);
  });

  it('maps a timeout to its own state, NOT to error', async () => {
    fetchSpy.mockRejectedValueOnce(rejectWith({ timeout: true }));
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', FB_ONLY); });

    expect(result.current.perTarget.facebook.state).toBe('timeout');
    // The copy must not assert failure — the post may be live.
    expect(result.current.perTarget.facebook.error).toMatch(/may still have gone through/i);
    expect(result.current.perTarget.facebook.error).toMatch(/will not post twice/i);
  });
});

describe('useShareToSocial — idempotency', () => {
  it('gives each target its OWN id when BOTH fail — so the slot key is target-scoped', async () => {
    // Deliberately fails both. On the happy path this assertion passes even against a SHARED slot
    // key, because Facebook's success releases the slot before Instagram acquires it and the two ids
    // then differ by accident of ordering rather than by design (measured: that mutant survived the
    // success-path version of this test). With nothing released, only a genuinely target-scoped key
    // can still produce two ids.
    fetchSpy.mockRejectedValue(rejectWith({ timeout: true }));
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', BOTH); });

    expect(idFor('/api/share/facebook')).toEqual(expect.any(String));
    expect(idFor('/api/share/instagram')).toEqual(expect.any(String));
    expect(idFor('/api/share/facebook')).not.toBe(idFor('/api/share/instagram'));
  });

  it('one target stuck failing does not pin the OTHER target\'s deliberate repost', async () => {
    // The property per-target slots buy over a shared id: Instagram is wedged, but Dave can still
    // post the same photos to Facebook a second time on purpose. Under a shared id held until every
    // target succeeds, Facebook's id would stay pinned and the server would replay it away.
    fetchSpy
      .mockResolvedValueOnce({ post_id: 'p1' })          // facebook lands
      .mockRejectedValueOnce(rejectWith({ timeout: true })); // instagram wedged
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', BOTH); });
    const fbFirst = idFor('/api/share/facebook');

    // A fresh session deliberately reposting the same photos to Facebook only.
    fetchSpy.mockReset(); fetchSpy.mockResolvedValueOnce({ post_id: 'p2' });
    const { result: r2 } = renderHook(() => useShareToSocial());
    await act(async () => { await r2.current.share(['a'], 'hi', FB_ONLY); });
    expect(idFor('/api/share/facebook')).not.toBe(fbFirst);
  });

  it('a retry in the SAME session reuses the id', async () => {
    fetchSpy.mockRejectedValueOnce(rejectWith({ status: 500, body: { error: 'internal_error' } }));
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', FB_ONLY); });
    const first = idFor('/api/share/facebook');

    fetchSpy.mockResolvedValueOnce({});
    await act(async () => { await result.current.share(['a'], 'hi', FB_ONLY); });
    expect(callsFor('/api/share/facebook')).toHaveLength(2);
    expect(JSON.parse(callsFor('/api/share/facebook')[1][1].body).client_request_id).toBe(first);
  });

  it('THE LOOP: a timeout THEN a reload still replays instead of double-posting', async () => {
    // 1. The client stops waiting. The Lambda may well have posted.
    fetchSpy.mockRejectedValueOnce(rejectWith({ timeout: true }));
    const { result, unmount } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a', 'b'], 'toms', IG_ONLY); });
    expect(result.current.perTarget.instagram.state).toBe('timeout');
    const beforeReload = idFor('/api/share/instagram');

    // 2. The user reloads the PWA. Every ref in the app dies here — this is precisely where the
    //    rescued useRef-held key was lost, and where a fresh id would make the server's replay
    //    lookup miss and post the same photos to Instagram a second time.
    unmount();
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce({ media_id: 'm1' });
    const { result: afterReload } = renderHook(() => useShareToSocial());

    // 3. Same photos, same caption -> same slot -> SAME id. The server replays.
    await act(async () => { await afterReload.current.share(['a', 'b'], 'toms', IG_ONLY); });
    expect(idFor('/api/share/instagram')).toBe(beforeReload);
  });

  it('photo ORDER does not change the slot — same post, same id', async () => {
    fetchSpy.mockRejectedValueOnce(rejectWith({ timeout: true }));
    const { result, unmount } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a', 'b'], 'x', FB_ONLY); });
    const first = idFor('/api/share/facebook');

    unmount();
    fetchSpy.mockReset(); fetchSpy.mockResolvedValueOnce({});
    const { result: r2 } = renderHook(() => useShareToSocial());
    await act(async () => { await r2.current.share(['b', 'a'], 'x', FB_ONLY); });
    expect(idFor('/api/share/facebook')).toBe(first);
  });

  it('after a SUCCESS a deliberate repost of the same photos mints a NEW id', async () => {
    // The point of content-keyed storage released on success: idempotency must not become "this
    // photo can never be posted again".
    fetchSpy.mockResolvedValueOnce({});
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', FB_ONLY); });
    const first = idFor('/api/share/facebook');

    fetchSpy.mockReset(); fetchSpy.mockResolvedValueOnce({});
    const { result: r2 } = renderHook(() => useShareToSocial());
    await act(async () => { await r2.current.share(['a'], 'hi', FB_ONLY); });
    expect(idFor('/api/share/facebook')).not.toBe(first);
  });

  it('a DIFFERENT caption is a different post and gets a different id', async () => {
    fetchSpy.mockRejectedValueOnce(rejectWith({ timeout: true }));
    const { result, unmount } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'first', FB_ONLY); });
    const first = idFor('/api/share/facebook');

    unmount();
    fetchSpy.mockReset(); fetchSpy.mockResolvedValueOnce({});
    const { result: r2 } = renderHook(() => useShareToSocial());
    await act(async () => { await r2.current.share(['a'], 'second', FB_ONLY); });
    expect(idFor('/api/share/facebook')).not.toBe(first);
  });

  it('reset() does NOT release the slot — dismissing a sheet is not proof nothing posted', async () => {
    fetchSpy.mockRejectedValueOnce(rejectWith({ timeout: true }));
    const { result, unmount } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', FB_ONLY); });
    const first = idFor('/api/share/facebook');
    act(() => { result.current.reset(); });
    expect(result.current.state).toBe('idle');

    unmount();
    fetchSpy.mockReset(); fetchSpy.mockResolvedValueOnce({});
    const { result: r2 } = renderHook(() => useShareToSocial());
    await act(async () => { await r2.current.share(['a'], 'hi', FB_ONLY); });
    expect(idFor('/api/share/facebook')).toBe(first);
  });
});

describe('useShareToSocial — partial failure', () => {
  it('does NOT report success when only one target lands', async () => {
    fetchSpy
      .mockResolvedValueOnce({ post_id: 'p1' })                                   // facebook
      .mockRejectedValueOnce(rejectWith({ status: 502, body: { error: 'facebook_error' } })); // instagram
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', BOTH); });

    expect(result.current.state).toBe('partial');
    expect(result.current.perTarget.facebook.state).toBe('success');
    expect(result.current.perTarget.instagram.state).toBe('error');
  });

  it('a retry re-attempts ONLY the target that failed', async () => {
    fetchSpy
      .mockResolvedValueOnce({ post_id: 'p1' })
      .mockRejectedValueOnce(rejectWith({ status: 502, body: { error: 'facebook_error' } }));
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', BOTH); });

    fetchSpy.mockResolvedValueOnce({ media_id: 'm1' });
    await act(async () => { await result.current.share(['a'], 'hi', BOTH); });

    // Facebook was posted once and never again — this is the duplicate-prevention that matters.
    expect(callsFor('/api/share/facebook')).toHaveLength(1);
    expect(callsFor('/api/share/instagram')).toHaveLength(2);
    expect(result.current.state).toBe('success');
  });

  it('the failed target keeps its id across the retry while the succeeded one is released', async () => {
    fetchSpy
      .mockResolvedValueOnce({ post_id: 'p1' })
      .mockRejectedValueOnce(rejectWith({ timeout: true }));
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', BOTH); });
    const igId = idFor('/api/share/instagram');

    fetchSpy.mockResolvedValueOnce({ media_id: 'm1' });
    await act(async () => { await result.current.share(['a'], 'hi', BOTH); });
    expect(JSON.parse(callsFor('/api/share/instagram')[1][1].body).client_request_id).toBe(igId);
  });

  it('all targets failing is error, not partial', async () => {
    fetchSpy.mockRejectedValue(rejectWith({ status: 500, body: { error: 'internal_error' } }));
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', BOTH); });
    expect(result.current.state).toBe('error');
  });
});

describe('useShareToSocial — error mapping', () => {
  const cases = [
    ['403 forbidden', { status: 403, body: { error: 'Admin only' } }, 'forbidden'],
    ['dead page token', { status: 502, body: { error: 'facebook_token_invalid' } }, 'token_invalid'],
    ['instagram kill switch', { status: 503, body: { error: 'instagram_sharing_disabled' } }, 'disabled'],
    ['no ig_user_id in the secret', { status: 500, body: { error: 'ig_not_configured' } }, 'not_configured'],
    ['blocked by the content check', { status: 422, body: { error: 'content_blocked', message: 'location details' } }, 'content_blocked'],
  ];
  for (const [name, err, expected] of cases) {
    it(`maps ${name} to ${expected}`, async () => {
      fetchSpy.mockRejectedValueOnce(rejectWith(err));
      const { result } = renderHook(() => useShareToSocial());
      await act(async () => { await result.current.share(['a'], 'hi', IG_ONLY); });
      expect(result.current.perTarget.instagram.state).toBe(expected);
    });
  }

  it('the FACEBOOK kill switch does not read as an Instagram one', async () => {
    // disabledCode is per target; a shared string would let one target's outage present as another's.
    fetchSpy.mockRejectedValueOnce(rejectWith({ status: 503, body: { error: 'facebook_sharing_disabled' } }));
    const { result } = renderHook(() => useShareToSocial());
    await act(async () => { await result.current.share(['a'], 'hi', IG_ONLY); });
    expect(result.current.perTarget.instagram.state).toBe('error');
  });
});

describe('caption limits follow the strictest selected target', () => {
  it('Facebook alone allows the Facebook limit; adding Instagram tightens it', () => {
    expect(captionLimitFor(FB_ONLY)).toBe(FB_CAPTION_MAX);
    expect(captionLimitFor(BOTH)).toBe(IG_CAPTION_MAX);
    expect(captionLimitFor(IG_ONLY)).toBe(IG_CAPTION_MAX);
  });

  it('rejects a Facebook-legal caption once Instagram is selected', () => {
    const long = 'x'.repeat(3000);
    expect(validateForTargets(long, FB_ONLY)).toEqual([]);
    expect(validateForTargets(long, BOTH).join(' ')).toMatch(/2200/);
  });

  it('requires at least one target', () => {
    expect(validateForTargets('hi', {}).join(' ')).toMatch(/at least one/i);
  });

  it('counts hashtags and mentions the way Instagram does', () => {
    expect(validateForTargets('#a '.repeat(31), IG_ONLY).join(' ')).toMatch(/30 hashtags/);
    expect(countHashtags('a#b')).toBe(0);              // must follow start or whitespace
    expect(countHashtags('#a #b')).toBe(2);
    expect(countMentions('mail me at bob@example.com')).toBe(0);
    expect(countMentions('@bob hi')).toBe(1);
  });
});

describe('client/server constant parity', () => {
  // The Lambda module cannot be imported into the browser bundle, so these constants are duplicated.
  // Duplication is fine; SILENT drift is not — a client that thinks the cap is 2200 while the server
  // enforces something else rejects a post after Facebook has already gone out.
  it('the Instagram limits here match lambda/facebook-share/instagram.js', () => {
    // path.resolve off cwd, not import.meta.url — under jsdom that is an http: URL, not file:.
    const src = readFileSync(resolve(process.cwd(), 'lambda/facebook-share/instagram.js'), 'utf8');
    const num = (name) => {
      const m = src.match(new RegExp(`export const ${name} = (\\d+)`));
      expect(m, `${name} not found in the Lambda module`).toBeTruthy();
      return Number(m[1]);
    };
    expect(num('IG_MAX_CAPTION')).toBe(IG_CAPTION_MAX);
    expect(num('IG_MAX_HASHTAGS')).toBe(30);
    expect(num('IG_MAX_MENTIONS')).toBe(20);
  });
});
