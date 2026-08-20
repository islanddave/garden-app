// BUG-HEICEXIFPASSTHRU-001 — the PHOTO_STRIP_STRICT_UPLOAD=true arm.
//
// ⚠️ THE FLAG IS PARKED OFF AND THIS IS THE ARM THAT IS NOT SHIPPED. It exists so the decision Dave
// has to make is a one-const flip rather than an unbuilt feature: reject-the-upload is implemented,
// covered, and proven to actually stop the PUT. Keeping it exercised is also what stops it rotting
// between now and whenever he rules — the SAVE_TO_DEVICE_HIDDEN / CRITTERS_QUIET idiom.
//
// Its own file because vi.mock is module-scoped: the OFF arm (the shipped behaviour) is pinned in
// useUploadPhoto.exifStrip.test.js against the real flag value, so neither file can silently start
// testing the other's arm.
//
// THE ASSERTION IS THE ABSENCE OF THE NETWORK CALL, not an error string. An error message can be
// set while the bytes still go out; no PUT and no /api/photos row is the property that means the
// photo did not leave the device.

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

// Partial mock so every other flag this tree reads keeps its real value.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PHOTO_STRIP_STRICT_UPLOAD: true,
}));

import { useUploadPhoto } from '../hooks/useUploadPhoto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEIC = new Uint8Array(readFileSync(join(HERE, 'fixtures', 'synthetic-gps.heic')));
const AVIF = new Uint8Array(readFileSync(join(HERE, 'fixtures', 'synthetic-gps.avif')));
const GPS_JPEG = new Uint8Array(readFileSync(join(HERE, 'fixtures', 'synthetic-gps.jpg')));

// readCaptureMeta hands exifr a Blob slice and jsdom's Blob has no arrayBuffer — environment gap,
// same guarded patch the sibling suites apply.
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

beforeEach(() => {
  fetchSpy.mockReset();
  FakeXHR.instances = [];
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  // Chrome cannot decode HEIC/AVIF, so the real downscale takes its undecodable-codec return and
  // hands the ORIGINAL file on to the strip. Not mocked away — that stacking is the actual bug.
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('unsupported codec'))));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mockUploadOk() {
  fetchSpy.mockResolvedValueOnce({ upload_url: 'https://s3.example/orig' });
  fetchSpy.mockResolvedValueOnce({ id: 'photo-1' });
}

async function upload(file) {
  const { result } = renderHook(() => useUploadPhoto());
  await act(async () => { await result.current.upload(file); });
  return result;
}

const readBytes = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(new Uint8Array(fr.result));
  fr.onerror = () => reject(fr.error);
  fr.readAsArrayBuffer(blob);
});

const parse = (b) => exifr.parse(b instanceof Uint8Array ? b : new Uint8Array(b), {
  tiff: true, exif: true, gps: true, ifd0: true, translateValues: false,
});

function assertNothingLeftTheDevice() {
  expect(FakeXHR.instances.find((x) => x.method === 'PUT'), 'bytes were PUT to S3').toBeFalsy();
  const thumbPut = globalThis.fetch.mock.calls.find((c) => String(c[0]).includes('thumb'));
  expect(thumbPut, 'a thumb was PUT').toBeFalsy();
  const post = fetchSpy.mock.calls.find((c) => c[0] === '/api/photos');
  expect(post, 'a photo row was registered').toBeFalsy();
}

describe('useUploadPhoto with PHOTO_STRIP_STRICT_UPLOAD=true — unstrippable containers are refused', () => {
  it('the fixtures really carry a fix, so the refusals below are about real metadata', async () => {
    expect((await parse(HEIC)).latitude).toBeCloseTo(51.4778, 3);
    expect((await parse(AVIF)).latitude).toBeCloseTo(51.4778, 3);
  });

  it('a HEIC never reaches S3 — no PUT, no thumb, no photo row', async () => {
    mockUploadOk();
    const result = await upload(new File([HEIC], 'shot.heic', { type: 'image/heic' }));
    assertNothingLeftTheDevice();
    expect(result.current.error).toMatch(/location data/i);
    expect(result.current.error).toContain('image/heic');
  });

  it('an AVIF never reaches S3 either', async () => {
    mockUploadOk();
    const result = await upload(new File([AVIF], 'shot.avif', { type: 'image/avif' }));
    assertNothingLeftTheDevice();
    expect(result.current.error).toMatch(/location data/i);
  });

  // The flag must not turn into "no photo uploads at all". A JPEG is the entire live corpus (1,282
  // of 1,282 rows on prod, measured 2026-08-20), so this is the case that decides whether flipping
  // the flag is safe, and it must still be stripped rather than merely accepted.
  it('a JPEG still uploads, and still arrives stripped', async () => {
    mockUploadOk();
    const result = await upload(new File([GPS_JPEG], 'garden.jpg', { type: 'image/jpeg' }));
    expect(result.current.error).toBeNull();

    const put = FakeXHR.instances.find((x) => x.method === 'PUT');
    expect(put, 'the JPEG was not PUT').toBeTruthy();
    const sent = await readBytes(put.body);
    expect((await parse(GPS_JPEG)).latitude).toBeCloseTo(51.4778, 3);   // non-vacuous
    expect(await parse(sent)).toBeUndefined();
  });
});
