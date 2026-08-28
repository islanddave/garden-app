// V4-IGSHARE-001 — the destination picker and the PARTIAL outcome on the share sheet.
//
// FacebookShareSheet.test.jsx covers the default path, which is Facebook alone and reads exactly as
// it did before Instagram existed. This file covers what the second destination adds, and the two
// things that only become possible once there is more than one:
//
//   1. A post can now HALF succeed. The failure mode to design against is not "it broke" — it is the
//      sheet saying "Posted" while one surface never received anything, or a retry re-sending the
//      one that already landed. On Instagram that second mistake is unrecoverable: a published post
//      cannot be deleted through the API (verified 2026-08-21, DELETE -> code 10).
//   2. The caption is now governed by the STRICTEST selected target. Facebook accepts 5000
//      characters and Instagram rejects above 2200, so without this the user writes 3000, Facebook
//      accepts it, and Instagram rejects the whole post after the Facebook one is already public.
//
// Strategy matches the sibling file: mock useApiFetch so the real useShareToSocial hook runs.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }));
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }));
vi.mock('../components/PhotoImg.jsx', () => ({ default: ({ alt }) => <img alt={alt || ''} src="stub" /> }));

import FacebookShareSheet from '../components/FacebookShareSheet.jsx';

const photos = [{ id: 'a', view_url: 'u1' }, { id: 'b', view_url: 'u2' }];

const fbBox = () => screen.getByRole('checkbox', { name: /facebook/i });
const igBox = () => screen.getByRole('checkbox', { name: /instagram/i });
const postBtn = () => screen.getByRole('button', { name: /^(post to|retry|try again)/i });
const callsTo = (path) => fetchSpy.mock.calls.filter(([p]) => p === path);
const bodyOf = (path, i = 0) => JSON.parse(callsTo(path)[i][1].body);
const rejectWith = (props) => Object.assign(new Error(props.message ?? 'x'), props);

beforeEach(() => {
  fetchSpy.mockReset();
  // Idempotency slots are persisted by design, so they outlive a render. Clear or one case's slot
  // answers the next case's assertion.
  try { globalThis.localStorage?.clear(); } catch { /* jsdom always has it */ }
});

describe('destination picker', () => {
  it('offers both destinations, with Instagram OFF', () => {
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    expect(fbBox().checked).toBe(true);
    expect(igBox().checked).toBe(false);
    expect(postBtn().textContent).toMatch(/post to facebook/i);
  });

  it('posts to Facebook alone by default', async () => {
    fetchSpy.mockResolvedValue({ post_id: 'p1' });
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    await act(async () => { fireEvent.click(postBtn()); });
    expect(callsTo('/api/share/facebook')).toHaveLength(1);
    expect(callsTo('/api/share/instagram')).toHaveLength(0);
  });

  it('posts to both once Instagram is ticked, and says so on the button', async () => {
    fetchSpy.mockResolvedValue({ post_id: 'p1' });
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    expect(postBtn().textContent).toMatch(/facebook and instagram/i);

    await act(async () => { fireEvent.click(postBtn()); });
    expect(callsTo('/api/share/facebook')).toHaveLength(1);
    expect(callsTo('/api/share/instagram')).toHaveLength(1);
    await waitFor(() => expect(screen.getByText(/Posted to Facebook and Instagram/i)).toBeTruthy());
  });

  it('can post to Instagram alone', async () => {
    fetchSpy.mockResolvedValue({ media_id: 'm1' });
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    fireEvent.click(fbBox());
    expect(postBtn().textContent).toMatch(/post to instagram/i);
    await act(async () => { fireEvent.click(postBtn()); });
    expect(callsTo('/api/share/facebook')).toHaveLength(0);
    expect(callsTo('/api/share/instagram')).toHaveLength(1);
  });

  it('cannot post with no destination selected', async () => {
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(fbBox());
    expect(screen.getByText(/choose at least one place/i)).toBeTruthy();
    expect(postBtn().disabled).toBe(true);
    await act(async () => { fireEvent.click(postBtn()); });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the Instagram choice does NOT persist across opens', () => {
    // A destination that cannot be undone must be chosen deliberately every time, not inherited.
    const { rerender } = render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    expect(igBox().checked).toBe(true);
    rerender(<FacebookShareSheet open={false} photos={photos} onClose={() => {}} />);
    rerender(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    expect(igBox().checked).toBe(false);
  });

  it('sends each destination its OWN client_request_id', async () => {
    fetchSpy.mockResolvedValue({ post_id: 'p1' });
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    await act(async () => { fireEvent.click(postBtn()); });
    const fbId = bodyOf('/api/share/facebook').client_request_id;
    const igId = bodyOf('/api/share/instagram').client_request_id;
    expect(fbId).toEqual(expect.any(String));
    expect(igId).not.toBe(fbId);
  });
});

describe('caption limit follows the strictest selected destination', () => {
  it('tightens from 5000 to 2200 when Instagram is added', () => {
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    const box = screen.getByLabelText(/caption/i);
    expect(box.maxLength).toBe(5000);
    fireEvent.click(igBox());
    expect(box.maxLength).toBe(2200);
  });

  it('warns rather than posting when a Facebook-legal caption is too long for Instagram', async () => {
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    // Typed while Facebook-only, so the 5000 maxLength admits it; THEN Instagram is added.
    fireEvent.change(screen.getByLabelText(/caption/i), { target: { value: 'x'.repeat(3000) } });
    fireEvent.click(igBox());
    expect(screen.getByText(/2200 characters/i)).toBeTruthy();
    expect(postBtn().disabled).toBe(true);
    await act(async () => { fireEvent.click(postBtn()); });
    // Nothing went out — in particular Facebook did not go out first and strand the user.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('partial failure', () => {
  const fbOkIgFails = () => {
    fetchSpy
      .mockResolvedValueOnce({ post_id: 'p1', permalink: 'https://facebook.com/p1' })
      .mockRejectedValueOnce(rejectWith({ status: 502, body: { error: 'facebook_error', message: 'Instagram is unhappy' } }));
  };

  it('does NOT report success when only Facebook lands', async () => {
    fbOkIgFails();
    const onPosted = vi.fn();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onPosted={onPosted} />);
    fireEvent.click(igBox());
    await act(async () => { fireEvent.click(postBtn()); });

    expect(screen.queryByText(/Posted to Facebook and Instagram/i)).toBeNull();
    // The composer stays up — there is still something to retry, and a half-published caption must
    // not be silently discarded by swapping in a terminal panel.
    expect(screen.getByLabelText(/caption/i)).toBeTruthy();
    // And the page is NOT told the post went out.
    expect(onPosted).not.toHaveBeenCalled();
  });

  it('names which destination landed and which did not', async () => {
    fbOkIgFails();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    await act(async () => { fireEvent.click(postBtn()); });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Posted to Facebook/i);
    expect(alert.textContent).toMatch(/Instagram/);
    expect(alert.textContent).toMatch(/Instagram is unhappy/);
  });

  it('retry re-attempts ONLY the destination that failed', async () => {
    fbOkIgFails();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    await act(async () => { fireEvent.click(postBtn()); });

    expect(postBtn().textContent).toMatch(/retry instagram/i);
    fetchSpy.mockResolvedValueOnce({ media_id: 'm1' });
    await act(async () => { fireEvent.click(postBtn()); });

    // The live Facebook post was never re-sent. This is the assertion the whole design serves.
    expect(callsTo('/api/share/facebook')).toHaveLength(1);
    expect(callsTo('/api/share/instagram')).toHaveLength(2);
    await waitFor(() => expect(screen.getByText(/Posted to Facebook and Instagram/i)).toBeTruthy());
  });

  it('a landed destination cannot be un-ticked and re-sent', async () => {
    fbOkIgFails();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    await act(async () => { fireEvent.click(postBtn()); });

    // Its slot was released on success, so a re-send would mint a fresh id and genuinely duplicate.
    expect(fbBox().disabled).toBe(true);
    fireEvent.click(fbBox());
    expect(fbBox().checked).toBe(true);
  });

  it('both failing is not a partial — nothing is claimed as posted', async () => {
    fetchSpy.mockRejectedValue(rejectWith({ status: 500, body: { error: 'internal_error', message: 'nope' } }));
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    await act(async () => { fireEvent.click(postBtn()); });
    expect(screen.queryByText(/^Posted to/i)).toBeNull();
    expect(postBtn().textContent).toMatch(/retry facebook and instagram/i);
  });
});

describe('blocked replaces the composer only when there is nothing left to compose for', () => {
  it('a 403 on the only selected destination replaces it', async () => {
    fetchSpy.mockRejectedValueOnce(rejectWith({ status: 403, body: { error: 'Admin only' } }));
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    await act(async () => { fireEvent.click(postBtn()); });
    await waitFor(() => expect(screen.getByText(/only the page admin/i)).toBeTruthy());
    expect(screen.queryByLabelText(/caption/i)).toBeNull();
  });

  it('one blocked destination alongside a success KEEPS the composer', async () => {
    fetchSpy
      .mockResolvedValueOnce({ post_id: 'p1' })
      .mockRejectedValueOnce(rejectWith({ status: 503, body: { error: 'instagram_sharing_disabled' } }));
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    await act(async () => { fireEvent.click(postBtn()); });

    // Replacing the composer here would discard a caption that is already half-published, and would
    // report a blocked state for a post that partly went out.
    expect(screen.getByLabelText(/caption/i)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Posted to Facebook/i);
  });

  it('a blocked destination alongside a RETRYABLE failure keeps the composer', async () => {
    // The case that isolates the `every` in the blocked predicate. The sibling test above has
    // Facebook LANDING, so its `landed.length === 0` term already forces blocked=false and the
    // `every` could be weakened to `some` without failing it (measured: that mutant survived).
    // Here nothing lands, so `landed.length === 0` is satisfied and only `every` decides.
    //
    // Facebook failed with a transient 500 and Instagram is forbidden. Collapsing that to <Blocked>
    // would replace the composer — killing a retry that would probably work — and would explain the
    // whole thing with Instagram's reason, which is not why Facebook failed.
    fetchSpy
      .mockRejectedValueOnce(rejectWith({ status: 500, body: { error: 'internal_error', message: 'temporary glitch' } }))
      .mockRejectedValueOnce(rejectWith({ status: 403, body: { error: 'Admin only' } }));
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    await act(async () => { fireEvent.click(postBtn()); });

    expect(screen.getByLabelText(/caption/i)).toBeTruthy();
    expect(screen.queryByText(/only the page admin/i)).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/temporary glitch/);
  });

  it('an Instagram-only run that is not configured explains itself', async () => {
    fetchSpy.mockRejectedValueOnce(rejectWith({ status: 500, body: { error: 'ig_not_configured' } }));
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(igBox());
    fireEvent.click(fbBox());
    await act(async () => { fireEvent.click(postBtn()); });
    await waitFor(() => expect(screen.getByText(/Instagram is not connected/i)).toBeTruthy());
  });
});
