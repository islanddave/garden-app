// DRG-ENGINE-003 V1.1 — auto-capture on photo log (static-source guard, DB-free; L-072/L-181 style).
// A photo logged against a planting must append ONE first-party evidence row, server-side, best-effort.
// Mirrors lambda/evidence-ingest contract enums; per-dir Lambda zips can't cross-import, so guard here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// Isolate the auto-capture block via its unique comment marker (the gate string
// `if (inserted.plant_id) {` also opens the earlier auto-promote block, so anchor on
// the unique DRG comment instead).
//
// BRACE-BALANCED, NOT A FIXED +60 WINDOW. The old bound was `SRC.slice(START, END + 60)`, which
// stopped ~20 characters past the catch's log line — INSIDE the `if (inserted.plant_id)` block it
// claims to describe. The append-only assertions below are NEGATIVE, so anything after that point
// was unreachable to them.
// MUTATION that this closes: add
//   await sql`DELETE FROM public.evidence WHERE photo_ref = ${inserted.id} AND source = 'photo_log'`;
// immediately after the catch, still inside the same `if` — a hard DELETE on evidence, i.e. a
// direct Soft-Delete-Only Rule violation in the exact block this file guards — and all 12 tests
// passed. Extending to the closing brace of the gate makes that mutation RED.
const blockFrom = (src, marker) => {
  const start = src.indexOf(marker);
  if (start === -1) return { start, text: '' };
  const open = src.indexOf('{', src.indexOf('if (', start));
  if (open === -1) return { start, text: '' };
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return { start, text: src.slice(start, i + 1) }; }
  }
  return { start, text: '' };
};
const START = SRC.indexOf('auto-capture on photo log');
const END = SRC.indexOf('evidence auto-capture non-fatal failure', START);
const BLOCK = blockFrom(SRC, 'auto-capture on photo log').text;

describe('photos Lambda — DRG evidence auto-capture on photo log', () => {
  it('only fires when the photo links to a planting (inserted.plant_id gate)', () => {
    expect(START).toBeGreaterThan(-1);
    expect(BLOCK).toMatch(/if \(inserted\.plant_id\) \{/);
  });

  it('resolves the canonical entity_id from the entity registry by planting_ref_id', () => {
    expect(BLOCK).toMatch(/FROM public\.entity ent/);
    expect(BLOCK).toMatch(/ent\.entity_type = 'planting'/);
    expect(BLOCK).toMatch(/ent\.planting_ref_id = \$\{inserted\.plant_id\}/);
    expect(BLOCK).toMatch(/ent\.deleted_at IS NULL/);
  });

  it('is household-scoped (only writes evidence for plantings in the requester household)', () => {
    expect(BLOCK).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('appends ONE evidence row with the V1 contract enums', () => {
    expect(BLOCK).toMatch(/INSERT INTO public\.evidence/);
    expect(BLOCK).toMatch(/'first_party_log', 'local', 'supporting'/);
    expect(BLOCK).toMatch(/'photo_log'/);
    // links the evidence back to the photo + carries the caption as the note
    expect(BLOCK).toMatch(/\$\{inserted\.id\}/);
    expect(BLOCK).toMatch(/\$\{inserted\.caption \?\? null\}/);
    expect(BLOCK).toMatch(/schema_version/);
  });

  it('the extracted block spans the WHOLE gate (guard for the guard)', () => {
    // Every append-only assertion in this file is NEGATIVE, and a `not.toMatch` against an empty
    // or truncated haystack always passes. Pin both ends of the extraction before trusting them.
    // MUTATION: reword either anchor comment (an ordinary edit — they are prose) -> RED here.
    expect(START).toBeGreaterThan(-1);
    expect(END).toBeGreaterThan(-1);
    expect(BLOCK, 'auto-capture block extraction collapsed — the negative assertions below would ' +
      'pass against an empty string').toContain('evidence auto-capture non-fatal failure');
    // The block must reach past the catch to the gate's own closing brace.
    expect(BLOCK.trimEnd().endsWith('}'), 'extraction did not reach the gate\'s closing brace')
      .toBe(true);
  });

  it('is append-only (no UPDATE/DELETE on evidence — Soft-Delete-Only Rule)', () => {
    expect(BLOCK.length, 'empty block — a not.toMatch below would pass vacuously').toBeGreaterThan(400);
    expect(BLOCK).not.toMatch(/UPDATE public\.evidence/);
    // MUTATION: add a `DELETE FROM public.evidence ...` after the catch but still inside the
    // `if (inserted.plant_id)` gate -> RED (was GREEN under the old END+60 window).
    expect(BLOCK).not.toMatch(/DELETE FROM public\.evidence/);
  });

  it('is best-effort + non-fatal (wrapped in try/catch, never throws to caller)', () => {
    expect(BLOCK).toMatch(/try \{/);
    expect(BLOCK).toMatch(/catch \(evErr\)/);
    expect(BLOCK).toMatch(/non-fatal/);
  });

  it('no array spread into a tagged-template param (42P18 guard)', () => {
    expect(BLOCK).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});

// V4-PHOTOCAPTION-001 — the PUT re-tag route must sync an edited caption into the
// upload-time evidence snapshot (note + claim), or DrG reads stale evidence forever.
const SYNC_START = SRC.indexOf('evidence caption sync:');
const SYNC_END = SRC.indexOf('evidence caption sync non-fatal failure', SYNC_START);
// Brace-balanced from the block's own `try {` through its matching `}`, for the same reason as
// BLOCK above: the fixed +60 window stopped inside the statement it was meant to bound, so the
// `not.toMatch(/DELETE FROM public.evidence/)` below could not see a DELETE added after the catch.
const SYNC_BLOCK = (() => {
  if (SYNC_START === -1) return '';
  const open = SRC.indexOf('{', SRC.indexOf('try', SYNC_START));
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) {
        // include the sibling catch clause that closes the try/catch pair
        const close = SRC.indexOf('}', SRC.indexOf('catch (evErr)', i));
        return SRC.slice(SYNC_START, (close === -1 ? i : close) + 1);
      }
    }
  }
  return '';
})();

describe('photos Lambda — PUT caption sync into evidence snapshot', () => {
  it('exists in the PUT route (after the photos UPDATE, before the 200)', () => {
    expect(SYNC_START).toBeGreaterThan(-1);
    const putStart = SRC.indexOf("PUT|PATCH /api/photos/:id");
    expect(putStart).toBeGreaterThan(-1);
    expect(SYNC_START).toBeGreaterThan(putStart);
  });

  it('updates BOTH note and claim from the submitted caption, claim keeping the placeholder fallback', () => {
    expect(SYNC_BLOCK).toMatch(/UPDATE public\.evidence/);
    expect(SYNC_BLOCK).toMatch(/note = \$\{body\.caption \?\? null\}/);
    expect(SYNC_BLOCK).toMatch(/claim = \$\{body\.caption \?\? 'Photo observation'\}/);
  });

  it('is scoped to this photo, the photo_log source, the household, and live rows only', () => {
    expect(SYNC_BLOCK).toMatch(/photo_ref = \$\{photoId\}/);
    expect(SYNC_BLOCK).toMatch(/source = 'photo_log'/);
    expect(SYNC_BLOCK).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    expect(SYNC_BLOCK).toMatch(/deleted_at IS NULL/);
  });

  it('is best-effort + non-fatal (caption save must never fail on evidence sync)', () => {
    expect(SYNC_BLOCK).toMatch(/try \{/);
    expect(SYNC_BLOCK).toMatch(/catch \(evErr\)/);
    expect(SYNC_BLOCK).toMatch(/non-fatal/);
  });

  it('never deletes evidence (Soft-Delete-Only Rule)', () => {
    // Vacuity floor first: this is the file's other `not.toMatch`, and an empty SYNC_BLOCK would
    // satisfy it no matter what the caption-sync path does.
    // MUTATION: reword the `evidence caption sync:` anchor comment -> RED here.
    expect(SYNC_BLOCK, 'caption-sync block extraction collapsed — the negative assertion below ' +
      'would pass against an empty string').toContain('evidence caption sync non-fatal failure');
    expect(SYNC_BLOCK).not.toMatch(/DELETE FROM public\.evidence/);
  });
});
