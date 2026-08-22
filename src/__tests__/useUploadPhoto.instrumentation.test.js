// V4-PHOTOUPLOADINSTR-001 — one ux_event per photo upload, naming the downscale branch.
//
// WHY THIS FILE IS NOT OPTIONAL. The instrumentation is a fire-and-forget beacon whose entire
// failure mode is silence: sendUxEvent swallows every error by contract, and the OTHER hook tests
// mock '../lib/api.js' without a getToken, so the beacon already no-ops there and would keep
// passing if the call were deleted outright. Without this file the telemetry could ship dead — the
// exact shape of the defect it was written to diagnose (BUG-PHOTOUPLOADSLOW-001), and of the
// open_planting flow that wrote zero prod rows for 2.5 months while its client-side test stayed green.
//
// So: this mocks getToken IN, spies the beacon, and asserts both that it fires and WHAT it carries.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { fetchSpy, sendSpy, downscaleState } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  sendSpy: vi.fn(),
  downscaleState: { out: null },
}));

// getToken IS provided here, unlike the sibling hook tests — without it sendUxEvent bails before it
// builds a payload and every assertion below would pass against a deleted call site.
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn(async () => 'tok') }),
  apiFetch: vi.fn(),
}));

vi.mock('../lib/uxEvents.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendUxEvent: sendSpy };
});

vi.mock('../lib/imageDownscale.js', () => ({
  downscaleWithThumb: vi.fn((f) => Promise.resolve(downscaleState.out ?? { file: f, thumb: null, outcome: 'downscaled' })),
  downscaleImage: vi.fn(async (f) => f),
}));

vi.mock('../lib/imageMetadataStrip.js', () => ({ stripImageFile: vi.fn(async (f) => f) }));
vi.mock('../lib/imagePipeline.js', () => ({
  readCaptureMeta: vi.fn(async () => ({ takenAt: null, tzOffset: null, gpsLat: null, gpsLon: null, orientation: null })),
}));
vi.mock('../lib/uploadPut.js', () => ({ putWithProgress: vi.fn(async () => undefined) }));
vi.mock('../lib/dataCache.js', () => ({ invalidatePrefix: vi.fn() }));

import { useUploadPhoto } from '../hooks/useUploadPhoto.js';
import { FLOWS } from '../lib/uxEvents.js';

beforeEach(() => {
  downscaleState.out = null;
  fetchSpy.mockReset();
  sendSpy.mockReset();
  // presign -> POST /api/photos, the two apiFetch legs of a thumbless upload.
  fetchSpy
    .mockResolvedValueOnce({ upload_url: 'https://s3.example/put' })
    .mockResolvedValueOnce({ id: 'photo-1' });
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.restoreAllMocks(); });

const bigFile = () => new File([new Uint8Array(9_000_000)], 'DSC.jpg', { type: 'image/jpeg' });

async function upload(file) {
  const { result } = renderHook(() => useUploadPhoto({ errorMode: 'surface' }));
  await act(async () => { await result.current.upload(file, { keyPrefix: 'standalone' }); });
}

describe('V4-PHOTOUPLOADINSTR-001 — the upload beacon', () => {
  it('fires exactly once per upload, on the photo_upload flow', async () => {
    await upload(bigFile());
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][1].flowId).toBe(FLOWS.PHOTO_UPLOAD);
    expect(FLOWS.PHOTO_UPLOAD).toBe('photo_upload');
  });

  // THE FIELD THE WHOLE CHANGE EXISTS FOR. Without `outcome`, a 9 MB upload and a 700 kB one are
  // indistinguishable after the fact — which is precisely why BUG-PHOTOUPLOADSLOW-001 could be
  // measured on prod and not diagnosed.
  it('carries the downscale branch that actually ran, not a constant', async () => {
    downscaleState.out = { file: bigFile(), thumb: null, outcome: 'bypass:deadline' };
    await upload(bigFile());
    const meta = sendSpy.mock.calls[0][1].meta;
    expect(meta.outcome).toBe('bypass:deadline');
    // step_name too, so the branch is queryable without unpacking jsonb.
    expect(sendSpy.mock.calls[0][1].stepName).toBe('bypass:deadline');
  });

  it('carries in/out bytes and per-phase timings', async () => {
    await upload(bigFile());
    const meta = sendSpy.mock.calls[0][1].meta;
    expect(meta.in_bytes).toBe(9_000_000);
    expect(typeof meta.out_bytes).toBe('number');
    for (const k of ['downscale_ms', 'strip_ms', 'presign_ms', 'put_ms', 'total_ms']) {
      expect(typeof meta[k]).toBe('number');
    }
    expect(meta.used_relay).toBe(false);
  });

  // ux_events is telemetry, not a content store. A filename is user content and has no business here.
  it('never sends the filename, the S3 key or the caption', async () => {
    await upload(bigFile());
    const payload = JSON.stringify(sendSpy.mock.calls[0][1]);
    expect(payload).not.toContain('DSC.jpg');
    expect(payload).not.toContain('standalone/');
  });

  // The beacon sits after the row is registered precisely so it cannot cost the photo. Proving the
  // ordering rather than asserting the intention: a throwing beacon must still return the photo.
  it('a throwing beacon never costs the photo', async () => {
    sendSpy.mockImplementation(() => { throw new Error('telemetry exploded'); });
    const { result } = renderHook(() => useUploadPhoto({ errorMode: 'surface' }));
    let out;
    await act(async () => { out = await result.current.upload(bigFile(), { keyPrefix: 'standalone' }); });
    expect(out?.photo).toEqual({ id: 'photo-1' });
    expect(out?.error).toBeUndefined();
  });
});
