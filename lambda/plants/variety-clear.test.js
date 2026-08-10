// Regression guard for the plants-PUT variety clear-fix (happy-adoring-sagan Pending #1).
// Static-source assertion — same rationale as select-columns.test.js: lambda/plants/index.js
// imports @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module load, so there is no
// runtime-handler test seam without a handlers.js split (out of scope). Static inspection is the
// lowest-risk gate for this bug class.
//
// Bug: the PUT handler set `variety_id = COALESCE(${body.variety_id ?? null}, p.variety_id)`.
// COALESCE can SET a variety but cannot CLEAR one — passing variety_id:null collapses back to the
// existing value, so a user can never unset a variety. Fix mirrors the proven featured_photo_id
// CASE: a presence-sentinel (hasVariety = hasOwnProperty 'variety_id') drives
// `CASE WHEN ${hasVariety} THEN ${body.variety_id ?? null} ELSE p.variety_id END` — an explicit
// null clears, an absent key preserves. No explicit casts (matches the in-prod featured_photo_id shape).
//
// Fails loudly if a future edit reverts variety_id to the can't-clear COALESCE form.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('plants Lambda PUT — variety clear-fix (presence-sentinel, not COALESCE)', () => {
  it('declares a hasVariety presence-sentinel via hasOwnProperty on variety_id', () => {
    expect(
      SRC.includes("const hasVariety = Object.prototype.hasOwnProperty.call(body, 'variety_id')"),
      'hasVariety presence-sentinel declaration missing',
    ).toBe(true);
  });

  it('sets variety_id via a CASE driven by hasVariety (an explicit null clears it)', () => {
    expect(
      SRC.includes('WHEN ${hasVariety} THEN ${body.variety_id ?? null}'),
      'variety_id CASE/hasVariety branch missing',
    ).toBe(true);
  });

  it('does NOT set variety_id via the can\'t-clear COALESCE form', () => {
    expect(
      SRC.includes('COALESCE(${body.variety_id ?? null}'),
      'variety_id still uses COALESCE (can SET but never CLEAR)',
    ).toBe(false);
  });

  it('still mirrors the proven featured_photo_id CASE pattern', () => {
    expect(SRC.includes('WHEN ${hasFeatured} THEN ${body.featured_photo_id ?? null}')).toBe(true);
  });
});
