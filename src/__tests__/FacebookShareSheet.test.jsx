// Component tests for src/components/FacebookShareSheet.jsx
// Strategy: mock useApiFetch (the real useShareToFacebook hook runs). Verify compose UI, hashtag
// helper, success (View on Facebook + onPosted), and the admin-only (403) blocked state.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

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
