// Unit tests for src/hooks/useShareToFacebook.js
// Strategy: mock useApiFetch. Verify request shape, state mapping, and the idempotency
// client_request_id lifecycle (persist across retry, fresh after success).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }));
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }));

import { useShareToFacebook } from '../hooks/useShareToFacebook.js';

const bodyOf = (callIdx) => JSON.parse(fetchSpy.mock.calls[callIdx][1].body);

beforeEach(() => fetchSpy.mockReset());

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

  it('no-ops on an empty photo list', async () => {
    const { result } = renderHook(() => useShareToFacebook());
    let ret;
    await act(async () => { ret = await result.current.share([]); });
    expect(ret).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });
});
