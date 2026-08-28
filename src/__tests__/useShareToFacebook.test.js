// Unit tests for src/hooks/useShareToFacebook.js
// Strategy: mock useApiFetch. Verify request shape, state mapping, and the idempotency
// client_request_id lifecycle (persist across retry, fresh after success).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }));
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }));

import { useShareToFacebook, SHARE_TIMEOUT_MS } from '../hooks/useShareToFacebook.js';

const bodyOf = (callIdx) => JSON.parse(fetchSpy.mock.calls[callIdx][1].body);
const optsOf = (callIdx) => fetchSpy.mock.calls[callIdx][1];

// The idempotency key is now persisted (src/lib/shareIdempotency.js), so it outlives a hook
// instance BY DESIGN. Clear it between tests or slots leak across cases and the assertions below
// stop meaning what they say.
beforeEach(() => {
  fetchSpy.mockReset();
  try { globalThis.localStorage?.clear(); } catch { /* jsdom always has it; guard matches the lib */ }
});

describe('useShareToFacebook', () => {
  it('posts photo_ids + trimmed caption + a client_request_id and reports success', async () => {
    fetchSpy.mockResolvedValue({ post_group_id: 'g1', post_id: 'p1', permalink: 'https://fb/p1' });
    const { result } = renderHook(() => useShareToFacebook());
    await act(async () => { await result.current.share(['a', 'b'], '  hi  '); });
    expect(result.current.state).toBe('success');
    expect(result.current.result.post_id).toBe('p1');
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/share/facebook');
    const body = bodyOf(0);
    expect(body.photo_ids).toEqual(['a', 'b']);
    expect(body.caption).toBe('hi');           // trimmed
    expect(typeof body.client_request_id).toBe('string');
    expect(body.client_request_id.length).toBeGreaterThan(0);
  });

  it('sends null caption when blank', async () => {
    fetchSpy.mockResolvedValue({ post_id: 'p1' });
    const { result } = renderHook(() => useShareToFacebook());
    await act(async () => { await result.current.share(['a'], '   '); });
    expect(bodyOf(0).caption).toBeNull();
  });

  it('maps HTTP 403 to forbidden', async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('Admin only'), { status: 403, body: { error: 'Admin only' } }));
    const { result } = renderHook(() => useShareToFacebook());
    await act(async () => { await result.current.share(['a']).catch(() => {}); });
    expect(result.current.state).toBe('forbidden');
  });

  it('maps facebook_token_invalid body to token_invalid', async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 502, body: { error: 'facebook_token_invalid', message: 'expired' } }));
    const { result } = renderHook(() => useShareToFacebook());
    await act(async () => { await result.current.share(['a']).catch(() => {}); });
    expect(result.current.state).toBe('token_invalid');
    expect(result.current.error).toBe('expired');
  });

  it('reuses client_request_id across a retry, then issues a fresh one after success', async () => {
    fetchSpy
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500, body: { error: 'internal_error' } }))
      .mockResolvedValueOnce({ post_id: 'p2' });
    const { result } = renderHook(() => useShareToFacebook());
    await act(async () => { await result.current.share(['a']).catch(() => {}); });
    await act(async () => { await result.current.share(['a']); });     // retry — same attempt
    expect(bodyOf(0).client_request_id).toBe(bodyOf(1).client_request_id);
    expect(result.current.state).toBe('success');

    fetchSpy.mockResolvedValueOnce({ post_id: 'p3' });
    await act(async () => { await result.current.share(['b']); });     // fresh attempt
    expect(bodyOf(2).client_request_id).not.toBe(bodyOf(0).client_request_id);
  });

  // ── The reload hole (the reason the key moved out of the useRef) ────────────────────────────────
  // A useRef dies on reload, and a reload is exactly what happens after the client stops waiting on
  // a post the server is still making. A fresh id there makes the server's replay lookup miss and
  // the same photos post to the public Page twice. A NEW hook instance stands in for the reload.
  it('reuses client_request_id across a RELOAD — a fresh hook instance resolves the same id', async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500, body: { error: 'internal_error' } }));
    const first = renderHook(() => useShareToFacebook());
    await act(async () => { await first.result.current.share(['a', 'b'], 'hi').catch(() => {}); });
    first.unmount();                                              // reload: all component state gone

    fetchSpy.mockResolvedValueOnce({ post_id: 'p9' });
    const second = renderHook(() => useShareToFacebook());
    await act(async () => { await second.result.current.share(['a', 'b'], 'hi'); });

    expect(bodyOf(1).client_request_id).toBe(bodyOf(0).client_request_id);
  });

  it('resolves the same slot when the same photos are picked in a different order', async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500, body: {} }));
    const { result } = renderHook(() => useShareToFacebook());
    await act(async () => { await result.current.share(['a', 'b'], 'hi').catch(() => {}); });
    fetchSpy.mockResolvedValueOnce({ post_id: 'p1' });
    await act(async () => { await result.current.share(['b', 'a'], 'hi'); });
    expect(bodyOf(1).client_request_id).toBe(bodyOf(0).client_request_id);
  });

  // The counterpart to durability: a deterministic hash of the content would replay forever, so a
  // photo posted once could never be posted again. Releasing on success is what preserves reposting.
  it('mints a NEW id when identical content is deliberately posted again after a success', async () => {
    fetchSpy.mockResolvedValue({ post_id: 'p1' });
    const { result } = renderHook(() => useShareToFacebook());
    await act(async () => { await result.current.share(['a'], 'same'); });
    await act(async () => { await result.current.share(['a'], 'same'); });
    expect(bodyOf(1).client_request_id).not.toBe(bodyOf(0).client_request_id);
  });

  // ── The timeout that was inventing failures for successful posts ────────────────────────────────
  it('waits past the Lambda 180s budget rather than aborting at the 15s app default', async () => {
    fetchSpy.mockResolvedValue({ post_id: 'p1' });
    const { result } = renderHook(() => useShareToFacebook());
    await act(async () => { await result.current.share(['a']); });
    expect(optsOf(0).timeoutMs).toBe(SHARE_TIMEOUT_MS);
    expect(SHARE_TIMEOUT_MS).toBeGreaterThan(180_000);
  });

  it('maps a client timeout to `timeout`, not `error`, and keeps the id for an idempotent retry', async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('Request timed out'), { timeout: true }));
    const { result } = renderHook(() => useShareToFacebook());
    await act(async () => { await result.current.share(['a']).catch(() => {}); });
    expect(result.current.state).toBe('timeout');
    expect(result.current.error).toMatch(/may still have gone through/i);

    fetchSpy.mockResolvedValueOnce({ post_id: 'p1' });
    await act(async () => { await result.current.share(['a']); });
    expect(bodyOf(1).client_request_id).toBe(bodyOf(0).client_request_id);
  });

  // reset() is a UI dismissal, not evidence that nothing was posted. Dropping the stored id here
  // would hand the next attempt a fresh one and reopen the hole this whole module closes.
  it('reset() does not discard the stored id for an attempt that may be live', async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500, body: {} }));
    const { result } = renderHook(() => useShareToFacebook());
    await act(async () => { await result.current.share(['a'], 'c').catch(() => {}); });
    act(() => { result.current.reset(); });
    fetchSpy.mockResolvedValueOnce({ post_id: 'p1' });
    await act(async () => { await result.current.share(['a'], 'c'); });
    expect(bodyOf(1).client_request_id).toBe(bodyOf(0).client_request_id);
  });

  it('no-ops on an empty photo list', async () => {
    const { result } = renderHook(() => useShareToFacebook());
    let ret;
    await act(async () => { ret = await result.current.share([]); });
    expect(ret).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });
});
