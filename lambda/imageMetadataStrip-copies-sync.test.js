// BUG-FBSHAREDENYLIST-001 — the Facebook-share Lambda strips photo metadata with a byte-identical
// copy of the canonical src/lib/imageMetadataStrip.js, because deploy-lambda.yml zips from inside
// the function dir (`cd lambda/<fn> && zip -r ../<fn>.zip .`) and a `../../src/lib/...` import
// therefore resolves under vitest but is ERR_MODULE_NOT_FOUND in the deployed Lambda. Same
// constraint, same house pattern as http-response-copies-sync.test.js / photo-access-copies-sync.test.js
// — except the canonical lives in src/lib here, since the client is the surface that owns it.
//
// This test is the whole reason the copy is allowed to exist. BUG-FBSHAREDENYLIST-001 WAS two
// strippers diverging: the client got the allowlist + truncate-at-EOI rewrite and the Lambda kept
// the older denylist, so the weakest strip in the repo guarded the one path that publishes a photo
// publicly. Drift here is not a style problem, it is that bug recurring.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CANONICAL = join(here, '..', 'src', 'lib', 'imageMetadataStrip.js');
const DIRS = ['facebook-share'];

describe('imageMetadataStrip.js per-Lambda copies stay in sync with canonical', () => {
  const canonical = readFileSync(CANONICAL, 'utf8');
  for (const d of DIRS) {
    it(`${d}/imageMetadataStrip.js === canonical src/lib/imageMetadataStrip.js`, () => {
      const copy = readFileSync(join(here, d, 'imageMetadataStrip.js'), 'utf8');
      expect(copy).toBe(canonical);
    });
  }

  // Coverage floor, mirroring the sibling sync tests. A hand-maintained DIRS fails OPEN: a dir that
  // starts shipping a copy produces no test at all, and its drift stays invisible in a green suite.
  // Turns red on the mutation `cp src/lib/imageMetadataStrip.js lambda/photos/` — a copy in an
  // unlisted dir.
  it('DIRS enumerates EVERY dir that ships an imageMetadataStrip.js copy', () => {
    const onDisk = readdirSync(here, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((d) => existsSync(join(here, d, 'imageMetadataStrip.js')))
      .sort();
    expect(onDisk).toEqual([...DIRS].sort());
  });

  // The copy carries browser-shaped code the Lambda never calls (FileReader in readBytes, File/Blob
  // in rewrap, console.warn in stripImageFile). Those sit inside function bodies, so the module
  // LOADS on a DOM-free runtime — but this whole suite runs under jsdom, where every one of those
  // globals exists, so nothing here would ever notice if one migrated to module scope. Spawn a real
  // bare `node` instead: no jsdom, no globals, exactly the shape of the Lambda runtime. The failure
  // this catches is a cold-start crash on a path Dave only exercises when he posts to the Page, and
  // a string search for the identifiers is not a substitute (it matches `stripImageFile(`).
  it('the copy loads and strips under a DOM-free node, not just under jsdom', () => {
    const copyUrl = pathToFileURL(join(here, 'facebook-share', 'imageMetadataStrip.js')).href;
    // SOI, APP1 EXIF, SOS, 1 scan byte, EOI, then 4 trailer bytes past the EOI.
    const jpeg = [0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0xFF, 0xDA, 0x00, 0x03, 0x00, 0x77, 0xFF, 0xD9, 0xDE, 0xAD, 0xBE, 0xEF];
    const script = `
      for (const g of ['document','window','FileReader']) {
        if (typeof globalThis[g] !== 'undefined') { console.error('not DOM-free: ' + g); process.exit(2); }
      }
      import(${JSON.stringify(copyUrl)}).then((m) => {
        const r = m.stripJpegBytes(Uint8Array.from(${JSON.stringify(jpeg)}));
        process.stdout.write(JSON.stringify({ len: r.out.length, trailer: r.truncatedTrailer }));
      }).catch((e) => { console.error(String(e && e.message)); process.exit(1); });
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    // 24 in = SOI(2) + APP1(10) + SOS(5) + scan(1) + EOI(2) + trailer(4). The APP1 fails the
    // allowlist and the trailer is past the EOI, so 10 come out and 4 are reported truncated.
    expect(JSON.parse(out)).toEqual({ len: 10, trailer: 4 });
  });
});
