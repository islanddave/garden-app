// V4-PHOTOEXIFSTRIP-001 — no route into S3 carries the camera's GPS.
//
// THE BYPASS CLASSES ARE THE WHOLE POINT, so imageDownscale is NOT MOCKED here. Mocking it to
// "return the original" would prove the strip runs when handed an original, which is the easy half;
// it would prove nothing about whether each bypass actually reaches that state. Instead the
// environment is shaped so the REAL downscaleWithThumb takes each of its four fail-safe returns in
// turn (under MIN_BYTES / undecodable codec / no usable canvas / re-encode grew), plus
// useUploadPhoto's own DOWNSCALE_DEADLINE_MS as the fifth. Every one of them lands the ORIGINAL
// camera file on the PUT, and every one is asserted separately against real bytes.
//
// Assertions are made by exifr reading the bytes the FakeXHR actually received — the body that
// would have gone to S3 — not by spying on the strip function.
//
// The fifth population, the 913 photos backfilled BEFORE any of this existed, cannot be reached
// from here at all: they are already in S3. They are covered by layer 2 in harvestPostPhotos.test.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr/dist/full.esm.mjs';

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }));

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: vi.fn(),
}));

import { useUploadPhoto } from '../hooks/useUploadPhoto.js';
import { MIN_BYTES } from '../lib/imageDownscale.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GPS_BYTES = new Uint8Array(readFileSync(join(HERE, 'fixtures', 'synthetic-gps.jpg')));
const gpsFile = (name = 'garden.jpg') => new File([GPS_BYTES], name, { type: 'image/jpeg' });

// readCaptureMeta hands exifr a Blob slice, and jsdom's Blob has no arrayBuffer. Same guarded patch
// imagePipeline.test.js applies for the same reason — environment gap, not production behaviour.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(this);
    });
  };
}

class FakeXHR {
  static instances = [];
  constructor() {
    FakeXHR.instances.push(this);
    this.status = 0; this._l = {};
    this.upload = { addEventListener: () => {} };
  }
  addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader() {}
  abort() {}
  send(body) { this.body = body; queueMicrotask(() => { this.status = 200; (this._l.load || []).forEach((f) => f({})); }); }
}

// A canvas that encodes to whatever `encodedSize` says, so the "re-encode grew" branch is reachable
// without a real encoder. Its output is a REAL JPEG CARRYING GPS rather than filler bytes: a real
// canvas emits no EXIF, so filler would make the thumbnail assertion below pass no matter what the
// code did. Encoding metadata the encoder would not have written is the only way to prove the thumb
// is genuinely being stripped rather than merely arriving clean.
const canvasState = { ctx: true, encodedSize: 64 };
function makeFakeCanvas() {
  return class FakeOffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return canvasState.ctx ? { drawImage: () => {} } : null; }
    convertToBlob({ type }) {
      const pad = Math.max(0, canvasState.encodedSize - GPS_BYTES.length);
      return Promise.resolve(new Blob([GPS_BYTES, new Uint8Array(pad)], { type }));
    }
  };
}

const bitmapState = { width: 400, height: 300, mode: 'ok' };

beforeEach(() => {
  fetchSpy.mockReset();
  FakeXHR.instances = [];
  canvasState.ctx = true;
  canvasState.encodedSize = 64;
  bitmapState.width = 400; bitmapState.height = 300; bitmapState.mode = 'ok';
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('OffscreenCanvas', makeFakeCanvas());
  vi.stubGlobal('createImageBitmap', vi.fn(() => {
    if (bitmapState.mode === 'throw') return Promise.reject(new Error('unsupported codec'));
    if (bitmapState.mode === 'hang') return new Promise(() => {});
    return Promise.resolve({ width: bitmapState.width, height: bitmapState.height, close: () => {} });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mockUploadOk() {
  fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
  fetchSpy.mockResolvedValueOnce({ id: 'photo-1' });
}

async function upload(file, opts = {}) {
  const { result } = renderHook(() => useUploadPhoto());
  await act(async () => { await result.current.upload(file, opts); });
  return result;
}

const readBytes = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(new Uint8Array(fr.result));
  fr.onerror = () => reject(fr.error);
  fr.readAsArrayBuffer(blob);
});

// The bytes the S3 PUT actually received.
async function putBody() {
  const xhr = FakeXHR.instances.find((x) => x.method === 'PUT');
  expect(xhr, 'no PUT to S3 was made').toBeTruthy();
  return readBytes(xhr.body);
}

const parse = (b) => exifr.parse(b instanceof Uint8Array ? b : new Uint8Array(b), {
  tiff: true, exif: true, gps: true, ifd0: true, translateValues: false,
});

async function expectNoGpsOnTheWire() {
  const sent = await putBody();
  expect(sent.length).toBeGreaterThan(0);
  // Non-vacuous: the fixture we started from really does carry a fix.
  const before = await parse(GPS_BYTES);
  expect(before.latitude).toBeCloseTo(51.4778, 3);

  const after = await parse(sent);
  expect(after?.latitude).toBeUndefined();
  expect(after?.longitude).toBeUndefined();
  expect(after?.Make).toBeUndefined();
  expect(after?.DateTimeOriginal).toBeUndefined();
  return sent;
}

describe('useUploadPhoto — every bypass class reaches S3 without GPS', () => {
  it('the fixture is under MIN_BYTES, so this suite exercises the real skip', () => {
    expect(GPS_BYTES.length).toBeLessThan(MIN_BYTES);
  });

  it('BYPASS 1 — a photo UNDER 512KB, which skips the downscale entirely', async () => {
    mockUploadOk();
    await upload(gpsFile());
    const sent = await expectNoGpsOnTheWire();
    // The real downscale returned the original: only the strip changed the bytes.
    expect(sent.length).toBeLessThan(GPS_BYTES.length);
  });

  it('BYPASS 2 — an undecodable codec, where createImageBitmap throws', async () => {
    bitmapState.mode = 'throw';
    mockUploadOk();
    await upload(gpsFile('shot.jpg'));
    await expectNoGpsOnTheWire();
  });

  it('BYPASS 3 — no usable canvas, where getContext returns null', async () => {
    canvasState.ctx = false;
    bitmapState.width = 4000; bitmapState.height = 3000;   // big enough that it WOULD resize
    mockUploadOk();
    await upload(gpsFile());
    await expectNoGpsOnTheWire();
  });

  it('BYPASS 4 — a re-encode that came out bigger, so the original is kept', async () => {
    bitmapState.width = 4000; bitmapState.height = 3000;
    canvasState.encodedSize = GPS_BYTES.length * 4;        // "grew" -> keep the original
    mockUploadOk();
    await upload(new File([GPS_BYTES], 'big.jpg', { type: 'image/jpeg' }));
    await expectNoGpsOnTheWire();
  });

  it('BYPASS 5 — the downscale deadline fires and the ORIGINAL is uploaded', async () => {
    vi.useFakeTimers();
    try {
      bitmapState.mode = 'hang';
      mockUploadOk();
      const { result } = renderHook(() => useUploadPhoto());
      let done;
      await act(async () => {
        done = result.current.upload(gpsFile());
        await vi.advanceTimersByTimeAsync(20_000);         // past DOWNSCALE_DEADLINE_MS
        await done;
      });
    } finally {
      vi.useRealTimers();
    }
    await expectNoGpsOnTheWire();
  });

  it('strips the 800px thumbnail on its way to thumbs/<key> as well', async () => {
    bitmapState.width = 4000; bitmapState.height = 3000;
    canvasState.encodedSize = GPS_BYTES.length * 4;        // main file falls back to the original
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
    fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/thumb' });
    fetchSpy.mockResolvedValueOnce({ id: 'photo-1' });
    await upload(gpsFile());

    const thumbPut = globalThis.fetch.mock.calls.find((c) => String(c[0]).includes('thumb'));
    expect(thumbPut, 'the thumb was never PUT').toBeTruthy();
    const thumbBytes = await readBytes(thumbPut[1].body);
    // Non-vacuous: the encoder above deliberately produced a thumb WITH GPS.
    expect((await parse(GPS_BYTES)).latitude).toBeCloseTo(51.4778, 3);
    expect(await parse(thumbBytes)).toBeUndefined();
  });
});

describe('useUploadPhoto — the record we keep is not the record we publish', () => {
  // imagePipeline rule 1. The strip must not move readCaptureMeta's read onto the stripped bytes:
  // GPS and capture time still belong in the household-scoped DB row, they just must not ride out
  // in the object. If this goes red the strip was placed before the metadata read.
  it('still records taken_at and gps in the DB row, from the ORIGINAL bytes', async () => {
    mockUploadOk();
    await upload(gpsFile());

    const post = fetchSpy.mock.calls.find((c) => c[0] === '/api/photos');
    expect(post).toBeTruthy();
    const body = JSON.parse(post[1].body);
    expect(body.taken_at).toBeTruthy();
    expect(body.gps_lat).toBeCloseTo(51.4778, 3);
    expect(body.gps_lon).toBeCloseTo(-0.0015, 3);
  });

  it('reports file_size_bytes for the STRIPPED bytes, not the original', async () => {
    mockUploadOk();
    await upload(gpsFile());

    const body = JSON.parse(fetchSpy.mock.calls.find((c) => c[0] === '/api/photos')[1].body);
    const sent = await putBody();
    expect(body.file_size_bytes).toBe(sent.length);
    expect(body.file_size_bytes).toBeLessThan(GPS_BYTES.length);
  });

  it('surfaces an error rather than uploading unstripped bytes when the read fails', async () => {
    mockUploadOk();
    const unreadable = new File([GPS_BYTES], 'bad.jpg', { type: 'image/jpeg' });
    Object.defineProperty(unreadable, 'arrayBuffer', {
      value: () => Promise.reject(new Error('NotReadableError')),
    });
    const result = await upload(unreadable);

    expect(result.current.error).toMatch(/NotReadable/);
    expect(FakeXHR.instances.find((x) => x.method === 'PUT')).toBeFalsy();
  });
});
