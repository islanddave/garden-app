// The fail-closed contract on the ONE exit that publishes a photo outside the household.
//
// Two layers, because only one of them can execute here.
//
// WHY NOT JUST IMPORT index.js AND CALL preparePhoto: it imports @neondatabase/serverless,
// @clerk/backend and two AWS SDK clients at module scope. None of those are in the ROOT
// package.json — they live in lambda/facebook-share/package.json and are installed only into the
// deployment zip — and vitest.config.ts deliberately excludes tests/integration/** precisely "so
// `npm test` doesn't try to resolve @neondatabase/serverless". vi.mock cannot rescue it: Vite's
// import-analysis resolves the specifier before any mock applies. That is the structural reason
// index.js has no execution coverage, and closing it properly means adding resolver aliases that
// every one of the repo's 700+ test files would then run under — a change with its own blast
// radius, tracked separately, NOT something to smuggle in behind a privacy fix.
//
// So: layer 1 executes the real strip through the real adapter and proves what the bytes do.
// Layer 2 is a SOURCE-TEXT guard on the call site — it asserts the shape of the code, not its
// behaviour, and it is labelled that way so nobody reads it as more than it is. It is the same
// house pattern as lambda/**/select-columns.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJpegExif, isJpeg } from './exif.js';

const here = dirname(fileURLToPath(import.meta.url));

// ── JPEG assembly ────────────────────────────────────────────────────────────────────────────────
const cat = (...parts) => {
  const flat = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(flat.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of flat) { out.set(p, o); o += p.length; }
  return out;
};
const str = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const seg = (marker, id, body) => {
  const payload = cat(str(id), str(body));
  return cat([0xFF, marker, ((payload.length + 2) >> 8) & 0xFF, (payload.length + 2) & 0xFF], payload);
};
const SOI = [0xFF, 0xD8];
const EOI = [0xFF, 0xD9];
const SOS = [0xFF, 0xDA, 0x00, 0x08, 1, 0, 0, 0, 0, 0];
const JFIF = seg(0xE0, 'JFIF\0', '\x01\x01\x00\x00\x01\x00\x01\x00\x00');
const GPS_APP1 = seg(0xE1, 'Exif\0\0', 'GPS-COORDINATES-HERE');

const wellFormed = cat(SOI, JFIF, GPS_APP1, SOS, [0x12, 0x34], EOI);
// JFIF first is load-bearing: isJpeg() sniffs FF D8 FF, so breaking at SOI would stop the file
// being a JPEG at all and send it down a different branch entirely — a bug an earlier draft of
// this fixture had, which made the desync cases pass while testing nothing.
const brokenBeforeExif = (bad) => cat(SOI, JFIF, bad, GPS_APP1, SOS, [0x12, 0x34], EOI);
const DESYNC = [0x00, 0x00, 0x00];              // not 0xFF where a marker must be -> 'desync'
const ZERO_LEN = [0xFF, 0xE7, 0x00, 0x00];      // declared length 0 -> len < 2 -> 'bad-length'

const carriesGps = (b) => Buffer.from(b).includes(Buffer.from('GPS-COORDINATES-HERE'));

describe('exif.js adapter — incompleteWalk reaches the caller', () => {
  it('a well-formed JPEG strips clean and reports a complete walk', () => {
    expect(carriesGps(wellFormed)).toBe(true);                 // non-vacuity
    const r = stripJpegExif(wellFormed);
    expect(r.isJpeg).toBe(true);
    expect(r.incompleteWalk).toBe(false);
    expect(r.reason).toBeNull();
    expect(carriesGps(r.out)).toBe(false);
  });

  it.each([
    ['desync', DESYNC],
    ['bad-length', ZERO_LEN],
  ])('%s before the APP1: the coordinates survive, and the adapter says the walk did not finish', (reason, bad) => {
    const input = brokenBeforeExif(bad);
    expect(carriesGps(input)).toBe(true);                      // non-vacuity
    const r = stripJpegExif(input);

    // The bytes a caller would publish still carry the coordinates...
    expect(carriesGps(r.out)).toBe(true);
    // ...and every other field looks like an ordinary success, which is the whole problem.
    expect(r.isJpeg).toBe(true);
    expect(r.droppedSegments).toBe(0);
    // Only this pair dissents. Dropping it from the adapter's return object — which is what the
    // pre-fix version did — leaves the caller no way to know.
    expect(r.incompleteWalk).toBe(true);
    expect(r.reason).toBe(reason);
  });

  it('isJpeg still rejects a non-JPEG, so the guard order in preparePhoto holds', () => {
    expect(isJpeg(str('not an image'))).toBe(false);
    expect(isJpeg(wellFormed)).toBe(true);
  });
});

describe('index.js preparePhoto call site (SOURCE-TEXT guard — asserts shape, not behaviour)', () => {
  const src = readFileSync(join(here, 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function preparePhoto'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);

  it('the anchor still resolves — a stale slice would make every assertion below vacuous', () => {
    expect(src).toContain('async function preparePhoto');
    expect(body).toContain('stripJpegExif');
    expect(body.length).toBeGreaterThan(100);
    expect(body.length).toBeLessThan(2000);                    // sliced a function, not the file
  });

  it('destructures incompleteWalk from the strip rather than taking `out` alone', () => {
    expect(body).toMatch(/const\s*\{[^}]*\bincompleteWalk\b[^}]*\}\s*=\s*stripJpegExif\(/);
  });

  it('throws on incompleteWalk BEFORE returning the bytes', () => {
    const guard = body.search(/if\s*\(\s*incompleteWalk\s*\)/);
    const ret = body.search(/return\s*\{\s*photo_id/);
    expect(guard).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(ret);                           // fail closed, not fail-then-return
    expect(body.slice(guard, ret)).toContain('throw');
  });

  it('marks that throw userFacing, so the sheet shows a reason instead of a generic failure', () => {
    const guard = body.search(/if\s*\(\s*incompleteWalk\s*\)/);
    expect(body.slice(guard)).toMatch(/userFacing\s*=\s*true/);
  });
});

// ── BUG-FBSHAREBYTES-001 — LAYER 2: SOURCE-TEXT GUARD, not behaviour ────────────────────────────
// Same caveat as the guards above and stated the same way so nobody reads it as more: index.js
// cannot be imported here, so this asserts the SHAPE of the call site, never what it does. The
// batching itself has real execution coverage in batch.test.js — that is why it lives in its own
// import-free module.
describe('the prepare step is bounded, not unbounded (source shape)', () => {
  const src = readFileSync(join(here, 'index.js'), 'utf8');

  it('prepares photos through mapInBatches, not a bare Promise.all over every row', () => {
    // The live shape was `Promise.all(ordered.map((row) => preparePhoto(row)))`, which downloaded up
    // to 10 ORIGINALS at once — measured prod photos reach 10 MB, so ~78 MB of originals plus their
    // stripped and Blob copies on a 1024 MB function with a 106 MB baseline.
    expect(src).toMatch(/prepared\s*=\s*await\s+mapInBatches\(\s*ordered,\s*PREPARE_CONCURRENCY/);
    expect(src).not.toMatch(/Promise\.all\(\s*ordered\.map/);
  });

  it('declares a concurrency that is actually bounded', () => {
    const m = src.match(/export const PREPARE_CONCURRENCY = (\d+);/);
    expect(m).toBeTruthy();
    const n = Number(m[1]);
    expect(n).toBeGreaterThan(0);
    // Below MAX_PHOTOS or it is not a bound at all — it would just be Promise.all spelled longer.
    expect(n).toBeLessThan(10);
  });

  it('still fetches the ORIGINAL, so the bound is the only thing protecting memory', () => {
    // Documenting the coupling rather than asserting a fix that is not there: no social-sized
    // derivative exists (only thumb 96px and card 480px, both WebP, both unusable for a post and
    // WebP is rejected by Instagram outright). If a derivative is ever introduced, this guard should
    // be revisited together with PREPARE_CONCURRENCY — the two exist to solve the same problem.
    expect(src).toMatch(/fetchPhotoBytes\(row\.storage_path\)/);
  });
});
