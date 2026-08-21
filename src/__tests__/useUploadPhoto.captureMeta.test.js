// BUG-PHOTOTAKENATNULL-001 — capture metadata must reach POST /api/photos.
//
// taken_at was NULL on 1,270 of 1,270 prod rows. Both halves of the plumbing shipped long ago:
// imagePipeline.js extracts the metadata, and lambda/photos/index.js binds all seven columns in
// both INSERT templates. Nothing connected them — imagePipeline had zero non-test callers.
// useUploadPhoto is the ONLY non-test caller of POST /api/photos in the client, so it is the one
// seam every photo in the app passes through and the only place this can be fixed once.
//
// THE ORDERING GUARD IS THE LOAD-BEARING ONE, and it is deliberately not a stub agreeing with
// itself: the blob the mocked downscale hands back is the SAME fixture with its APP1 segment
// surgically removed by lambda/facebook-share/exif.js — the module prod already uses to strip metadata
// before a byte leaves for Facebook. The test asserts, from those exact bytes, that readCaptureMeta
// can no longer recover the capture time. So a read that moved after the resize would not merely
// fail a convention; it would be reading bytes from which the timestamp is provably gone, which is
// precisely what happens on Dave's phone (imagePipeline.js rule 1).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { fetchSpy, downscaleState, captureState } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  // out=null reproduces the real jsdom result (no createImageBitmap -> original file, no thumb).
  downscaleState: { out: null, hang: false },
  captureState: { hang: false },
}));

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: vi.fn(),
}));

vi.mock('../lib/imageDownscale.js', () => ({
  downscaleWithThumb: vi.fn((f) => downscaleState.hang
    ? new Promise(() => {})
    : Promise.resolve(downscaleState.out ?? { file: f, thumb: null })),
  downscaleImage: vi.fn(async (f) => f),
}));

// PASS-THROUGH by default — every EXIF assertion below runs the REAL readCaptureMeta against real
// fixture bytes, because a mocked EXIF parser would prove nothing about exifr. hang:true is the
// ONLY deviation, and it exists because the deadline bounds a read that never settles regardless of
// cause; modelling that through a doctored File instead made the guard VACUOUS (it passed with the
// deadline deleted — exifr rejects a non-Blob synchronously, so nothing ever hung).
vi.mock('../lib/imagePipeline.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readCaptureMeta: vi.fn((f, o) => captureState.hang
      ? new Promise(() => {})
      : actual.readCaptureMeta(f, o)),
  };
});

import { useUploadPhoto } from '../hooks/useUploadPhoto.js';
import { readCaptureMeta } from '../lib/imagePipeline.js';
import { stripJpegExif } from '../../lambda/facebook-share/exif.js';

// jsdom's Blob implements neither arrayBuffer() nor a usable stream (every browser we target has
// had Blob.arrayBuffer since Chrome 76). Environment gap, not production behavior — same guarded
// patch imagePipeline.test.js applies for the same reason.
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

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtureBytes = (name) => readFileSync(join(HERE, 'fixtures', name));
const fixture = (name, type = 'image/jpeg') => new File([fixtureBytes(name)], name, { type });

// The real OnePlus capture instant carried by onepad-real-exif-nogps.jpg, asserted the same way
// imagePipeline.test.js asserts it (local calendar fields, so the run's TZ cannot flip the date).
const EXPECTED_TAKEN = { year: 2026, month: 6, date: 8 };

class FakeXHR {
  static instances = [];
  static behavior = 'success';
  constructor() {
    FakeXHR.instances.push(this);
    this.status = 0; this.aborted = false; this.headers = {};
    this._l = {}; this._ul = {};
    this.upload = { addEventListener: (ev, fn) => { (this._ul[ev] ||= []).push(fn); } };
  }
  addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  abort() { this.aborted = true; (this._l.abort || []).forEach(f => f({})); }
  send(body) {
    this.body = body;
    if (FakeXHR.behavior === 'success') queueMicrotask(() => this.fireLoad(200));
  }
  fireLoad(status) { this.status = status; (this._l.load || []).forEach(f => f({})); }
}

beforeEach(() => {
  downscaleState.out = null;
  downscaleState.hang = false;
  captureState.hang = false;
  fetchSpy.mockReset();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  globalThis.URL.revokeObjectURL = vi.fn();
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
  FakeXHR.instances = [];
  FakeXHR.behavior = 'success';
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// presign -> POST, the two apiFetch legs of a thumbless upload.
function mockUploadOk() {
  fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
  fetchSpy.mockResolvedValueOnce({ id: 'photo-1', storage_path: 'standalone/u.jpg' });
}

async function uploadAndReadBody(file, opts = {}) {
  const { result } = renderHook(() => useUploadPhoto());
  await act(async () => { await result.current.upload(file, opts); });
  const post = fetchSpy.mock.calls.find(c => c[0] === '/api/photos');
  expect(post, 'POST /api/photos was never called').toBeTruthy();
  return JSON.parse(post[1].body);
}

describe('useUploadPhoto — capture metadata (BUG-PHOTOTAKENATNULL-001)', () => {
  it('sends the EXIF capture time as taken_at', async () => {
    mockUploadOk();
    const body = await uploadAndReadBody(fixture('onepad-real-exif-nogps.jpg'));

    expect(body.taken_at).toBeTruthy();
    const t = new Date(body.taken_at);
    expect(t.getFullYear()).toBe(EXPECTED_TAKEN.year);
    expect(t.getMonth()).toBe(EXPECTED_TAKEN.month);
    expect(t.getDate()).toBe(EXPECTED_TAKEN.date);
  });

  // Rule 1 of imagePipeline.js, enforced end to end at the live seam.
  it('reads EXIF from the ORIGINAL file, so taken_at survives a resize that strips it', async () => {
    const src = fixtureBytes('onepad-real-exif-nogps.jpg');
    const { out: stripped, droppedSegments } = stripJpegExif(src);
    expect(droppedSegments, 'fixture carried nothing to strip — guard would be vacuous').toBeGreaterThan(0);

    const resized = new File([stripped], 'onepad-real-exif-nogps.jpg', { type: 'image/jpeg' });
    // The premise, proven rather than assumed: the bytes that go to S3 no longer carry the date.
    expect((await readCaptureMeta(resized)).takenAt).toBeNull();

    downscaleState.out = { file: resized, thumb: null };
    mockUploadOk();
    const body = await uploadAndReadBody(fixture('onepad-real-exif-nogps.jpg'));

    expect(FakeXHR.instances[0].body, 'the resized blob is what was PUT').toBe(resized);
    expect(new Date(body.taken_at).getDate()).toBe(EXPECTED_TAKEN.date);
  });

  // NULL must stay a legitimate value. Screenshots, downloads and anything a messaging app has
  // already stripped have no capture time, and inventing one from upload time would make the
  // column a lie — which is the entire distinction taken_at exists to draw (see its COMMENT in
  // migrations/v4-photobulk-p1/0a-additive-ddl.sql).
  it('sends taken_at NULL for a photo with no EXIF rather than substituting upload time', async () => {
    mockUploadOk();
    const body = await uploadAndReadBody(fixture('no-exif.jpg'));
    expect(body.taken_at).toBeNull();
    expect(body.gps_lat).toBeNull();
    expect(body.gps_lon).toBeNull();
  });

  it('sends file_size_bytes for the UPLOADED bytes, not the source file', async () => {
    const original = fixture('onepad-real-exif-nogps.jpg');
    const resized = new File([new Uint8Array(4321)], 'photo.jpg', { type: 'image/jpeg' });
    downscaleState.out = { file: resized, thumb: null };
    mockUploadOk();
    const body = await uploadAndReadBody(original);

    expect(body.file_size_bytes).toBe(4321);
    expect(body.file_size_bytes).not.toBe(original.size);
  });

  it('sends the mime of the uploaded bytes and the ORIGINAL filename', async () => {
    const resized = new File([new Uint8Array(10)], 'photo.jpg', { type: 'image/jpeg' });
    downscaleState.out = { file: resized, thumb: null };
    mockUploadOk();
    const png = new File([new Uint8Array(64)], 'shot.png', { type: 'image/png' });
    const body = await uploadAndReadBody(png);

    expect(body.mime_type).toBe('image/jpeg');
    expect(body.original_filename).toBe('shot.png');
  });

  // BUG-PHOTOUPLOADHANG-001 discipline: nothing new on the save path may be unbounded. A
  // content:// File whose read never settles must cost the metadata, never the photo.
  it('a metadata read that never settles is abandoned at the deadline and the photo still registers', async () => {
    vi.useFakeTimers();
    captureState.hang = true;
    mockUploadOk();

    const { result } = renderHook(() => useUploadPhoto());
    let res;
    await act(async () => {
      const p = result.current.upload(fixture('onepad-real-exif-nogps.jpg'));
      await vi.advanceTimersByTimeAsync(6_000);   // > CAPTURE_META_DEADLINE_MS
      res = await p;
    });
    vi.useRealTimers();

    expect(res.photo).toEqual({ id: 'photo-1', storage_path: 'standalone/u.jpg' });
    const post = fetchSpy.mock.calls.find(c => c[0] === '/api/photos');
    expect(JSON.parse(post[1].body).taken_at).toBeNull();
  });

  // Scope pin, not a preference. Writing content_hash ARMS idx_photos_content_hash_uniq for the
  // first time in prod, turning this INSERT into an UPSERT whose duplicate branch returns before
  // auto-promote and DrG evidence capture — a behavior change with its own blast radius, and it
  // costs a full-file read (4.22MB mean) on a path Dave takes ~17x/day with no measurement taken.
  // That belongs to V4-PHOTOBULK-001's dedupe work. Delete this guard when that lane ships it.
  it('does NOT send content_hash — arming the dedupe index is a separate decision', async () => {
    mockUploadOk();
    const body = await uploadAndReadBody(fixture('onepad-real-exif-nogps.jpg'));
    expect(body.content_hash).toBeUndefined();
  });
});
