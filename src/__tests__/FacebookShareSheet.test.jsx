// Component tests for src/components/FacebookShareSheet.jsx
// Strategy: mock useApiFetch (the real useShareToFacebook hook runs). Verify compose UI, hashtag
// helper, success (View on Facebook + onPosted), and the admin-only (403) blocked state.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }));
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }));

import FacebookShareSheet from '../components/FacebookShareSheet.jsx';

const photos = [{ id: 'a', view_url: 'u1', caption: 'c1' }, { id: 'b', view_url: 'u2' }];
beforeEach(() => fetchSpy.mockReset());

describe('FacebookShareSheet', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<FacebookShareSheet open={false} photos={photos} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the compose UI (caption + post button) when open', () => {
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    expect(screen.getByLabelText(/caption/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /post to facebook/i })).toBeTruthy();
  });

  it('appends the hashtag to the caption', () => {
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /#GardensAtMathews/i }));
    expect(screen.getByLabelText(/caption/i).value).toContain('#GardensAtMathews');
  });

  it('posts and shows success + a working View on Facebook link, and calls onPosted', async () => {
    fetchSpy.mockResolvedValue({ post_id: 'p1', permalink: 'https://facebook.com/p1' });
    const onPosted = vi.fn();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onPosted={onPosted} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook/i })); });
    await waitFor(() => expect(screen.getByText(/Posted to Facebook/i)).toBeTruthy());
    expect(onPosted).toHaveBeenCalledWith(expect.objectContaining({ post_id: 'p1' }));
    expect(screen.getByRole('link', { name: /view on facebook/i }).getAttribute('href')).toBe('https://facebook.com/p1');
    // the request carried the selected photo ids
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).photo_ids).toEqual(['a', 'b']);
  });

  it('shows the admin-only message on a 403', async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('Admin only'), { status: 403, body: { error: 'Admin only' } }));
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook/i })); });
    await waitFor(() => expect(screen.getByText(/only the page admin/i)).toBeTruthy());
  });
});

// ── V4-FBCAPTIONDIRTY-001 — onDirtyChange ────────────────────────────────────────────────────────
//
// The caption is up to 5000 chars living ONLY in this component's state, so a reload mid-composition
// destroys it and the hosting page cannot hold the reload gate over something it cannot see. These
// tests assert the reported boolean in BOTH directions — typed → true, back to the seed → false,
// never touched → false — because a guard that only fires is as broken as one that never does: an
// over-broad predicate nags on every visit.
//
// The gate wiring itself (PhotoLibrary → the real reloadGate) is proven in PhotoLibrary.test.jsx.
describe('FacebookShareSheet — onDirtyChange (V4-FBCAPTIONDIRTY-001)', () => {
  const typeCaption = (value) => fireEvent.change(screen.getByLabelText(/caption/i), { target: { value } });

  it('reports clean for a merely-opened sheet and never flips true', () => {
    const onDirtyChange = vi.fn();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    expect(screen.getByLabelText(/caption/i).value).toBe('');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it('reports dirty once the caption is typed into', () => {
    const onDirtyChange = vi.fn();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    typeCaption('First tomato of the year');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  // ★ The must-release direction. This composer has no seed, so its seed IS the empty string —
  // clearing the text puts the user back exactly where they started, with nothing left to lose.
  it('releases when a typed caption is cleared back to the empty seed', () => {
    const onDirtyChange = vi.fn();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    typeCaption('First tomato of the year');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    typeCaption('');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('does not report dirty for a whitespace-only caption', () => {
    const onDirtyChange = vi.fn();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    typeCaption('   \n  ');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  // The + #GardensAtMathews button writes into the authored field, and unlike PhotoLibrary's
  // pickers there is no separate control still holding the value — so it counts. Pinned so the
  // inclusion stays deliberate rather than incidental.
  it('reports dirty for a caption composed only of the hashtag button', () => {
    const onDirtyChange = vi.fn();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    fireEvent.click(screen.getByRole('button', { name: /#GardensAtMathews/i }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  // ★ The `open` term, and the reason it is right HERE while PhotoLibrary's staged file is
  // deliberately NOT gated on its form being visible: closing this sheet makes the draft
  // unreachable, so holding a deploy for it would wedge updates over text nobody can get back to.
  // Both halves asserted — the release, AND that the text really is gone.
  it('releases on close, and the draft is genuinely gone on re-open', () => {
    const onDirtyChange = vi.fn();
    const { rerender } = render(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    typeCaption('half-written thought');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    rerender(<FacebookShareSheet open={false} photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    rerender(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    expect(screen.getByLabelText(/caption/i).value).toBe('');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps holding across the in-flight post, then releases on success', async () => {
    const onDirtyChange = vi.fn();
    let settle;
    fetchSpy.mockImplementationOnce(() => new Promise((res) => { settle = res; }));
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    typeCaption('Posting this one');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook/i })); });
    expect(screen.getByRole('button', { name: /Posting/i })).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await act(async () => { settle({ post_id: 'p1' }); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByText(/Posted to Facebook/i)).toBeTruthy());
    // Nothing clears `caption` on success — without the !done term the Success screen would hold a
    // deploy until someone tapped Done.
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  // A blocked state REPLACES the composer and only offers Close, so the caption is unreachable
  // whether or not the page reloads — the same wedge as a closed sheet.
  it('releases when a 403 replaces the composer with the blocked screen', async () => {
    const onDirtyChange = vi.fn();
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('Admin only'), { status: 403, body: { error: 'Admin only' } }));
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    typeCaption('Never going to be posted');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook/i })); });
    await waitFor(() => expect(screen.getByText(/only the page admin/i)).toBeTruthy());
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  // A retryable failure keeps the composer AND the text on screen, so it stays dirty.
  it('keeps holding after a retryable post failure', async () => {
    const onDirtyChange = vi.fn();
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('network'), { body: {} }));
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    typeCaption('Worth retrying');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook/i })); });
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    expect(screen.getByLabelText(/caption/i).value).toBe('Worth retrying');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('releases on unmount so a conditional caller cannot strand a hold', () => {
    const onDirtyChange = vi.fn();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onDirtyChange={onDirtyChange} />);
    typeCaption('unmounting with this held');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    cleanup();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  // The prop is optional and additive: every other test in this file already omits it, and this one
  // drives the whole compose→post path with it absent to prove the effect never assumes a callback.
  it('works unchanged for a caller that omits the prop', async () => {
    fetchSpy.mockResolvedValue({ post_id: 'p1', permalink: 'https://facebook.com/p1' });
    const onPosted = vi.fn();
    render(<FacebookShareSheet open photos={photos} onClose={() => {}} onPosted={onPosted} />);
    typeCaption('no callback wired');
    expect(screen.getByLabelText(/caption/i).value).toBe('no callback wired');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /post to facebook/i })); });
    await waitFor(() => expect(screen.getByText(/Posted to Facebook/i)).toBeTruthy());
    expect(onPosted).toHaveBeenCalledWith(expect.objectContaining({ post_id: 'p1' }));
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).caption).toBe('no callback wired');
  });
});
