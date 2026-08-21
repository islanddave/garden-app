// BUG-FBSHAREDENYLIST-001 — byte-level guards for the Facebook-share strip.
//
// Facebook share is the ONE path that publishes a garden photo PUBLICLY, outside the household;
// every other surface keeps photos inside the app. It shipped with the weakest strip in the repo: a
// DENYLIST that dropped APP1 and then copied "the scan + EOI to the end" verbatim. Two consequences,
// both reproduced below on a fixture shaped like real phone output — the SURVIVES cases are what
// this file exists to keep dead:
//   - a denylist never reaches bytes AFTER the primary EOI, where Samsung puts a raw trailer
//     (MCC_Data311, Image_UTC_Data<epoch_ms>, the on-device DCIM path) and Pixel puts a whole second
//     JPEG. Trailers were on 22 of 22 real originals sampled; this is the normal case.
//   - naming one marker leaks every other one: APP2 MPF, APP11 JUMBF/C2PA, APP13 IPTC, COM.
//
// ASSERT BYTES, NEVER A CALL. "the strip function ran" is worth nothing here — the old strip ran on
// every one of those 412 fixture bytes and passed 322 of them through. Every assertion below either
// searches the OUTPUT for a needle the input provably carried, or counts structural markers.
// Anti-vacuity is explicit: each needle is asserted PRESENT in the fixture first, so a fixture that
// stopped carrying it fails loudly instead of passing an empty search.
//
// MUTATION PROOF (2026-08-21): restoring the denylist strip in exif.js (drop APP1, `if (marker ===
// 0xDA) { parts.push(b.subarray(i)); break; }`) reds 8 of the 14 tests here, naming every leak class.
import { describe, it, expect } from 'vitest';
import { isJpeg, stripJpegExif } from './exif.js';
import { stripJpegBytes } from '../../src/lib/imageMetadataStrip.js';

// ── fixture assembly ───────────────────────────────────────────────────────────────────────────
const A = (s) => [...s].map((c) => c.charCodeAt(0));
const seg = (m, payload) => {
  const len = payload.length + 2;                    // the length field counts its own 2 bytes
  return [0xFF, m, (len >> 8) & 0xFF, len & 0xFF, ...payload];
};

const SOI = [0xFF, 0xD8];
const EOI = [0xFF, 0xD9];
const SOS = [0xFF, 0xDA, 0x00, 0x08, 1, 0, 0, 0, 0, 0];
// Entropy-coded data with the two features a naive walker trips on: a stuffed FF00 and a restart
// marker. Both must survive byte-for-byte, and neither may be read as a segment boundary.
const SCAN = [0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0x78];

const app0Jfif = seg(0xE0, [...A('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const app2Icc = seg(0xE2, [...A('ICC_PROFILE\0'), 1, 1, 0x61, 0x63, 0x73, 0x70]);

// A real-shaped EXIF APP1: big-endian TIFF, IFD0 carrying Orientation=6 and a GPSInfoIFD pointer,
// GPS IFD carrying GPSLatitude 42/1 510/100 0/1. Orientation must come back; the GPS must not.
const app1Exif = seg(0xE1, [
  ...A('Exif\0\0'),
  0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,                          // MM, 42, IFD0 @8
  0x00, 0x02,
  0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,  // Orientation = 6
  0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26,  // GPSInfoIFD @0x26
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x01,
  0x00, 0x02, 0x00, 0x05, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x3C,  // GPSLatitude @0x3C
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x01, 0xFE, 0x00, 0x00, 0x00, 0x64,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
]);
const app1Xmp = seg(0xE1, [...A('http://ns.adobe.com/xap/1.0/\0'), ...A('<x:xmpmeta gps="42.5087"/>')]);
const app2Mpf = seg(0xE2, [...A('MPF\0'), 0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8, 0, 0]);
const app11Jumbf = seg(0xEB, [...A('JP'), 0, 0, 0, 0x20, ...A('jumbc2pa'), 1, 2, 3, 4]);
const app13Iptc = seg(0xED, [...A('Photoshop 3.0\0'), ...A('8BIM'), 0x04, 0x04, 0, 0, 0, 4, 1, 2, 3, 4]);
const com = seg(0xFE, A('Pixel 8 Pro shot at 42.5087,-72.6470'));

// Samsung's raw trailer: not EXIF, not in any APP segment, appended past the primary EOI.
const samsungTrailer = [
  ...A('MCC_Data311'),
  ...A('Image_UTC_Data1676080910000'),
  ...A('PhotoEditor_Re_Edit_Data/data/sec/photoeditor/0/storage/emulated/0/DCIM/Camera/20230211_014150.jpg'),
];
// Pixel's Ultra HDR gain map: an entire second JPEG appended past the same EOI. 0xAB,0xCD is its
// scan, used below as a needle that only exists inside the appended image.
const appendedJpeg = [...SOI, ...app0Jfif, ...SOS, 0xAB, 0xCD, ...EOI];

const PHONE_JPEG = Uint8Array.from([
  ...SOI, ...app0Jfif, ...app1Exif, ...app1Xmp, ...app2Icc, ...app2Mpf,
  ...app11Jumbf, ...app13Iptc, ...com,
  ...SOS, ...SCAN, ...EOI,
  ...samsungTrailer, ...appendedJpeg,
]);

const indexOfSub = (hay, needle) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};
const has = (hay, needle) => indexOfSub(hay, needle) !== -1;
const hasStr = (hay, s) => has(hay, A(s));
const countMarker = (b, m) => {
  let c = 0;
  for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0xFF && b[i + 1] === m) c++;
  return c;
};

// Every needle: [label, bytes]. Each is asserted present in the fixture AND absent from the output.
const LEAK_NEEDLES = [
  ['Samsung MCC_Data (SIM mobile country code)', A('MCC_Data311')],
  ['Samsung Image_UTC_Data capture timestamp', A('Image_UTC_Data1676080910000')],
  ['Samsung on-device DCIM path', A('/storage/emulated/0/DCIM/Camera/20230211_014150.jpg')],
  ['Pixel appended gain-map JPEG scan bytes', [0xAB, 0xCD]],
  ['APP2 MPF gain-map index', A('MPF\0')],
  ['APP11 JUMBF / C2PA container', A('jumbc2pa')],
  ['APP13 Photoshop IRB / IPTC', A('Photoshop 3.0\0')],
  ['COM comment carrying coordinates', A('42.5087,-72.6470')],
  ['XMP GPS in APP1', A('<x:xmpmeta gps="42.5087"/>')],
];

describe('exif.js strips a phone-shaped JPEG — BUG-FBSHAREDENYLIST-001', () => {
  it('the fixture is a JPEG the handler would accept', () => {
    expect(isJpeg(PHONE_JPEG)).toBe(true);
    expect(stripJpegExif(PHONE_JPEG).isJpeg).toBe(true);
  });

  for (const [label, needle] of LEAK_NEEDLES) {
    it(`removes: ${label}`, () => {
      // Anti-vacuity first — a fixture that stopped carrying the needle would otherwise pass an
      // empty search and report a leak class as guarded when nothing was ever tested.
      expect(has(PHONE_JPEG, needle), `fixture does not carry "${label}" — this guard is vacuous`).toBe(true);
      const { out } = stripJpegExif(PHONE_JPEG);
      expect(has(out, needle), `"${label}" survived the strip`).toBe(false);
    });
  }

  it('truncates at the primary EOI — nothing follows it', () => {
    const { out, truncatedTrailer } = stripJpegExif(PHONE_JPEG);
    expect(out[out.length - 2]).toBe(0xFF);
    expect(out[out.length - 1]).toBe(0xD9);
    expect(countMarker(out, 0xD9), 'more than one EOI == an appended second JPEG rode along').toBe(1);
    expect(truncatedTrailer).toBe(samsungTrailer.length + appendedJpeg.length);
  });

  it('keeps ONLY the decode-affecting segments (allowlist, not denylist)', () => {
    const { out } = stripJpegExif(PHONE_JPEG);
    expect(hasStr(out, 'JFIF\0'), 'JFIF APP0 is decode-affecting and must survive').toBe(true);
    expect(hasStr(out, 'ICC_PROFILE\0'), 'ICC APP2 is colour management and must survive').toBe(true);
    expect(countMarker(out, 0xDA), 'exactly one SOS').toBe(1);
    // No unnamed APPn or COM survives. APP1 is exempt because Orientation is re-emitted as one.
    for (const m of [0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEF, 0xFE]) {
      expect(countMarker(out, m), `marker FF${m.toString(16).toUpperCase()} survived`).toBe(0);
    }
  });

  it('is lossless — the entropy-coded scan survives byte-for-byte, stuffing and restart marker intact', () => {
    const { out } = stripJpegExif(PHONE_JPEG);
    const at = indexOfSub(out, SCAN);
    expect(at, 'the scan was altered or truncated').toBeGreaterThan(-1);
    expect(Array.from(out.slice(at, at + SCAN.length))).toEqual(SCAN);
  });

  it('preserves Orientation as a minimal APP1 — the old strip posted portrait photos sideways', () => {
    const { out, orientation } = stripJpegExif(PHONE_JPEG);
    expect(orientation).toBe(6);
    const app1At = indexOfSub(out, [0xFF, 0xE1]);
    expect(app1At, 'no orientation APP1 emitted').toBeGreaterThan(-1);
    // 0xFFE1, length 0x0022, "Exif\0\0", MM/42/IFD0@8, 1 entry, tag 0x0112 SHORT count 1, value 6.
    expect(Array.from(out.slice(app1At, app1At + 36))).toEqual([
      0xFF, 0xE1, 0x00, 0x22,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x01,
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
      0x00, 0x06, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(countMarker(out, 0xE1), 'the only APP1 in the output is the synthesized one').toBe(1);
  });

  it('drops the overwhelming majority of the file — a near-passthrough is the bug', () => {
    const { out, droppedSegments, droppedBytes } = stripJpegExif(PHONE_JPEG);
    expect(droppedSegments).toBeGreaterThanOrEqual(6);
    expect(droppedBytes).toBeGreaterThan(0);
    // The old denylist strip emitted 322 of 412 bytes. Anything in that neighbourhood means the
    // allowlist stopped being an allowlist.
    expect(out.length).toBeLessThan(PHONE_JPEG.length / 2);
  });
});

describe('the Lambda strip and the client strip are one implementation', () => {
  // The copy is pinned byte-identical by lambda/imageMetadataStrip-copies-sync.test.js; this pins
  // the ADAPTER on top of it, so exif.js cannot quietly grow logic of its own.
  const CORPUS = [
    ['phone-shaped original', PHONE_JPEG],
    ['already clean', Uint8Array.from([...SOI, ...app0Jfif, ...SOS, ...SCAN, ...EOI])],
    ['EXIF only, no trailer', Uint8Array.from([...SOI, ...app1Exif, ...app0Jfif, ...SOS, ...SCAN, ...EOI])],
    ['trailer only, no EXIF', Uint8Array.from([...SOI, ...app0Jfif, ...SOS, ...SCAN, ...EOI, ...samsungTrailer])],
    ['corrupt segment length', Uint8Array.from([...SOI, 0xFF, 0xE2, 0xFF, 0xFF, 1, 2])],
    ['truncated after SOI', Uint8Array.from([...SOI, 0xFF])],
    ['not a JPEG', Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])],
  ];

  for (const [label, bytes] of CORPUS) {
    it(`byte-identical output on: ${label}`, () => {
      expect(Array.from(stripJpegExif(bytes).out)).toEqual(Array.from(stripJpegBytes(bytes).out));
    });
  }
});
