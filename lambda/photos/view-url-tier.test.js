// V4-TIERBLINDMINT-001 — GET /api/photos/view-url/:id honours a tier.
// Two layers, per repo convention: the pure policy module is EXECUTED for real
// (upload-key-policy.test.js pattern), and the route wiring is pinned with route-scoped source
// anchors bounded by the NEXT route marker — never global-first-match or fixed char offsets.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeViewTier, viewTierKey, PHOTO_VIEW_TIERS } from './viewTier.js';

const here = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` behind made every raw-source guard find its own epitaph and pass. Assertions run
// against decommented source. The `//` arm is URL-safe (the `[^:]` guard keeps `https://` intact).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(join(here, 'index.js'), 'utf8'));

// The view-url arm, bounded by the next route marker (`const heroBody`, which opens the
// space-photos block). Slicing to a fixed offset would silently stop covering the route the moment
// its comment header grew.
function viewUrlBlock() {
  const start = SRC.indexOf('const viewMatch = rawPath.match(');
  expect(start, 'view-url route marker not found').toBeGreaterThan(-1);
  const end = SRC.indexOf('const heroBody = async', start);
  expect(end, 'next route marker (heroBody) not found').toBeGreaterThan(start);
  return SRC.slice(start, end);
}

const PATH = 'plants/abc/def.jpg';

describe('viewTier — closed tier enum, server-owned prefix', () => {
  it('defaults an absent/empty tier to full (every shipped client sends none)', () => {
    expect(normalizeViewTier(undefined)).toBe('full');
    expect(normalizeViewTier(null)).toBe('full');
    expect(normalizeViewTier('')).toBe('full');
  });

  it('accepts exactly the declared tiers and nothing else', () => {
    for (const t of PHOTO_VIEW_TIERS) expect(normalizeViewTier(t), t).toBe(t);
    expect(PHOTO_VIEW_TIERS).toEqual(['full', 'thumb']);
  });

  it('REJECTS an unknown tier rather than coercing it to full', () => {
    // The coercing variant is the dangerous one: it would answer `?tier=thumbnail` with a 200
    // carrying the 3 MB original, i.e. the exact tier-blindness this row closes, plus a hidden typo.
    for (const bad of ['thumbnail', 'FULL', 'Thumb', 'small', 'original', ' thumb']) {
      expect(normalizeViewTier(bad), bad).toBeNull();
    }
  });

  it('is not fooled by non-string or prototype-shaped input', () => {
    for (const bad of ['constructor', '__proto__', 'toString', 0, 1, true, {}, [], ['thumb']]) {
      expect(normalizeViewTier(bad), String(bad)).toBeNull();
    }
  });

  it('applies the thumbs/ prefix SERVER-SIDE for thumb and leaves full untouched', () => {
    expect(viewTierKey(PATH, 'full')).toBe(PATH);
    expect(viewTierKey(PATH, 'thumb')).toBe(`thumbs/${PATH}`);
  });

  it('never interpolates an unvalidated tier into the key (no silent degrade to the original)', () => {
    // Reachable only by a wiring mistake — the route normalizes first. It must fail closed rather
    // than quietly hand back the full original under a tier name nobody declared.
    for (const bad of ['thumbnail', '../../etc', 'thumbs', undefined, null]) {
      expect(viewTierKey(PATH, bad), String(bad)).toBeNull();
    }
  });

  it('passes a falsy storage_path through as null (resolvePhotoViewUrl null handling)', () => {
    for (const t of PHOTO_VIEW_TIERS) {
      expect(viewTierKey(null, t), t).toBeNull();
      expect(viewTierKey('', t), t).toBeNull();
    }
  });

  it('agrees with the thumb key the LIST read paths derive by convention', () => {
    // The convention lives in two places; this is what keeps them one. If a list path ever moves
    // off `thumbs/<storage_path>`, the re-mint must move with it or tiles heal to the wrong object.
    const listKeys = [...SRC.matchAll(/resolvePhotoViewUrl\(`([^`]+)`/g)].map((m) => m[1]);
    expect(listKeys.length, 'no template-literal thumb key found in the list paths').toBeGreaterThan(0);
    for (const k of listKeys) {
      expect(k).toBe('thumbs/${photo.storage_path}');
      expect(viewTierKey('X', 'thumb')).toBe(k.replace('${photo.storage_path}', 'X'));
    }
  });
});

describe('view-url route wiring (V4-TIERBLINDMINT-001)', () => {
  it('presigns the TIER key, never the bare storage_path', () => {
    const block = viewUrlBlock();
    expect(block).toMatch(/const tierKey = viewTierKey\(rows\[0\]\.storage_path, tier\);/);
    expect(block).toMatch(/resolvePhotoViewUrl\(tierKey, \{ presign: getViewUrl, sm \}\)/);
    // The pre-fix form. Its absence is the actual fix; asserting only the positive would still pass
    // if someone left both calls in and used the wrong one.
    expect(block).not.toMatch(/resolvePhotoViewUrl\(\s*rows\[0\]\.storage_path/);
  });

  it('reads ?tier and rejects an unknown one with a 400', () => {
    const block = viewUrlBlock();
    expect(block).toMatch(/normalizeViewTier\(\s*event\.queryStringParameters\?\.tier\s*\)/);
    expect(block).toMatch(/if \(!tier\) return resp\(400/);
  });

  it('validates the tier BEFORE the SELECT (no query on a malformed request)', () => {
    const block = viewUrlBlock();
    expect(block.indexOf('normalizeViewTier(')).toBeLessThan(block.indexOf('SELECT storage_path FROM photos'));
  });

  it('names the minted tier in the 200 body', () => {
    const block = viewUrlBlock();
    expect(block).toMatch(/return resp\(200, \{ view_url: viewUrl, expires_in: 900, tier \}\)/);
  });
});
