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
const START = SRC.indexOf('auto-capture on photo log');
const END = SRC.indexOf('evidence auto-capture non-fatal failure', START);
const BLOCK = (START > -1 && END > -1) ? SRC.slice(START, END + 60) : '';

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

  it('is append-only (no UPDATE/DELETE on evidence — Soft-Delete-Only Rule)', () => {
    expect(BLOCK).not.toMatch(/UPDATE public\.evidence/);
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
const SYNC_BLOCK = (SYNC_START > -1 && SYNC_END > -1) ? SRC.slice(SYNC_START, SYNC_END + 60) : '';

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
    expect(SYNC_BLOCK).not.toMatch(/DELETE FROM public\.evidence/);
  });
});
