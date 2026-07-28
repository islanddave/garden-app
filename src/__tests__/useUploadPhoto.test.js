// Unit tests for src/hooks/useUploadPhoto.js
// Strategy: mock useApiFetch + window.fetch (thumb PUT) + XMLHttpRequest (original PUT).
// Verify the 3-step dance (presign -> S3 PUT -> POST /api/photos) plus error/lifecycle paths.
// BUG-PHOTOUPLOADHANG-001: the ORIGINAL PUT goes through putWithProgress (XHR + stall watchdog)
// — the bare-fetch, no-bound contract this file used to pin is exactly the traced hang site.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { fetchSpy, thumbState } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  // Controls what downscaleWithThumb hands back. Default { thumb: null } reproduces the real jsdom
  // result (no createImageBitmap -> no thumb). hang:true = a decode that never settles.
  thumbState: { thumb: null, hang: false },
}));

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: vi.fn(),
}));

vi.mock('../lib/imageDownscale.js', () => ({
  downscaleWithThumb: vi.fn((f) => thumbState.hang
    ? new Promise(() => {})
    : Promise.resolve({ file: f, thumb: thumbState.thumb })),
  downscaleImage: vi.fn(async (f) => f),
}));

import { useUploadPhoto } from '../hooks/useUploadPhoto.js';

// Original-PUT transport: controllable XHR double. behavior 'success' auto-200s on send,
// 'status403' auto-fails, 'manual' waits for the test to drive events.
class FakeXHR {
  static instances = [];
  static behavior = 'success';
  constructor() {
    FakeXHR.instances.push(this);
    this.status = 0;
    this.aborted = false;
    this.headers = {};
    this._l = {};
    this._ul = {};
    this.upload = { addEventListener: (ev, fn) => { (this._ul[ev] ||= []).push(fn); } };
  }
  addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  abort() { this.aborted = true; (this._l.abort || []).forEach(f => f({})); }
  send(body) {
    this.body = body;
    if (FakeXHR.behavior === 'success') queueMicrotask(() => this.fireLoad(200));
    else if (FakeXHR.behavior === 'status403') queueMicrotask(() => this.fireLoad(403));
    else if (FakeXHR.behavior === 'error') queueMicrotask(() => this.fireError());
    // 'manual': the test drives fireProgress/fireLoad itself
  }
  fireError() { (this._l.error || []).forEach(f => f({})); }
  fireProgress(loaded, total) { (this._ul.progress || []).forEach(f => f({ lengthComputable: true, loaded, total })); }
  fireLoad(status) { this.status = status; (this._l.load || []).forEach(f => f({})); }
}

// Stub URL.createObjectURL / revokeObjectURL — jsdom doesn't provide these.
const createObjectURL  = vi.fn(() => 'blob:mock-url');
const revokeObjectURL  = vi.fn();
beforeEach(() => {
  thumbState.thumb = null;
  thumbState.hang = false;
  fetchSpy.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  globalThis.URL.createObjectURL = createObjectURL;
  globalThis.URL.revokeObjectURL = revokeObjectURL;
  FakeXHR.instances = [];
  FakeXHR.behavior = 'success';
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Thumb PUT still rides window.fetch; give it a quiet default.
function mockThumbPutOk() {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
}

function fakeFile(name = 'photo.jpg', type = 'image/jpeg') {
  return new File(['fake'], name, { type });
}

describe('useUploadPhoto — happy path', () => {
  it('runs presign -> S3 PUT (watchdog XHR) -> POST and returns photo', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/upload', key: 'standalone/u.jpg' });
    fetchSpy.mockResolvedValueOnce({ id: 'photo-1', storage_path: 'standalone/u.jpg' });
    mockThumbPutOk();

    const { result } = renderHook(() => useUploadPhoto());
    expect(result.current.isUploading).toBe(false);
    expect(result.current.stage).toBeNull();

    const file = fakeFile();
    let res;
    await act(async () => {
      res = await result.current.upload(file, { keyPrefix: 'standalone' });
    });

    expect(res.photo).toEqual({ id: 'photo-1', storage_path: 'standalone/u.jpg' });
    expect(result.current.isUploading).toBe(false);
    expect(result.current.stage).toBeNull();
    expect(result.current.photo).toEqual(res.photo);
    expect(result.current.error).toBeNull();
    expect(result.current.preview).toBe('blob:mock-url');

    // presign + POST via apiFetch; the ORIGINAL PUT via the watchdog XHR, not fetch
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(FakeXHR.instances.length).toBe(1);
    expect(FakeXHR.instances[0].method).toBe('PUT');
    expect(FakeXHR.instances[0].url).toBe('https://s3.example/upload');
    expect(FakeXHR.instances[0].body).toBe(file);
    expect(FakeXHR.instances[0].headers['Content-Type']).toBe('image/jpeg');
    // no thumb -> window.fetch untouched
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('forwards linkage to POST /api/photos body', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/upload' });
    fetchSpy.mockResolvedValueOnce({ id: 'p2' });
    mockThumbPutOk();

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
    expect(result.current.stage).toBeNull();
    expect(result.current.photo).toBeNull();
  });

  it('surface mode: S3 PUT non-OK propagates', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    FakeXHR.behavior = 'status403';
    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(fakeFile()); });
    expect(res.error).toMatch(/403/);
    expect(result.current.error).toMatch(/403/);
    expect(result.current.stage).toBeNull();
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
    expect(FakeXHR.instances.length).toBe(0);
  });

  it('missing upload_url in presign response throws', async () => {
    fetchSpy.mockResolvedValueOnce({});
    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(fakeFile()); });
    expect(res.error).toMatch(/upload_url/);
  });
});

// BUG-PHOTOUPLOADHANG-001 — the two hang guards + step instrumentation.
describe('useUploadPhoto — hang guards & stages', () => {
  it('a downscale that never settles is abandoned at the deadline and the ORIGINAL uploads', async () => {
    vi.useFakeTimers();
    thumbState.hang = true;
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockThumbPutOk();

    const file = fakeFile();
    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => {
      const p = result.current.upload(file);
      await vi.advanceTimersByTimeAsync(15_100);
      res = await p;
    });
    vi.useRealTimers();

    expect(res.photo).toEqual({ id: 'p1' });
    // the file that went up is the ORIGINAL, untouched
    expect(FakeXHR.instances[0].body).toBe(file);
    // and no thumb leg ran
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('thumb-upload-url'))).toBe(false);
  });

  it('a STALLED original PUT surfaces an error instead of hanging forever', async () => {
    vi.useFakeTimers();
    FakeXHR.behavior = 'manual';
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    const { result } = renderHook(() => useUploadPhoto());

    let res;
    await act(async () => {
      const p = result.current.upload(fakeFile());
      await vi.advanceTimersByTimeAsync(31_000); // > PUT_STALL_MS with zero progress
      res = await p;
    });
    vi.useRealTimers();

    expect(res.error).toMatch(/stalled/i);
    expect(result.current.error).toMatch(/stalled/i);
    expect(result.current.isUploading).toBe(false);
    expect(result.current.stage).toBeNull();
    expect(FakeXHR.instances[0].aborted).toBe(true);
  });

  it('exposes stage transitions and PUT progress percentages', async () => {
    FakeXHR.behavior = 'manual';
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    const { result } = renderHook(() => useUploadPhoto());

    let done;
    await act(async () => {
      done = result.current.upload(fakeFile());
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    await waitFor(() => expect(result.current.stage).toBe('uploading'));

    await act(async () => { FakeXHR.instances[0].fireProgress(43, 100); });
    expect(result.current.progress).toBe(43);

    await act(async () => { FakeXHR.instances[0].fireLoad(200); await done; });
    expect(result.current.stage).toBeNull();
    expect(result.current.progress).toBeNull();
    expect(result.current.photo).toEqual({ id: 'p1' });
  });
});

describe('useUploadPhoto — preview lifecycle', () => {
  it('creates object URL on upload start and revokes prior on re-upload', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockThumbPutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u2' });
    fetchSpy.mockResolvedValueOnce({ id: 'p2' });
    await act(async () => { await result.current.upload(fakeFile('p2.jpg')); });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('reset clears preview + photo + error + stage and revokes URL', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockThumbPutOk();
    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });
    expect(result.current.photo).not.toBeNull();

    act(() => { result.current.reset(); });
    expect(result.current.photo).toBeNull();
    expect(result.current.preview).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.stage).toBeNull();
    expect(result.current.progress).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it('revokes URL on unmount', async () => {
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/u' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockThumbPutOk();
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
    mockThumbPutOk();

    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(fakeFile(), { keyPrefix: 'standalone' }); });

    const thumbCall = fetchSpy.mock.calls.find(c => String(c[0]).includes('/api/photos/thumb-upload-url'));
    expect(thumbCall).toBeTruthy();
    // sends ONLY the original key — the thumbs/ prefix is the server's job
    expect(String(thumbCall[0])).not.toContain('thumbs');

    // original via watchdog XHR; thumb via bounded fetch
    expect(FakeXHR.instances.length).toBe(1);
    expect(FakeXHR.instances[0].url).toBe('https://s3.example/orig');
    const puts = globalThis.fetch.mock.calls.filter(c => c[1]?.method === 'PUT');
    expect(puts.length).toBe(1);
    expect(puts[0][0]).toBe('https://s3.example/thumb');
    expect(puts[0][1].body).toBe(THUMB);
    expect(puts[0][1].headers['Content-Type']).toBe('image/jpeg');
    expect(res.photo).toEqual({ id: 'p1', storage_path: 'standalone/u.jpg' });
  });

  it('skips step 2b entirely when no thumb could be produced', async () => {
    thumbState.thumb = null;
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockThumbPutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });

    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('thumb-upload-url'))).toBe(false);
    expect(globalThis.fetch.mock.calls.filter(c => c[1]?.method === 'PUT').length).toBe(0);
  });

  it('a FAILED thumb never costs the photo — the row is still registered and no error surfaces', async () => {
    thumbState.thumb = THUMB;
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockRejectedValueOnce(new Error('thumb presign exploded'));            // 2b blows up
    fetchSpy.mockResolvedValueOnce({ id: 'p1', storage_path: 'standalone/u.jpg' });  // 3 still runs
    mockThumbPutOk();

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
    mockThumbPutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });

    const puts = globalThis.fetch.mock.calls.filter(c => c[1]?.method === 'PUT');
    const thumbPut = puts.find(c => c[0] === 'https://s3.example/thumb');
    // the thumb is bounded by an abort signal...
    expect(thumbPut[1].signal).toBeDefined();
    expect(thumbPut[1].signal.aborted).toBe(false);
    // ...and the ORIGINAL is bounded by the stall watchdog (XHR transport, not bare fetch)
    expect(FakeXHR.instances.length).toBe(1);
    expect(FakeXHR.instances[0].url).toBe('https://s3.example/orig');
  });

  it('an ABORTED/hanging thumb PUT still leaves the photo registered', async () => {
    thumbState.thumb = THUMB;
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/thumb' });
    fetchSpy.mockResolvedValueOnce({ id: 'p1', storage_path: 'standalone/u.jpg' });
    // thumb PUT rejects the way an abort does (original PUT rides FakeXHR success)
    globalThis.fetch = vi.fn()
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
    mockThumbPutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });

    expect(globalThis.fetch.mock.calls.filter(c => c[1]?.method === 'PUT').length).toBe(0);
    expect(result.current.photo).toEqual({ id: 'p1' });
  });
});

// BUG-PHOTOUPLOADRELAY-001 — when the direct S3 PUT dies, the bytes relay through the API.
describe('useUploadPhoto — relay fallback', () => {
  const THUMB = new Blob([new Uint8Array(1000)], { type: 'image/jpeg' });

  it('a failed direct PUT relays through /api/photos/relay-upload and still registers the photo', async () => {
    FakeXHR.behavior = 'error';
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });          // 1 presign
    fetchSpy.mockResolvedValueOnce({ ok: true, key: 'k', thumb: false });               // relay
    fetchSpy.mockResolvedValueOnce({ id: 'p1', storage_path: 'standalone/u.jpg' });     // 3 POST
    mockThumbPutOk();

    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(fakeFile()); });

    const relayCall = fetchSpy.mock.calls.find(c => c[0] === '/api/photos/relay-upload');
    expect(relayCall).toBeTruthy();
    expect(relayCall[1].method).toBe('POST');
    expect(relayCall[1].timeoutMs).toBe(60000);
    const body = JSON.parse(relayCall[1].body);
    expect(body.key).toMatch(/^standalone\//);
    expect(body.content_type).toBe('image/jpeg');
    expect(typeof body.data_b64).toBe('string');
    expect(body.data_b64.length).toBeGreaterThan(0);
    expect(res.photo).toEqual({ id: 'p1', storage_path: 'standalone/u.jpg' });
    expect(result.current.error).toBeNull();
  });

  it('relay carries the thumb and a thumb:true response SKIPS step 2b', async () => {
    thumbState.thumb = THUMB;
    FakeXHR.behavior = 'error';
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockResolvedValueOnce({ ok: true, key: 'k', thumb: true });
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });
    mockThumbPutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });

    const relayCall = fetchSpy.mock.calls.find(c => c[0] === '/api/photos/relay-upload');
    expect(JSON.parse(relayCall[1].body).thumb_b64).toBeTruthy();
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('thumb-upload-url'))).toBe(false);
  });

  it('a thumb:false relay response still runs step 2b (thumb via presign)', async () => {
    thumbState.thumb = THUMB;
    FakeXHR.behavior = 'error';
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockResolvedValueOnce({ ok: true, key: 'k', thumb: false });               // relay: no thumb stored
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/thumb' });         // 2b presign
    fetchSpy.mockResolvedValueOnce({ id: 'p1' });                                       // 3 POST
    mockThumbPutOk();

    const { result } = renderHook(() => useUploadPhoto());
    await act(async () => { await result.current.upload(fakeFile()); });
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('thumb-upload-url'))).toBe(true);
  });

  it('a failed relay surfaces the ORIGINAL direct-PUT error', async () => {
    FakeXHR.behavior = 'error';
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockRejectedValueOnce(new Error('relay down'));
    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(fakeFile()); });
    expect(res.error).toMatch(/network error/);
    expect(result.current.error).toMatch(/network error/);
  });

  it('an over-cap file skips the relay entirely and surfaces the direct-PUT error', async () => {
    FakeXHR.behavior = 'error';
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    const big = new File([new Uint8Array(4_000_000)], 'huge.jpg', { type: 'image/jpeg' });
    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => { res = await result.current.upload(big); });
    expect(res.error).toMatch(/network error/);
    expect(fetchSpy.mock.calls.some(c => c[0] === '/api/photos/relay-upload')).toBe(false);
  });
});
