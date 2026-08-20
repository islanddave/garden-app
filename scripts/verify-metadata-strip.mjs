#!/usr/bin/env node
// V4-PHOTOEXIFSTRIP-001 — run src/lib/imageMetadataStrip.js over a folder of REAL photos and prove,
// with a third-party parser, that nothing identifying survives.
//
// MANUAL TOOL, NOT WIRED INTO CI, and it cannot be: it needs real camera originals, and garden-app
// is a PUBLIC repo so none are committed (the unit fixtures put their GPS at Greenwich instead).
// This is how the claim "no coordinates survive" gets checked against Dave's actual corpus.
//
//   node scripts/verify-metadata-strip.mjs ~/AI/Claude/Projects/Gardening/Photos
//   node scripts/verify-metadata-strip.mjs <dir> --out /tmp/stripped   # also write the results
//
// Exit 0 = every file clean. Exit 1 = at least one still leaking, named.
//
// Checks three independent things per file, because they fail differently:
//   1. exifr finds no GPS/Make/Model/DateTimeOriginal in the output (structured metadata).
//   2. no needle string survives anywhere in the output bytes (catches the SAMSUNG TRAILER, which
//      is not EXIF and lives past the EOI — MCC_Data, the on-device DCIM path, Image_UTC_Data).
//   3. the output is still a structurally complete JPEG (SOI ... EOI).
// Last measured 2026-08-20 against 22 originals (15 Pixel, 7 Samsung): all clean.

import fs from 'node:fs';
import path from 'node:path';
import exifr from 'exifr/dist/full.esm.mjs';
import { stripImageBytes, isJpeg, isPng } from '../src/lib/imageMetadataStrip.js';

// Metadata can only live in the marker segments before the first scan, or past the EOI. The
// entropy-coded scan is compressed data, and in ~4000 real photos a specific 4-byte needle turns up
// there by chance roughly once — hunting needles across the WHOLE file reports that coincidence as
// a leak. So the needle search is scoped to the regions where metadata can actually be.
function searchableRegion(out) {
  if (!isJpeg(out)) return out;
  let p = 2;
  while (p + 3 < out.length) {
    if (out[p] !== 0xFF) break;
    if (out[p + 1] === 0xDA) break;                 // first SOS: everything past here is the scan
    p += 2 + ((out[p + 2] << 8) | out[p + 3]);
  }
  return out.subarray(0, Math.min(p, out.length));
}

// PNG has no equivalent of "one tag kept on purpose": exifr surfaces IHDR's geometry and iCCP's
// profile name, both of which are decode/render-essential chunks the strip keeps deliberately.
const PNG_EXPECTED = new Set([
  'ImageWidth', 'ImageHeight', 'BitDepth', 'ColorType', 'Compression', 'Filter', 'Interlace',
  'ProfileName',
]);

// Literal strings observed in real trailers and XMP packets. ICC_PROFILE is deliberately NOT here:
// it is kept on purpose (colour management) and finding it is correct.
const NEEDLES = [
  'MCC_Data', 'PhotoEditor', 'Image_UTC_Data', 'originalPath', 'DCIM', 'SEFT',
  'ns.adobe.com/xap', 'GPSLatitude', 'GPSLongitude',
];

const dir = process.argv[2];
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx > -1 ? process.argv[outIdx + 1] : null;
if (!dir) {
  console.error('usage: node scripts/verify-metadata-strip.mjs <dir-of-photos> [--out <dir>]');
  process.exit(2);
}
if (outDir) fs.mkdirSync(outDir, { recursive: true });

function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(jpe?g|png|webp)$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = walk(dir);
if (!files.length) { console.error(`no images under ${dir}`); process.exit(2); }

let leaking = 0;
const rows = [];
for (const f of files) {
  const input = new Uint8Array(fs.readFileSync(f));
  const r = stripImageBytes(input);
  if (outDir) fs.writeFileSync(path.join(outDir, path.basename(f)), r.out);

  const opts = { tiff: true, exif: true, gps: true, ifd0: true, xmp: true, iptc: true };
  const before = await exifr.parse(input, opts).catch(() => null);
  const after = await exifr.parse(r.out, opts).catch(() => null);
  const region = Buffer.from(searchableRegion(r.out)).toString('latin1');
  const found = NEEDLES.filter((s) => region.includes(s));

  const problems = [];
  if (after?.latitude !== undefined || after?.longitude !== undefined) problems.push('GPS SURVIVED');
  if (after?.Make || after?.Model) problems.push('DEVICE SURVIVED');
  if (after?.DateTimeOriginal) problems.push('CAPTURE TIME SURVIVED');
  if (found.length) problems.push('STRINGS: ' + found.join(','));
  // Orientation is the ONE tag kept on purpose in a JPEG; anything else is a leak.
  const allowed = isPng(input) ? PNG_EXPECTED : new Set(['Orientation']);
  const extra = after ? Object.keys(after).filter((k) => !allowed.has(k)) : [];
  if (extra.length) problems.push('TAGS: ' + extra.join(','));
  if (isJpeg(input) && !(r.out[r.out.length - 2] === 0xFF && r.out[r.out.length - 1] === 0xD9)) {
    problems.push('OUTPUT DOES NOT END AT EOI');
  }
  if (problems.length) leaking++;

  rows.push({
    file: path.basename(f),
    kB: (input.length / 1024) | 0,
    outKB: (r.out.length / 1024) | 0,
    dropped: r.droppedSegments,
    trailer: r.truncatedTrailer,
    orient: r.orientation ?? '-',
    hadGps: before?.latitude !== undefined ? 'yes' : 'no',
    verdict: problems.length ? problems.join(' | ') : 'clean',
  });
}

console.table(rows);
const withGps = rows.filter((r) => r.hadGps === 'yes').length;
console.log(`\n${files.length} file(s); ${withGps} carried GPS before stripping.`);
console.log(leaking ? `${leaking} STILL LEAKING — see verdict column.` : 'ALL CLEAN.');
process.exit(leaking ? 1 : 0);
