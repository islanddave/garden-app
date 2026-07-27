// Unit tests for src/hooks/useUploadPhoto.js
// Strategy: mock useApiFetch + window.fetch. Verify the 3-step dance
// (presign -> S3 PUT -> POST /api/photos) plus error/lifecycle paths.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { fetchSpy, thumbState } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  // Controls what downscaleWithThumb hands back. Default { thumb: null } reproduces the real jsdom
  // result (no createImageBitmap -> no thumb), so every pre-existing test is unaffected.
  thumbState: { thumb: null },
}));

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: vi.fn(),
}));

vi.mock('../lib/imageDownscale.js', () => ({
  downscaleWithThumb: vi.fn(async (f) => ({ file: f, thumb: thumbState.thumb })),
  downscaleImage: vi.fn(async (f) => f),
}));

import { useUploadPhoto } from '../hooks/useUploadPhoto.js';

// Stub URL.createObjectURL / revokeObjectURL — jsdom doesn't provide these.
const createObjectURL  = vi.fn(() => 'blob:mock-url');
const revokeObjectURL  = vi.fn();
beforeEach(() => {
  thumbState.thumb = null;
  fetchSpy.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  globalThis.URL.createObjectURL = createObjectURL;
  globalThis.URL.revokeObjectURL = revokeObjectURL;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function mockS3PutOk() {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
}
function mockS3PutFail() {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
}

function fakeFile(name = 'photo.jpg', type = 'image/jpeg') {
  return new File(['fake'], name, { type });
}

describe('useUploadPhoto — happy path', () => {
  it('runs presign -> S3 PUT -> POST and returns photo', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/upload', key: 'standalone/u.jpg' });
    fetchSpy.mockResolvedValueOnce({ id: 'photo-1', storage_path: 'standalone/u.jpg' });
    mockS3PutOk();

    const { result } = renderHook(() => useUploadPhoto());
    expect(result.current.isUploading).toBe(false);

    let res;
    await act(async () => {
      res = await result.current.upload(fakeFile(), { keyPrefix: 'standalone' });
    });

    expect(res.photo).toEqual({ id: 'photo-1', storage_path: 'standalone/u.jpg' });
    expect(result.current.isUploading).toBe(false);
    expect(result.current.photo).toEqual(res.photo);
    expect(result.current.error).toBeNull();
    expect(result.current.preview).toBe('blob:mock-url');

    // Three logical fetches: presign + S3 PUT + POST register
    expect(fetchSpy).toHaveBeenCalledTimes(2); // useApiFetch.fetch (presign + POST)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // window.fetch (S3 PUT)
  });

  it('forwards linkage to POST /api/photos body', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/upload' });
    fetchSpy.mockResolvedValueOnce({ id: 'p2' });
    mockS3PutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => {
      await result.current.upload(fakeFile(), {
        keyPrefix: 'plants',
        parentId: 'plant-1',
        linkage: { plant_id: 'plant-1', project_id: 'proj-1' },
        caption: 'hi',
      });
    });

    const postCall = fetchSpy.mock.calls[1];
    expect(postCall[0]).toBe('/api/photos');
    expect(postCall[1].method).toBe('POST');
    const body = JSON.parse(postCall[1].body);
    expect(body.plant_id).toBe('plant-1');
    expect(body.project_id).toBe('proj-1');
    expect(body.caption).toBe('hi');
    expect(body.storage_path).toMatch(/^plants\/plant-1\//);
  });
});

describe('useUploadPhoto — errors', () => {
  it('surface mode: presign failure returns error in result and state', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('presign down'));
    const { result } = renderHook(() => useUploadPhoto({ errorMode: 'surface' }));

    let res;
    await act(async () => { res = await result.current.upload(fakeFile()); });
    expect(res.error).toBe('presign down');
    expect(result.current.error).toBe('presign down');
    expect(result.current.isUploading).toBe(false);
    expect(result.current.photo).toBeNull();
  });

  it('surface mode: S3 PUT non-OK propagates', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    mockS3PutFail();
    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(fakeFile()); });
    expect(res.error).toMatch(/403/);
    expect(result.current.error).toMatch(/403/);
  });

  it('swallow mode: errors do not set state.error but result has error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useUploadPhoto({ errorMode: 'swallow' }));
    let res;
    await act(async () => { res = await result.current.upload(fakeFile()); });
    expect(res.error).toBe('boom');
    expect(result.current.error).toBeNull();
  });

  it('missing file returns error without making network calls', async () => {
    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(null); });
    expect(res.error).toMatch(/file is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('missing upload_url in presign response throws', async () => {
    fetchSpy.mockResolvedValueOnce({});
    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(fakeFile()); });
    expect(res.error).toMatch(/upload_url/);
  });
});

describe('useUploadPhoto — preview lifecycle', () => {
  it('creates object URL on upload start and revokes prior on re-upload', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockS3PutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u2' });
    fetchSpy.mockResolvedValueOnce({ id: 'p2' });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    await act(async () => { await result.current.upload(fakeFile('p2.jpg')); });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('reset clears preview + photo + error and revokes URL', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockS3PutOk();
    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });
    expect(result.current.photo).not.toBeNull();

    act(() => { result.current.reset(); });
    expect(result.current.photo).toBeNull();
    expect(result.current.preview).toBeNull();
    expect(result.current.error).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it('revokes URL on unmount', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockS3PutOk();
    const { result, unmount } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });
    revokeObjectURL.mockClear();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});

// Step 2b — thumbs for NEW uploads. Before this, only the 913 backfilled photos had thumbs and
// every new upload fell back to its full-size original.
describe('useUploadPhoto — thumbnail upload (step 2b)', () => {
  const THUMB = new Blob([new Uint8Array(1000)], { type: 'image/jpeg' });

  it('presigns the thumb via the key-only route and PUTs it as image/jpeg', async () => {
    thumbState.thumb = THUMB;
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });      // 1 presign
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/thumb' });     // 2b presign
    fetchSpy.mockResolvedValueOnce({ id: 'p1', storage_path: 'standalone/u.jpg' }); // 3 POST
    mockS3PutOk();

    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(fakeFile(), { keyPrefix: 'standalone' }); });

    const thumbCall = fetchSpy.mock.calls.find(c => String(c[0]).includes('/api/photos/thumb-upload-url'));
    expect(thumbCall).toBeTruthy();
    // sends ONLY the original key — the thumbs/ prefix is the server's job
    expect(String(thumbCall[0])).not.toContain('thumbs');

    const puts = globalThis.fetch.mock.calls.filter(c => c[1]?.method === 'PUT');
    expect(puts.length).toBe(2); // original + thumb
    const thumbPut = puts.find(c => c[0] === 'https://s3.example/thumb');
    expect(thumbPut[1].body).toBe(THUMB);
    expect(thumbPut[1].headers['Content-Type']).toBe('image/jpeg');
    expect(res.photo).toEqual({ id: 'p1', storage_path: 'standalone/u.jpg' });
  });

  it('skips step 2b entirely when no thumb could be produced', async () => {
    thumbState.thumb = null;
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockS3PutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });

    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('thumb-upload-url'))).toBe(false);
    expect(globalThis.fetch.mock.calls.filter(c => c[1]?.method === 'PUT').length).toBe(1);
  });

  it('a FAILED thumb never costs the photo — the row is still registered and no error surfaces', async () => {
    thumbState.thumb = THUMB;
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockRejectedValueOnce(new Error('thumb presign exploded'));            // 2b blows up
    fetchSpy.mockResolvedValueOnce({ id: 'p1', storage_path: 'standalone/u.jpg' });  // 3 still runs
    mockS3PutOk();

    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(fakeFile()); });

    expect(res.photo).toEqual({ id: 'p1', storage_path: 'standalone/u.jpg' });
    expect(res.error).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('BOUNDS the thumb PUT with an abort signal so it can never hang the save', async () => {
    thumbState.thumb = THUMB;
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/thumb' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockS3PutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });

    const puts = globalThis.fetch.mock.calls.filter(c => c[1]?.method === 'PUT');
    const origPut = puts.find(c => c[0] === 'https://s3.example/orig');
    const thumbPut = puts.find(c => c[0] === 'https://s3.example/thumb');
    // the thumb is bounded...
    expect(thumbPut[1].signal).toBeDefined();
    expect(thumbPut[1].signal.aborted).toBe(false);
    // ...and the ORIGINAL deliberately is NOT (a large upload legitimately takes a while)
    expect(origPut[1].signal).toBeUndefined();
  });

  it('an ABORTED/hanging thumb PUT still leaves the photo registered', async () => {
    thumbState.thumb = THUMB;
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/thumb' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1', storage_path: 'standalone/u.jpg' });
    // original PUT ok; thumb PUT rejects the way an abort does
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' })
      .mockRejectedValueOnce(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));

    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(fakeFile()); });

    expect(res.photo).toEqual({ id: 'p1', storage_path: 'standalone/u.jpg' });
    expect(result.current.error).toBeNull();
  });

  it('a thumb presign returning no upload_url is a no-op, not a crash', async () => {
    thumbState.thumb = THUMB;
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockResolvedValueOnce({});                                             // no upload_url
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockS3PutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });

    expect(globalThis.fetch.mock.calls.filter(c => c[1]?.method === 'PUT').length).toBe(1);
    expect(result.current.photo).toEqual({ id: 'p1' });
  });
});
