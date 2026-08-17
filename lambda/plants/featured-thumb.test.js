// V4-PERFTHEMEA-001 — /api/plants signs the thumbs/ companion, ADDITIVELY.
//
// The Garden tile rendered the featured photo's ORIGINAL into a ~180 CSS-px box because this
// Lambda presigned only the raw storage_path. Measured 2026-08-16 over the 230 live featured
// heroes: originals average 2.97 MB, their thumbs/ derivatives 163 KB — 18.7x.
//
// Static-source, DB-free, for the same reason select-columns.test.js is: lambda/plants/index.js
// imports @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module load, so it is not
// importable from repo root and SQL/handler TEXT is the only thing this tier can assert. Row-level
// behavior is integration-tier and out of scope here by construction.
//
// The failure this guards is a REGRESSION, not the original bug: someone "tidying" featuredPhotoUrls
// back into a single presign, or — worse — repointing featured_photo_view_url at the thumb. The
// second one looks like a smaller diff and silently degrades the planting-detail hero and the
// lightbox to an 800px image, with nothing in the frontend able to tell.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — this file's own header names every string
// it asserts on, so decommenting is what stops it finding its own epitaph and passing.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('the thumb key is SERVER-DERIVED by the shared convention', () => {
  it('derives thumbs/<storage_path> — the same key lambda/photos signs', () => {
    // Byte-for-byte the photos Lambda's shape (`thumbs/${photo.storage_path}`). A divergent prefix
    // or a suffix-style key (a.jpg -> a_thumb.jpg) would presign cleanly and 404 on all 1,241
    // existing derivatives, because presigning never touches S3.
    expect(SRC).toMatch(/resolvePhotoViewUrl\(`thumbs\/\$\{storagePath\}`/);
  });

  it('never accepts a caller-supplied key — the closed upload-key grammar stays closed', () => {
    // The thumb path may only be built from the column the SELECT produced.
    const thumbCalls = SRC.match(/resolvePhotoViewUrl\(`thumbs\/[^`]*`/g) ?? [];
    expect(thumbCalls).toHaveLength(1);
    expect(thumbCalls[0]).not.toMatch(/event|body|queryStringParameters/);
  });

  it('costs no S3 round-trip: no HEAD/existence probe was added', () => {
    // A per-row HeadObject would be 225 S3 calls on Dave's 243-row list — a worse regression than
    // the bug. The thumb stays a HINT and the client degrades on the 404.
    expect(SRC).not.toMatch(/HeadObjectCommand/);
  });
});

describe('the thumb is ADDITIVE — featured_photo_view_url must keep pointing at the original', () => {
  it('signs the raw storagePath and the thumb key as two distinct fields', () => {
    expect(SRC).toMatch(/featured_photo_view_url,\s*featured_photo_thumb_url\]?\s*=/);
    expect(SRC).toMatch(/resolvePhotoViewUrl\(storagePath, \{ presign: getFeaturedPhotoViewUrl, sm \}\)/);
  });

  it('never signs the thumb key INTO featured_photo_view_url', () => {
    // The regression that would silently drop the detail hero and the lightbox to 800px.
    expect(SRC).not.toMatch(/featured_photo_view_url\s*=\s*await\s+resolvePhotoViewUrl\(`thumbs/);
  });

  it('both GET paths (by-id and list) emit the pair', () => {
    const sites = SRC.match(/await featuredPhotoUrls\(row\.featured_photo_storage_path\)/g) ?? [];
    expect(sites, 'the by-id GET and the list GET must BOTH return the thumb; a tile fed by one and '
      + 'a hero fed by the other diverging is how the last thumb bug shipped').toHaveLength(2);
    // And no site may bypass the helper to sign the featured photo by hand.
    expect(SRC).not.toMatch(/featured_photo_view_url = await resolvePhotoViewUrl\(row\./);
  });

  it('a null storage_path yields BOTH fields as null, not a signed thumbs/null', () => {
    expect(SRC).toMatch(/if \(!storagePath\) return \{ featured_photo_view_url: null, featured_photo_thumb_url: null \}/);
  });
});
