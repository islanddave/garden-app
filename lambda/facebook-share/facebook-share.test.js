import { describe, it, expect } from 'vitest';
import { isJpeg, stripJpegExif } from './exif.js';
import {
  GRAPH_VERSION, MAX_PHOTOS, photoUploadUrl, feedUrl, nodeUrl,
  attachedMediaFields, validateShareRequest, classifyGraphError,
} from './graph.js';

// ── JPEG segment assembly helpers ──────────────────────────────────────────────────────────────
const b = (...xs) => xs.flat();
function marker(m, payload) {                 // APPn/segment with 2-byte length (incl. the length bytes)
  const len = payload.length + 2;
  return [0xFF, m, (len >> 8) & 0xFF, len & 0xFF, ...payload];
}
const SOI = [0xFF, 0xD8];
const EOI = [0xFF, 0xD9];
const SOS = [0xFF, 0xDA, 0x00, 0x08, 1, 0, 0, 0, 0, 0]; // minimal scan header (len 8 incl length bytes)
const SCAN = [0x12, 0x34, 0x56, 0x78];
const asBytes = (arr) => Uint8Array.from(arr);
const app0 = marker(0xE0, [...[0x4A, 0x46, 0x49, 0x46, 0x00], 1, 1, 0, 0, 1, 0, 1, 0, 0]); // JFIF
const app1Exif = marker(0xE1, [...[0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 9, 9, 9, 9, 9, 9]); // "Exif\0\0"+junk
const app1Xmp = marker(0xE1, [...[0x68, 0x74, 0x74, 0x70], 1, 2, 3]);                        // XMP also rides APP1
const includesSub = (hay, needle) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

describe('isJpeg', () => {
  it('true for FFD8FF SOI', () => expect(isJpeg(asBytes([0xFF, 0xD8, 0xFF, 0xE0]))).toBe(true));
  it('false for PNG', () => expect(isJpeg(asBytes([0x89, 0x50, 0x4E, 0x47]))).toBe(false));
  it('false for too-short', () => expect(isJpeg(asBytes([0xFF, 0xD8]))).toBe(false));
});

describe('stripJpegExif', () => {
  it('drops APP1 (EXIF) while preserving SOI/APP0/SOS/scan/EOI', () => {
    const jpeg = asBytes(b(SOI, app1Exif, app0, SOS, SCAN, EOI));
    const { out, isJpeg: ok, droppedSegments } = stripJpegExif(jpeg);
    expect(ok).toBe(true);
    expect(droppedSegments).toBe(1);
    expect(out.length).toBe(jpeg.length - app1Exif.length);
    expect(includesSub(out, [0xFF, 0xE1])).toBe(false);   // no APP1 marker survives
    expect(includesSub(out, app0)).toBe(true);            // JFIF kept
    expect(includesSub(out, SCAN)).toBe(true);            // entropy data intact
    expect(out[0]).toBe(0xFF); expect(out[1]).toBe(0xD8); // SOI
    expect(out[out.length - 2]).toBe(0xFF); expect(out[out.length - 1]).toBe(0xD9); // EOI
  });

  it('strips BOTH APP1 segments (EXIF + XMP)', () => {
    const jpeg = asBytes(b(SOI, app1Exif, app1Xmp, app0, SOS, SCAN, EOI));
    const { droppedSegments, out } = stripJpegExif(jpeg);
    expect(droppedSegments).toBe(2);
    expect(includesSub(out, [0xFF, 0xE1])).toBe(false);
  });

  it('is a no-op on an already-clean JPEG (no APP1)', () => {
    const jpeg = asBytes(b(SOI, app0, SOS, SCAN, EOI));
    const { out, droppedSegments } = stripJpegExif(jpeg);
    expect(droppedSegments).toBe(0);
    expect(Array.from(out)).toEqual(Array.from(jpeg));
  });

  it('returns non-JPEG input unchanged', () => {
    const png = asBytes([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]);
    const { out, isJpeg: ok, droppedSegments } = stripJpegExif(png);
    expect(ok).toBe(false);
    expect(droppedSegments).toBe(0);
    expect(out).toBe(png); // same reference — caller rejects non-JPEG
  });

  it('bails to verbatim on a corrupt segment length', () => {
    const jpeg = asBytes([...SOI, 0xFF, 0xE2, 0xFF, 0xFF, 1, 2]); // APP2 len 0xFFFF overruns
    const { out } = stripJpegExif(jpeg);
    expect(Array.from(out)).toEqual(Array.from(jpeg));
  });
});

describe('graph url builders', () => {
  it('uses the configured version', () => expect(GRAPH_VERSION).toMatch(/^v\d+\.\d+$/));
  it('photoUploadUrl', () => expect(photoUploadUrl('123')).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/123/photos`));
  it('feedUrl', () => expect(feedUrl('123')).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/123/feed`));
  it('nodeUrl', () => expect(nodeUrl('abc')).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/abc`));
});

describe('attachedMediaFields', () => {
  it('produces indexed media_fbid fields in order', () => {
    expect(attachedMediaFields(['m1', 'm2'])).toEqual([
      ['attached_media[0]', '{"media_fbid":"m1"}'],
      ['attached_media[1]', '{"media_fbid":"m2"}'],
    ]);
  });
});

describe('validateShareRequest', () => {
  it('rejects missing photo_ids', () => expect(validateShareRequest({}).ok).toBe(false));
  it('rejects empty photo_ids', () => expect(validateShareRequest({ photo_ids: [] }).ok).toBe(false));
  it(`rejects more than ${MAX_PHOTOS}`, () => {
    const ids = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => `p${i}`);
    expect(validateShareRequest({ photo_ids: ids }).ok).toBe(false);
  });
  it('rejects duplicates', () => expect(validateShareRequest({ photo_ids: ['a', 'a'] }).ok).toBe(false));
  it('rejects non-string caption', () => expect(validateShareRequest({ photo_ids: ['a'], caption: 5 }).ok).toBe(false));
  it('accepts a valid request and echoes normalized fields', () => {
    const r = validateShareRequest({ photo_ids: ['a', 'b'], caption: 'hi', client_request_id: 'req-1' });
    expect(r.ok).toBe(true);
    expect(r.photoIds).toEqual(['a', 'b']);
    expect(r.caption).toBe('hi');
    expect(r.clientRequestId).toBe('req-1');
  });
});

describe('classifyGraphError', () => {
  it('flags invalid/expired token (code 190)', () => {
    const c = classifyGraphError({ error: { code: 190, message: 'expired' } }, 400);
    expect(c.tokenInvalid).toBe(true);
  });
  it('flags rate limiting (code 4/17/32/613)', () => {
    for (const code of [4, 17, 32, 613]) expect(classifyGraphError({ error: { code } }, 400).rateLimited).toBe(true);
  });
  it('marks 5xx as retryable', () => expect(classifyGraphError({}, 503).retryable).toBe(true));
  it('passes through the message', () => expect(classifyGraphError({ error: { code: 100, message: 'bad param' } }, 400).message).toBe('bad param'));
});
