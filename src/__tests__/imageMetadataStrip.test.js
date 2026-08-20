// V4-PHOTOEXIFSTRIP-001 — imageMetadataStrip tests.
//
// EVERY METADATA ASSERTION IS MADE BY exifr, NOT BY THIS FILE. A test that asserts "the strip
// function said it dropped a segment" proves nothing about whether the coordinates are actually
// gone; a third-party binary parser reading the OUTPUT does. So the shape throughout is: parse the
// input and assert the tag IS there (otherwise the after-assertion is vacuous), strip, parse the
// output and assert it is not.
//
// Fixtures are the ones imagePipeline.test.js already established (src/__tests__/fixtures/):
//   synthetic-gps.jpg          — fabricated EXIF, GPS at GREENWICH. garden-app is a PUBLIC repo,
//                                so Dave's real coordinates are never committed — the real-corpus
//                                proof is scripts/verify-metadata-strip.mjs, run against his photo
//                                library out of tree.
//   onepad-real-exif-nogps.jpg — REAL OnePlus 11 5G EXIF, 1430-byte APP1.
//   no-exif.jpg                — no APP1 at all; the "already clean" baseline.
//
// jsdom's Blob implements neither arrayBuffer() nor a usable stream. That gap is REAL and load
// bearing here: it is why stripImageFile carries a FileReader branch, so this file deliberately
// does NOT patch Blob.prototype the way the older photo tests do — the FileReader path is the one
// under test, and patching it away would leave it unexercised.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr/dist/full.esm.mjs';
import {
  stripJpegBytes, stripPngBytes, stripWebpBytes, stripImageBytes, stripImageFile,
  stripImageFileStrict, UnstrippableFormatError,
  isJpeg, isPng, isWebp,
} from '../lib/imageMetadataStrip.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (n) => new Uint8Array(readFileSync(join(FIX, n)));

const GPS_JPEG = load('synthetic-gps.jpg');
const REAL_EXIF_JPEG = load('onepad-real-exif-nogps.jpg');
const CLEAN_JPEG = load('no-exif.jpg');

// Hand exifr the Uint8Array ITSELF, never Buffer.from(it). Under jsdom a node Buffer fails exifr's
// cross-realm `instanceof Uint8Array` check and every parse rejects with "Invalid input argument" —
// which, behind a .catch, reads exactly like "the tag is gone" and makes the whole file pass
// vacuously. Resolves undefined (not a throw) when there is genuinely no metadata, so no catch here.
const parse = (b) => exifr.parse(b instanceof Uint8Array ? b : new Uint8Array(b), {
  tiff: true, exif: true, gps: true, ifd0: true, xmp: true, iptc: true, translateValues: false,
});

const bytes = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const text = (b) => Buffer.from(b).toString('latin1');

// FileReader, not arrayBuffer(): jsdom's Blob has neither, per the header note.
const readFile = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(new Uint8Array(fr.result));
  fr.onerror = () => reject(fr.error);
  fr.readAsArrayBuffer(blob);
});

function concat(...parts) {
  const flat = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(flat.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of flat) { out.set(p, o); o += p.length; }
  return out;
}

// A well-formed APPn segment carrying `id` then `body`.
function app(marker, id, body = 'PAYLOAD') {
  const payload = concat(bytes(id), bytes(body));
  const len = payload.length + 2;
  return concat([0xFF, marker, (len >> 8) & 0xFF, len & 0xFF], payload);
}

const comment = (s) => {
  const len = s.length + 2;
  return concat([0xFF, 0xFE, (len >> 8) & 0xFF, len & 0xFF], bytes(s));
};

// Graft segments in immediately after SOI, where a camera writes them.
const withSegments = (jpeg, ...segs) => concat(jpeg.subarray(0, 2), ...segs, jpeg.subarray(2));
const withTrailer = (jpeg, trailer) => concat(jpeg, trailer);

// Set IFD0 Orientation in a big-endian EXIF by locating the 12-byte entry itself, so the fixture is
// patched structurally rather than at a hardcoded offset. exifr certifies the result below, which
// is what makes this non-circular: the module's own reader is never consulted to build a fixture.
const ORIENT_ENTRY = [0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01];
function setOrientation(jpeg, value) {
  const out = jpeg.slice();
  for (let i = 0; i + 12 < out.length; i++) {
    if (ORIENT_ENTRY.every((b, k) => out[i + k] === b)) { out[i + 9] = value; return out; }
  }
  throw new Error('orientation entry not found in fixture — patch helper is stale');
}

// Structural sanity: the output must still look like a JPEG a decoder would accept.
function structure(b) {
  const seen = { soi: b[0] === 0xFF && b[1] === 0xD8, sof: false, sos: false, eoi: false, apps: [] };
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xFF) break;
    let m = i + 1;
    while (m < b.length && b[m] === 0xFF) m++;
    const mk = b[m];
    if (mk === 0xD9) { seen.eoi = true; break; }
    if ((mk >= 0xD0 && mk <= 0xD7) || mk === 0x01) { i = m + 1; continue; }
    const len = (b[m + 1] << 8) | b[m + 2];
    if (mk >= 0xE0 && mk <= 0xEF) seen.apps.push(mk);
    if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xCC) seen.sof = true;
    if (mk === 0xDA) {
      seen.sos = true;
      let p = m + 1 + len;
      while (p + 1 < b.length) {
        if (b[p] !== 0xFF) { p++; continue; }
        let j = p + 1;
        while (j < b.length && b[j] === 0xFF) j++;
        if (b[j] === 0x00 || (b[j] >= 0xD0 && b[j] <= 0xD7)) { p = j + 1; continue; }
        break;
      }
      i = p;
      continue;
    }
    i = m + 1 + len;
  }
  return seen;
}

describe('imageMetadataStrip — GPS is the whole point', () => {
  it('the GPS fixture really carries coordinates before we touch it', async () => {
    const before = await parse(GPS_JPEG);
    expect(before.latitude).toBeCloseTo(51.4778, 3);
    expect(before.longitude).toBeCloseTo(-0.0015, 3);
  });

  it('REMOVES THE GPS COORDINATES — exifr can no longer find a fix in the output', async () => {
    const { out } = stripJpegBytes(GPS_JPEG);
    const after = await parse(out);
    expect(after?.latitude).toBeUndefined();
    expect(after?.longitude).toBeUndefined();
    expect(after?.GPSLatitude).toBeUndefined();
    expect(after?.GPSLongitude).toBeUndefined();
  });

  it('removes the camera make, model and capture time with it', async () => {
    const before = await parse(GPS_JPEG);
    expect(before.Make).toBe('TestCam');
    expect(before.DateTimeOriginal).toBeInstanceOf(Date);

    const after = await parse(stripJpegBytes(GPS_JPEG).out);
    expect(after?.Make).toBeUndefined();
    expect(after?.Model).toBeUndefined();
    expect(after?.DateTimeOriginal).toBeUndefined();
  });

  it('strips a REAL camera EXIF block, not just a fabricated one', async () => {
    const before = await parse(REAL_EXIF_JPEG);
    expect(before.Make).toBe('OnePlus');
    expect(before.Model).toBe('OnePlus 11 5G');

    const after = await parse(stripJpegBytes(REAL_EXIF_JPEG).out);
    expect(after?.Make).toBeUndefined();
    expect(after?.Model).toBeUndefined();
    expect(after?.DateTimeOriginal).toBeUndefined();
  });

  it('leaves no EXIF marker in the output at all', () => {
    const { out } = stripJpegBytes(GPS_JPEG);
    expect(text(out)).not.toContain('Exif\0\0');
    expect(structure(out).apps).not.toContain(0xE1);
  });

  it('reports what it dropped so a caller can log it', () => {
    const r = stripJpegBytes(GPS_JPEG);
    expect(r.changed).toBe(true);
    expect(r.droppedSegments).toBeGreaterThan(0);
    expect(r.droppedBytes).toBeGreaterThan(200);
    expect(r.out.length).toBeLessThan(GPS_JPEG.length);
  });
});

describe('imageMetadataStrip — orientation, the landmine', () => {
  it('KEEPS Orientation so a portrait photo does not land sideways', async () => {
    const oriented = setOrientation(GPS_JPEG, 6);
    expect((await parse(oriented)).Orientation).toBe(6);

    const after = await parse(stripJpegBytes(oriented).out);
    expect(after?.Orientation).toBe(6);
  });

  it('keeps ONLY Orientation — every other tag in that same EXIF is gone', async () => {
    const oriented = setOrientation(GPS_JPEG, 8);
    const after = await parse(stripJpegBytes(oriented).out);
    expect(Object.keys(after)).toEqual(['Orientation']);
    expect(after.Orientation).toBe(8);
  });

  it('does not re-emit Orientation 1 — the default and its absence say the same thing', () => {
    const r = stripJpegBytes(setOrientation(GPS_JPEG, 1));
    expect(r.orientation).toBe(1);
    expect(structure(r.out).apps).not.toContain(0xE1);
  });

  it('adds nothing to a canvas-encoded JPEG that never had EXIF', () => {
    const r = stripJpegBytes(CLEAN_JPEG);
    expect(r.orientation).toBeNull();
    expect(structure(r.out).apps).not.toContain(0xE1);
  });

  it('survives every rotation value the spec defines', async () => {
    for (const v of [2, 3, 4, 5, 6, 7, 8]) {
      const after = await parse(stripJpegBytes(setOrientation(GPS_JPEG, v)).out);
      expect(after?.Orientation).toBe(v);
    }
  });

  it('the re-emitted EXIF is 36 bytes and carries no other tag', () => {
    const r = stripJpegBytes(setOrientation(GPS_JPEG, 6));
    const app1 = r.out.subarray(2, 38);
    expect(app1[0]).toBe(0xFF);
    expect(app1[1]).toBe(0xE1);
    expect(text(app1)).toContain('Exif');
    // one IFD entry, tag 0x0112, and a zero next-IFD pointer
    expect([...app1.subarray(18, 20)]).toEqual([0x00, 0x01]);
    expect([...app1.subarray(32, 36)]).toEqual([0, 0, 0, 0]);
  });
});

describe('imageMetadataStrip — the allowlist drops what a denylist would miss', () => {
  it('drops a COM comment', () => {
    const r = stripJpegBytes(withSegments(CLEAN_JPEG, comment('shot at home')));
    expect(text(r.out)).not.toContain('shot at home');
  });

  it('drops an APP13 Photoshop/IPTC block, which can name a city', () => {
    const r = stripJpegBytes(withSegments(CLEAN_JPEG, app(0xED, 'Photoshop 3.0\0', 'IPTC-CITY')));
    expect(text(r.out)).not.toContain('IPTC-CITY');
    expect(structure(r.out).apps).not.toContain(0xED);
  });

  it('drops APP11 JUMBF — the container C2PA content credentials ride in', () => {
    const r = stripJpegBytes(withSegments(CLEAN_JPEG, app(0xEB, 'JP', 'c2pa-manifest')));
    expect(text(r.out)).not.toContain('c2pa-manifest');
    expect(structure(r.out).apps).not.toContain(0xEB);
  });

  it('drops an XMP APP1 even though it is not EXIF — XMP carries GPS too', () => {
    const xmp = app(0xE1, 'http://ns.adobe.com/xap/1.0/\0', '<exif:GPSLatitude>42,30.52N</exif:GPSLatitude>');
    const r = stripJpegBytes(withSegments(CLEAN_JPEG, xmp));
    expect(text(r.out)).not.toContain('GPSLatitude');
    expect(text(r.out)).not.toContain('ns.adobe.com');
  });

  it('drops the APP2 MPF index that points at an appended image', () => {
    const r = stripJpegBytes(withSegments(CLEAN_JPEG, app(0xE2, 'MPF\0', 'mpindex')));
    expect(text(r.out)).not.toContain('mpindex');
  });

  it('DROPS AN APPn NOBODY HAS INVENTED YET — this is why it is an allowlist', () => {
    const r = stripJpegBytes(withSegments(
      CLEAN_JPEG,
      app(0xE9, 'FutureVendor\0', 'tomorrows-gps-tag'),
      app(0xE4, '', 'samsung-proprietary'),
      app(0xE5, 'debuginfo', 'device-serial'),
    ));
    expect(text(r.out)).not.toContain('tomorrows-gps-tag');
    expect(text(r.out)).not.toContain('samsung-proprietary');
    expect(text(r.out)).not.toContain('device-serial');
    expect(r.droppedSegments).toBe(3);
  });
});

describe('imageMetadataStrip — what it deliberately keeps', () => {
  it('keeps the JFIF APP0 (pixel density and aspect ratio)', () => {
    const r = stripJpegBytes(GPS_JPEG);
    expect(structure(r.out).apps).toContain(0xE0);
    expect(text(r.out)).toContain('JFIF');
  });

  it('keeps the ICC colour profile — dropping it visibly shifts wide-gamut colour', () => {
    const r = stripJpegBytes(withSegments(CLEAN_JPEG, app(0xE2, 'ICC_PROFILE\0', 'DisplayP3')));
    expect(text(r.out)).toContain('ICC_PROFILE');
    expect(text(r.out)).toContain('DisplayP3');
  });

  it('keeps the Adobe APP14 colour transform — dropping it inverts a CMYK JPEG', () => {
    const r = stripJpegBytes(withSegments(CLEAN_JPEG, app(0xEE, 'Adobe', '\x00d\x00\x00\x00\x00\x02')));
    expect(structure(r.out).apps).toContain(0xEE);
  });

  it('keeps an ICC profile while dropping an MPF that shares the same APP2 marker', () => {
    const r = stripJpegBytes(withSegments(
      CLEAN_JPEG,
      app(0xE2, 'ICC_PROFILE\0', 'keepme'),
      app(0xE2, 'MPF\0', 'dropme'),
    ));
    expect(text(r.out)).toContain('keepme');
    expect(text(r.out)).not.toContain('dropme');
  });
});

describe('imageMetadataStrip — trailers, which are the normal case not an edge case', () => {
  // Measured 2026-08-20 on Dave's library: 22 of 22 camera originals carried an appended trailer.
  it('TRUNCATES a Samsung-style trailer — MCC, capture time and the on-device path', () => {
    const sef = bytes('Image_UTC_Data1676097711091MCC_Data311PhotoEditor_Re_Edit_Data'
      + '{"originalPath":"/storage/emulated/0/DCIM/Camera/20230211_014150.jpg"}SEFT');
    const r = stripJpegBytes(withTrailer(GPS_JPEG, sef));
    expect(text(r.out)).not.toContain('MCC_Data');
    expect(text(r.out)).not.toContain('originalPath');
    expect(text(r.out)).not.toContain('DCIM');
    expect(r.truncatedTrailer).toBe(sef.length);
  });

  it('truncates an appended second JPEG — the Pixel Ultra HDR gain map', async () => {
    const gain = concat(GPS_JPEG);              // a whole JPEG, GPS and all, appended after EOI
    const r = stripJpegBytes(withTrailer(CLEAN_JPEG, gain));
    expect(r.truncatedTrailer).toBe(gain.length);
    const after = await parse(r.out);
    expect(after?.latitude).toBeUndefined();
    expect(text(r.out)).not.toContain('TestCam');
  });

  it('leaves nothing after the EOI it emits', () => {
    const r = stripJpegBytes(withTrailer(GPS_JPEG, bytes('TRAILING')));
    expect(r.out[r.out.length - 2]).toBe(0xFF);
    expect(r.out[r.out.length - 1]).toBe(0xD9);
  });
});

describe('imageMetadataStrip — the image bitstream is preserved, not re-encoded', () => {
  it('copies the entropy-coded scan byte for byte', () => {
    const scanOf = (b) => {
      let i = 2;
      while (i + 1 < b.length) {
        const mk = b[i + 1];
        const len = (b[i + 2] << 8) | b[i + 3];
        if (mk === 0xDA) return b.subarray(i + 2 + len);
        i += 2 + len;
      }
      return new Uint8Array();
    };
    const before = scanOf(GPS_JPEG);
    const after = scanOf(stripJpegBytes(GPS_JPEG).out);
    expect(after.length).toBe(before.length);
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
  });

  it('keeps the quantization tables, Huffman tables and frame header intact', () => {
    const s = structure(stripJpegBytes(GPS_JPEG).out);
    expect(s.soi).toBe(true);
    expect(s.sof).toBe(true);
    expect(s.sos).toBe(true);
    expect(s.eoi).toBe(true);
  });

  // BOTH scan tests carry a TRAILER, and that is the load-bearing part of them. Asserting only that
  // the scan bytes survive is VACUOUS: a walker that mis-reads FF00 as a marker desyncs, hits the
  // "copy the remainder verbatim" fail-safe, and reproduces the correct scan bytes by accident. What
  // it CANNOT do is find the EOI — so the trailer it should have cut survives, and that is the
  // difference the assertions below actually detect. (Found by mutation: the first version of these
  // two tests stayed green with the stuffing branch deleted.)
  it('does not mistake byte-stuffed FF00 inside the scan for a marker', () => {
    // FF00 is how a literal FF is encoded in entropy data.
    const stuffed = concat(
      [0xFF, 0xD8], app(0xE1, 'Exif\0\0', 'meta'),
      [0xFF, 0xDA, 0x00, 0x03, 0x01],                 // SOS header
      [0x11, 0xFF, 0x00, 0x22, 0xFF, 0x00, 0x33],     // scan with two stuffed FFs
      [0xFF, 0xD9], bytes('TRAILER-MUST-GO'),
    );
    const r = stripJpegBytes(stuffed);
    expect(r.reason).toBeNull();                      // walked cleanly to the EOI
    expect(text(r.out)).not.toContain('TRAILER-MUST-GO');
    expect([...r.out.subarray(r.out.length - 9)]).toEqual([0x11, 0xFF, 0x00, 0x22, 0xFF, 0x00, 0x33, 0xFF, 0xD9]);
    expect(text(r.out)).not.toContain('meta');
  });

  it('does not mistake a restart marker inside the scan for a marker', () => {
    const withRst = concat(
      [0xFF, 0xD8], comment('drop me'),
      [0xFF, 0xDA, 0x00, 0x03, 0x01],
      [0x11, 0xFF, 0xD0, 0x22, 0xFF, 0xD7, 0x33],     // RST0 and RST7 mid-scan
      [0xFF, 0xD9], bytes('TRAILER-MUST-GO'),
    );
    const r = stripJpegBytes(withRst);
    expect(r.reason).toBeNull();
    expect(text(r.out)).not.toContain('TRAILER-MUST-GO');
    expect([...r.out.subarray(r.out.length - 9)]).toEqual([0x11, 0xFF, 0xD0, 0x22, 0xFF, 0xD7, 0x33, 0xFF, 0xD9]);
    expect(text(r.out)).not.toContain('drop me');
  });

  it('handles a progressive JPEG with more than one scan', () => {
    const progressive = concat(
      [0xFF, 0xD8], app(0xE1, 'Exif\0\0', 'secret'),
      [0xFF, 0xDA, 0x00, 0x03, 0x01], [0xAA, 0xBB],
      [0xFF, 0xC4, 0x00, 0x03, 0x01],                 // a DHT between the scans
      [0xFF, 0xDA, 0x00, 0x03, 0x02], [0xCC, 0xDD],
      [0xFF, 0xD9],
    );
    const r = stripJpegBytes(progressive);
    expect(text(r.out)).not.toContain('secret');
    expect([...r.out.subarray(r.out.length - 2)]).toEqual([0xFF, 0xD9]);
    expect([...r.out]).toContain(0xAA);
    expect([...r.out]).toContain(0xCC);
  });
});

describe('imageMetadataStrip — robustness', () => {
  it('never throws on a truncated JPEG', () => {
    for (const cut of [3, 10, 25, 60, 400]) {
      expect(() => stripJpegBytes(GPS_JPEG.subarray(0, cut))).not.toThrow();
    }
  });

  it('still drops what it found when the structure goes bad partway through', () => {
    const broken = concat(
      [0xFF, 0xD8], app(0xE1, 'Exif\0\0', 'GPSHERE'),
      [0x00, 0x00, 0x00],                              // desync: not a marker
      [0xFF, 0xD9],
    );
    const r = stripJpegBytes(broken);
    expect(r.reason).toBe('desync');
    expect(text(r.out)).not.toContain('GPSHERE');
  });

  it('leaves a non-JPEG alone rather than corrupting it', () => {
    const notJpeg = bytes('this is not an image at all');
    const r = stripImageBytes(notJpeg);
    expect(r.changed).toBe(false);
    expect(r.format).toBeNull();
    expect(Buffer.from(r.out).equals(Buffer.from(notJpeg))).toBe(true);
  });

  it('dispatches on MAGIC BYTES, never on a declared MIME type', () => {
    expect(isJpeg(GPS_JPEG)).toBe(true);
    expect(stripImageBytes(GPS_JPEG).format).toBe('jpeg');
    expect(isPng(GPS_JPEG)).toBe(false);
    expect(isWebp(GPS_JPEG)).toBe(false);
  });

  it('is idempotent — stripping twice changes nothing the second time', () => {
    const once = stripJpegBytes(GPS_JPEG).out;
    const twice = stripJpegBytes(once);
    expect(twice.changed).toBe(false);
    expect(Buffer.from(twice.out).equals(Buffer.from(once))).toBe(true);
  });
});

describe('imageMetadataStrip — PNG', () => {
  const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  function chunk(type, body = '') {
    const data = bytes(body);
    const len = data.length;
    return concat(
      [(len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF],
      bytes(type), data, [0, 0, 0, 0],
    );
  }
  const png = (...chunks) => concat(PNG_SIG, ...chunks);

  it('drops the eXIf chunk — PNG carries a literal EXIF block, GPS IFD and all', () => {
    const r = stripPngBytes(png(chunk('IHDR', 'hdr'), chunk('eXIf', 'GPS-PAYLOAD'), chunk('IDAT', 'pix'), chunk('IEND')));
    expect(text(r.out)).not.toContain('GPS-PAYLOAD');
    expect(text(r.out)).not.toContain('eXIf');
  });

  it('drops tEXt, zTXt and iTXt — iTXt is where XMP with coordinates rides', () => {
    const r = stripPngBytes(png(
      chunk('IHDR', 'hdr'), chunk('tEXt', 'TEXTLEAK'), chunk('zTXt', 'ZTXTLEAK'),
      chunk('iTXt', 'ITXTLEAK'), chunk('IDAT', 'pix'), chunk('IEND'),
    ));
    for (const s of ['TEXTLEAK', 'ZTXTLEAK', 'ITXTLEAK']) expect(text(r.out)).not.toContain(s);
    expect(r.droppedSegments).toBe(3);
  });

  it('keeps the chunks a renderer needs', () => {
    const r = stripPngBytes(png(chunk('IHDR', 'hdr'), chunk('iCCP', 'profile'), chunk('tRNS', 't'), chunk('IDAT', 'pix'), chunk('IEND')));
    for (const s of ['IHDR', 'iCCP', 'tRNS', 'IDAT', 'IEND']) expect(text(r.out)).toContain(s);
    expect(r.changed).toBe(false);
  });

  it('truncates anything appended after IEND', () => {
    const r = stripPngBytes(concat(png(chunk('IHDR', 'h'), chunk('IDAT', 'p'), chunk('IEND')), bytes('TRAILER-LEAK')));
    expect(text(r.out)).not.toContain('TRAILER-LEAK');
  });
});

describe('imageMetadataStrip — WebP', () => {
  function riff(...chunks) {
    const body = concat(...chunks);
    const size = 4 + body.length;
    return concat(bytes('RIFF'), [size & 0xFF, (size >> 8) & 0xFF, (size >> 16) & 0xFF, (size >>> 24) & 0xFF], bytes('WEBP'), body);
  }
  function wchunk(fourcc, body) {
    const data = bytes(body);
    const pad = data.length & 1 ? [0] : [];
    return concat(bytes(fourcc), [data.length & 0xFF, (data.length >> 8) & 0xFF, (data.length >> 16) & 0xFF, (data.length >>> 24) & 0xFF], data, pad);
  }

  it('drops the EXIF and XMP chunks', () => {
    const r = stripWebpBytes(riff(
      wchunk('VP8X', '\x0c\0\0\0\0\0\0\0\0\0'), wchunk('EXIF', 'GPSLEAK'),
      wchunk('XMP ', 'XMPLEAK'), wchunk('VP8 ', 'pixels'),
    ));
    expect(text(r.out)).not.toContain('GPSLEAK');
    expect(text(r.out)).not.toContain('XMPLEAK');
    expect(text(r.out)).toContain('pixels');
  });

  it('clears the VP8X flag bits that advertise EXIF and XMP', () => {
    const r = stripWebpBytes(riff(wchunk('VP8X', '\x0c\0\0\0\0\0\0\0\0\0'), wchunk('EXIF', 'x'), wchunk('VP8 ', 'p')));
    const at = text(r.out).indexOf('VP8X');
    expect(r.out[at + 8] & 0x0C).toBe(0);
  });

  it('rewrites the RIFF size to match what it kept', () => {
    const r = stripWebpBytes(riff(wchunk('EXIF', 'GPSLEAK'), wchunk('VP8 ', 'pixels')));
    const declared = r.out[4] | (r.out[5] << 8) | (r.out[6] << 16) | (r.out[7] << 24);
    expect(declared).toBe(r.out.length - 8);
  });
});

describe('stripImageFile — the File-level contract', () => {
  it('returns a File carrying the same name, type and lastModified', async () => {
    const f = new File([GPS_JPEG], 'garden.jpg', { type: 'image/jpeg', lastModified: 1700000000000 });
    const out = await stripImageFile(f);
    expect(out).not.toBe(f);
    expect(out.name).toBe('garden.jpg');
    expect(out.type).toBe('image/jpeg');
    expect(out.lastModified).toBe(1700000000000);
    expect(out.size).toBeLessThan(f.size);
  });

  it('reads a Blob that has no arrayBuffer — the real jsdom shape', async () => {
    expect(typeof new Blob([]).arrayBuffer).not.toBe('function');
    const out = await stripImageFile(new Blob([GPS_JPEG], { type: 'image/jpeg' }));
    expect(out.size).toBeLessThan(GPS_JPEG.length);
    // Read the result back the same way, so the assertion is on the bytes the caller would PUT.
    const back = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(out);
    });
    expect(isJpeg(back)).toBe(true);
    expect(await parse(back)).toBeUndefined();
  });

  it('THROWS rather than handing back unstripped bytes when the read fails', async () => {
    const broken = {
      size: 10,
      name: 'x.jpg',
      type: 'image/jpeg',
      arrayBuffer: () => Promise.reject(new Error('NotReadableError')),
    };
    await expect(stripImageFile(broken)).rejects.toThrow('NotReadableError');
  });

  it('returns the input unchanged, and says so, for a format it cannot strip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const heic = new File([bytes('\0\0\0 ftypheic')], 'a.heic', { type: 'image/heic' });
    const out = await stripImageFile(heic);
    expect(out).toBe(heic);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no strip implementation'));
    warn.mockRestore();
  });

  it('returns the input unchanged when there was nothing to drop', async () => {
    const f = new File([CLEAN_JPEG], 'clean.jpg', { type: 'image/jpeg' });
    expect(await stripImageFile(f)).toBe(f);
  });
});

// BUG-HEICEXIFPASSTHRU-001 — the two entry points, on containers with no walker.
//
// The fixtures are REAL ISOBMFF, not a 12-byte `ftyp` stub: `sips -s format heic|avif` over
// synthetic-gps.jpg, which carries the same fabricated Greenwich fix through the conversion (macOS
// preserves the EXIF item). A stub would prove the format sniff and nothing else — these prove
// exifr can read a real location out of the bytes, which is what makes the after-assertions mean
// something. Still Greenwich, still safe for a public repo.
describe('stripImageFile vs stripImageFileStrict — unstrippable containers', () => {
  const HEIC = load('synthetic-gps.heic');
  const AVIF = load('synthetic-gps.avif');
  const fourcc = (b) => String.fromCharCode(...b.subarray(4, 12));

  it('the fixtures are real ISOBMFF AND really carry a fix', async () => {
    expect(fourcc(HEIC)).toBe('ftypheic');
    expect(fourcc(AVIF)).toBe('ftypavif');
    expect((await parse(HEIC)).latitude).toBeCloseTo(51.4778, 3);
    expect((await parse(AVIF)).latitude).toBeCloseTo(51.4778, 3);
    expect((await parse(HEIC)).Make).toBe('TestCam');
  });

  // Characterization, not aspiration: this pins what the primitive DOES so the two policy guards
  // below rest on a stated contract rather than an assumption.
  it('stripImageBytes cannot strip either one, and reports format:null', () => {
    for (const b of [HEIC, AVIF]) {
      expect(stripImageBytes(b)).toMatchObject({
        changed: false, format: null, reason: 'unsupported-format',
      });
    }
  });

  it('LENIENT stripImageFile passes a real HEIC through with its GPS intact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = new File([HEIC], 'shot.heic', { type: 'image/heic' });
    const out = await stripImageFile(f);
    expect(out).toBe(f);
    // The point of the assertion: the bytes that would leave the device still name the location.
    expect((await parse(await readFile(out))).latitude).toBeCloseTo(51.4778, 3);
    warn.mockRestore();
  });

  it('STRICT stripImageFileStrict THROWS on a real HEIC rather than returning bytes', async () => {
    const f = new File([HEIC], 'shot.heic', { type: 'image/heic' });
    await expect(stripImageFileStrict(f)).rejects.toThrow(UnstrippableFormatError);
    await expect(stripImageFileStrict(f)).rejects.toMatchObject({ format: 'image/heic', userFacing: true });
  });

  it('STRICT throws on a real AVIF too', async () => {
    const f = new File([AVIF], 'shot.avif', { type: 'image/avif' });
    await expect(stripImageFileStrict(f)).rejects.toThrow(UnstrippableFormatError);
  });

  // format:null is the predicate, not !changed. A clean JPEG also reports changed:false, and if
  // strict keyed off that it would reject every already-stripped photo — i.e. everything the canvas
  // downscale path produces, which is the common path.
  it('STRICT does NOT throw on a clean JPEG that simply had nothing to drop', async () => {
    const f = new File([CLEAN_JPEG], 'clean.jpg', { type: 'image/jpeg' });
    expect(await stripImageFileStrict(f)).toBe(f);
  });

  it('STRICT still strips a GPS-bearing JPEG normally', async () => {
    const f = new File([GPS_JPEG], 'garden.jpg', { type: 'image/jpeg' });
    const out = await stripImageFileStrict(f);
    expect(out).not.toBe(f);
    expect(await parse(await readFile(out))).toBeUndefined();
  });

  it('STRICT throws for a non-Blob rather than handing it back unexamined', async () => {
    await expect(stripImageFileStrict(null)).rejects.toThrow(UnstrippableFormatError);
    await expect(stripImageFileStrict({ type: 'image/jpeg' })).rejects.toThrow(UnstrippableFormatError);
  });

  it('the thrown message is fit to show a user verbatim (useUploadPhoto surfaces err.message)', () => {
    const e = new UnstrippableFormatError('image/heic');
    expect(e.message).toContain('image/heic');
    expect(e.message).toMatch(/location data/i);
    expect(e.message).toMatch(/JPEG/);
  });
});
