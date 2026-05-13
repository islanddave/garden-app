// Unit tests for src/hooks/useUploadPhoto.js
// Strategy: mock useApiFetch + window.fetch. Verify the 3-step dance
// (presign -> S3 PUT -> POST /api/photos) plus error/lifecycle paths.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }));

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: vi.fn(),
}));

import { useUploadPhoto } from '../hooks/useUploadPhoto.js';

// Stub URL.createObjectURL / revokeObjectURL — jsdom doesn't provide these.
const createObjectURL  = vi.fn(() => 'blob:mock-url');
const revokeObjectURL  = vi.fn();
beforeEach(() => {
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
