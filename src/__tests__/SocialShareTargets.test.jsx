// V4-IGSHARE-001 — combined Facebook + Instagram compose targets.
// Strategy mirrors FacebookShareSheet.test.jsx: mock useApiFetch, let the real useShareToSocial run.
// The load-bearing case is PARTIAL failure — one target lands, the other does not — because that is
// the only path that can either lie about success or double-post on retry.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }));
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }));

import FacebookShareSheet from '../components/FacebookShareSheet.jsx';
import { captionLimitFor, validateForTargets, IG_CAPTION_MAX, FB_CAPTION_MAX } from '../hooks/useShareToSocial.js';

const photos = [{ id: 'a', view_url: 'u1' }, { id: 'b', view_url: 'u2' }];
const openSheet = (props = {}) => render(<FacebookShareSheet open photos={photos} onClose={() => {}} {...props} />);
const pill = (name) => screen.getByRole('switch', { name });
const pathsCalled = () => fetchSpy.mock.calls.map((c) => c[0]);

// Responses are QUEUED IN ORDER rather than routed by path, which both matches the hook's
// deliberately sequential posting (Facebook, then Instagram) and keeps each rejection one-shot.
// A persistent mockImplementation that throws trips vitest's unhandled-rejection detector even
// when the hook demonstrably catches it — verified: same single call, same correct blocked UI,
// passes as ...Once and fails as persistent. Queueing avoids that harness artifact.
const queue = (...fns) => fns.forEach((f) => fetchSpy.mockImplementationOnce(f));
const ok = (value) => async () => value;
const fails = (body) => async () => { throw Object.assign(new Error('rejected'), body); };

beforeEach(() => fetchSpy.mockReset());

describe('caption limit follows the strictest selected target', () => {
  it('Facebook alone allows the Facebook limit', () => {
    expect(captionLimitFor({ facebook: true, instagram: false })).toBe(FB_CAPTION_MAX);
  });
  // Selecting Instagram must TIGHTEN the limit. Otherwise a 3000-char caption posts to Facebook
  // (public, irreversible) and only then fails on Instagram.
  it('adding Instagram tightens it to the Instagram limit', () => {
    expect(captionLimitFor({ facebook: true, instagram: true })).toBe(IG_CAPTION_MAX);
    expect(IG_CAPTION_MAX).toBeLessThan(FB_CAPTION_MAX);
  });
});

describe('validateForTargets', () => {
  it('requires at least one target', () => {
    expect(validateForTargets('hi', { facebook: false, instagram: false })).toHaveLength(1);
  });
  it('accepts a long caption when only Facebook is selected', () => {
    expect(validateForTargets('x'.repeat(3000), { facebook: true })).toEqual([]);
  });
  it('rejects that same caption once Instagram is selected', () => {
    expect(validateForTargets('x'.repeat(3000), { facebook: true, instagram: true }).length).toBeGreaterThan(0);
  });
  it('rejects too many hashtags for Instagram', () => {
    const cap = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
    expect(validateForTargets(cap, { instagram: true }).length).toBeGreaterThan(0);
  });
});

describe('target picker', () => {
  it('offers both targets, with Instagram OFF by default', () => {
    openSheet();
    expect(pill('Facebook').getAttribute('aria-checked')).toBe('true');
    // IG_SHARE_ENABLED is unset in prod; defaulting it on would make every post partially fail.
    expect(pill('Instagram').getAttribute('aria-checked')).toBe('false');
  });

  it('posts to Facebook only by default', async () => {
    queue(ok({ post_id: 'p1' }), ok({ id: 'ig1' }));
    openSheet();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook/i })); });
    await waitFor(() => expect(screen.getByText(/Posted to Facebook/i)).toBeTruthy());
    expect(pathsCalled()).toEqual(['/api/share/facebook']);
  });

  it('posts to both when Instagram is switched on, and says so', async () => {
    queue(ok({ post_id: 'p1', permalink: 'https://x/1' }), ok({ id: 'ig1', permalink: 'https://x/2' }));
    openSheet();
    fireEvent.click(pill('Instagram'));
    expect(screen.getByRole('button', { name: /post to facebook & instagram/i })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook & instagram/i })); });
    await waitFor(() => expect(screen.getByText(/Posted to Facebook and Instagram/i)).toBeTruthy());
    expect(pathsCalled()).toEqual(['/api/share/facebook', '/api/share/instagram']);
  });

  it('cannot post with no target selected', () => {
    openSheet();
    fireEvent.click(pill('Facebook'));
    expect(screen.getByRole('button', { name: /post to/i }).disabled).toBe(true);
  });

  it('sends ONE shared client_request_id to both targets', async () => {
    queue(ok({ post_id: 'p1' }), ok({ id: 'ig1' }));
    openSheet();
    fireEvent.click(pill('Instagram'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook & instagram/i })); });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const ids = fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body).client_request_id);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).toBe(ids[1]);
  });
});

// ★ The case the whole design exists for.
describe('partial failure', () => {
  // Facebook lands, Instagram does not — in that order, which is the order the hook posts them.
  const fbOkIgFails = () =>
    queue(ok({ post_id: 'p1' }), fails({ body: { message: 'Instagram rejected the image' } }));

  it('does NOT report success when only Facebook lands', async () => {
    fbOkIgFails();
    const onPosted = vi.fn();
    openSheet({ onPosted });
    fireEvent.click(pill('Instagram'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook & instagram/i })); });
    await waitFor(() => expect(screen.getByText(/Only part of this went out/i)).toBeTruthy());
    // The success screen must not appear, and the caller must not be told it worked.
    expect(screen.queryByText(/^Posted to/i)).toBeNull();
    expect(onPosted).not.toHaveBeenCalled();
  });

  it('names the target that failed and surfaces its reason', async () => {
    fbOkIgFails();
    openSheet();
    fireEvent.click(pill('Instagram'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook & instagram/i })); });
    await waitFor(() => expect(screen.getByText(/Instagram: Instagram rejected the image/i)).toBeTruthy());
  });

  // ★★ The double-post guard. Retrying after a partial failure must re-attempt ONLY the failed
  // target — Facebook is already public and cannot be un-posted.
  it('retry re-attempts only the failed target, never the one that succeeded', async () => {
    fbOkIgFails();
    openSheet();
    fireEvent.click(pill('Instagram'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook & instagram/i })); });
    await waitFor(() => expect(screen.getByText(/Only part of this went out/i)).toBeTruthy());
    expect(pathsCalled()).toEqual(['/api/share/facebook', '/api/share/instagram']);

    queue(ok({ id: 'ig1', permalink: 'https://instagram.com/p/x' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /retry/i })); });
    await waitFor(() => expect(screen.getByText(/Posted to Facebook and Instagram/i)).toBeTruthy());

    // Exactly one further call, and it was Instagram. A second Facebook call here would be a
    // duplicate public post.
    expect(pathsCalled()).toEqual(['/api/share/facebook', '/api/share/instagram', '/api/share/instagram']);
  });

  it('marks the succeeded target done so it cannot be toggled off and re-sent', async () => {
    fbOkIgFails();
    openSheet();
    fireEvent.click(pill('Instagram'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook & instagram/i })); });
    await waitFor(() => expect(screen.getByText(/Only part of this went out/i)).toBeTruthy());
    expect(pill('Facebook').disabled).toBe(true);
  });
});

describe('blocked vs partial', () => {
  it('a 403 on the only selected target replaces the composer', async () => {
    queue(fails({ status: 403, body: {} }));
    openSheet();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook/i })); });
    await waitFor(() => expect(screen.getByText(/only the page admin/i)).toBeTruthy());
  });

  // A blocked Instagram alongside a live Facebook must NOT hide the composer behind a lock screen.
  it('one blocked target alongside a success stays on the composer', async () => {
    queue(ok({ post_id: 'p1' }),
      fails({ body: { error: 'instagram_sharing_disabled', message: 'Instagram sharing is currently turned off.' } }));
    openSheet();
    fireEvent.click(pill('Instagram'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook & instagram/i })); });
    await waitFor(() => expect(screen.getByText(/Only part of this went out/i)).toBeTruthy());
    expect(screen.queryByText(/Can’t post right now/i)).toBeNull();
    expect(screen.getByLabelText(/caption/i)).toBeTruthy();
  });
});
