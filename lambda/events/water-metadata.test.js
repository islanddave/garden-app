// V4-WATERMATH-001 F0 — watering amount capture (metadata.water_depth) + the batch metadata merge.
//
// These are EXECUTING tests, not source-text assertions. Every function under test is pure, and the
// two things worth pinning are both pure:
//   1. the edge vocabulary check — what a client may put in metadata.water_depth;
//   2. the batch MERGE PRECEDENCE — which of {batch-level, per-row, server} wins each key.
//
// (2) is the whole reason the merge was lifted out of SQL and into JS. The batch INSERT used to
// hardcode `jsonb_build_object('batch_id', …, 'batch_v', 1)` and accept no client metadata at all;
// batch is ~80% of events historically, so chips wired only to the single POST would have captured
// ~0% of real watering. Doing the merge in JS makes that precedence a testable fact rather than an
// argument about `||` associativity inside a 20-line INSERT..SELECT.
//
// The SQL half of the write is one `COALESCE(overrides::jsonb -> p.id::text, default::jsonb)`
// lookup — Postgres behaviour, verified read-only against live Neon, not this file's job.

import { describe, it, expect } from 'vitest';
import {
  validatePostBody,
  validateBatchBody,
  validateEventMetadata,
  buildBatchMetadataPlan,
  stripReservedMetadataKeys,
  WATER_DEPTH_CLASSES,
  WATER_DEPTH_SOURCES,
} from './validators.js';

const BATCH_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const P1 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb1';
const P2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';
const P3 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb3';

const post = (over = {}) => ({ event_type: 'watering', plant_id: P1, ...over });
const batch = (over = {}) => ({
  idempotency_key: 'idem-1',
  event_type: 'watering',
  scope: { type: 'all' },
  ...over,
});

describe('metadata.water_depth vocabulary (single POST)', () => {
  it('accepts every declared class, and records provenance alongside it', () => {
    for (const depth of WATER_DEPTH_CLASSES) {
      for (const source of WATER_DEPTH_SOURCES) {
        expect(
          validatePostBody(post({ metadata: { water_depth: depth, water_depth_source: source } })),
          `${depth}/${source}`,
        ).toBeNull();
      }
    }
  });

  it('rejects a class outside the vocabulary', () => {
    // 'soak' reads like a real answer, which is the point: an unrecognised class does not degrade
    // gracefully downstream — it drops out of every aggregate and becomes indistinguishable from
    // "the user never annotated", the exact signal the 30-day instrumentation gate measures.
    const r = validatePostBody(post({ metadata: { water_depth: 'soak' } }));
    expect(r?.status).toBe(400);
    expect(r.error).toMatch(/water_depth must be one of/);
  });

  it('rejects a non-string class (numeric depth codes are the thing this design rejected)', () => {
    expect(validatePostBody(post({ metadata: { water_depth: 2 } }))?.status).toBe(400);
  });

  it('rejects an unknown provenance value', () => {
    const r = validatePostBody(post({ metadata: { water_depth: 'deep', water_depth_source: 'guess' } }));
    expect(r?.status).toBe(400);
    expect(r.error).toMatch(/water_depth_source must be one of/);
  });

  it('rejects provenance with no class — a row counted as user-set with nothing set', () => {
    const r = validatePostBody(post({ metadata: { water_depth_source: 'user' } }));
    expect(r?.status).toBe(400);
    expect(r.error).toMatch(/requires metadata.water_depth/);
  });

  it('leaves unrelated metadata keys alone (historic pass-through is not narrowed)', () => {
    expect(validatePostBody(post({ metadata: { anything: 'at all', nested: { a: 1 } } }))).toBeNull();
  });

  it('rejects a non-object metadata — every reader does metadata->>key, which silently NULLs on an array', () => {
    expect(validatePostBody(post({ metadata: ['light'] }))?.status).toBe(400);
    expect(validatePostBody(post({ metadata: 'light' }))?.status).toBe(400);
  });

  it('absent metadata stays valid — the zero-added-taps default path', () => {
    expect(validatePostBody(post())).toBeNull();
    expect(validateEventMetadata(null)).toBeNull();
    expect(validateEventMetadata(undefined)).toBeNull();
  });
});

describe('metadata validation on the batch body', () => {
  it('applies the SAME vocabulary to batch-level metadata', () => {
    expect(validateBatchBody(batch({ metadata: { water_depth: 'deep' } }))).toBeNull();
    expect(validateBatchBody(batch({ metadata: { water_depth: 'drenched' } }))?.status).toBe(400);
  });

  it('applies it to every per-row override, not just the first', () => {
    const body = batch({
      plant_metadata: { [P1]: { water_depth: 'light' }, [P2]: { water_depth: 'monsoon' } },
    });
    const r = validateBatchBody(body);
    expect(r?.status).toBe(400);
    expect(r.error).toMatch(/water_depth must be one of/);
  });

  it('requires plant_metadata keys to be UUIDs', () => {
    const r = validateBatchBody(batch({ plant_metadata: { 'not-a-uuid': { water_depth: 'light' } } }));
    expect(r?.status).toBe(400);
    expect(r.error).toMatch(/plant_metadata keys must be plant UUIDs/);
  });

  it('requires plant_metadata values to be objects', () => {
    expect(validateBatchBody(batch({ plant_metadata: { [P1]: 'deep' } }))?.status).toBe(400);
    expect(validateBatchBody(batch({ plant_metadata: [] }))?.status).toBe(400);
  });

  it('a batch with no metadata at all is still valid — nothing about the old contract broke', () => {
    expect(validateBatchBody(batch())).toBeNull();
  });
});

describe('buildBatchMetadataPlan — merge precedence', () => {
  const plan = (over = {}) =>
    buildBatchMetadataPlan({ batchId: BATCH_ID, plantIds: [P1, P2, P3], ...over });

  it('with no client metadata, reproduces the OLD hardcoded object exactly', () => {
    // The regression floor. Before this change every batch row got exactly these two keys; any
    // batch that sends no metadata must still get exactly these two keys and nothing else.
    const { defaultMetadata, overrides } = plan();
    expect(defaultMetadata).toEqual({ batch_id: BATCH_ID, batch_v: 1 });
    expect(overrides).toEqual({});
  });

  it('applies the batch-level chip to the default every row will use', () => {
    const { defaultMetadata } = plan({ metadata: { water_depth: 'deep', water_depth_source: 'user' } });
    expect(defaultMetadata).toEqual({
      water_depth: 'deep', water_depth_source: 'user', batch_id: BATCH_ID, batch_v: 1,
    });
  });

  it('a per-row override beats the batch-level chip FOR THAT ROW ONLY', () => {
    // The core batch UX: one chip for the burst, tap a single row to override it. If the override
    // leaked to the default, one tap would silently rewrite the whole batch.
    const { defaultMetadata, overrides } = plan({
      metadata: { water_depth: 'normal', water_depth_source: 'default' },
      plantMetadata: { [P2]: { water_depth: 'deep', water_depth_source: 'user' } },
    });
    expect(defaultMetadata.water_depth).toBe('normal');
    expect(Object.keys(overrides)).toEqual([P2]);
    expect(overrides[P2].water_depth).toBe('deep');
    expect(overrides[P2].water_depth_source).toBe('user');
  });

  it('a per-row override INHERITS batch-level keys it does not itself set', () => {
    // Override is a patch, not a replacement. A row that overrides only the depth must keep the
    // batch's other keys, or per-row tapping would silently strip data from that row alone.
    const { overrides } = plan({
      metadata: { water_depth: 'normal', note_tag: 'evening-round' },
      plantMetadata: { [P1]: { water_depth: 'light' } },
    });
    expect(overrides[P1]).toEqual({
      note_tag: 'evening-round', water_depth: 'light', batch_id: BATCH_ID, batch_v: 1,
    });
  });

  it('server-owned batch_id/batch_v are UNFORGEABLE from either metadata layer', () => {
    // Not cosmetic: metadata->>'batch_id' is what the undo cascade, the side-effect re-hit lookup
    // and the batch feed all key on. A client-settable batch_id could attach rows to, or detach
    // them from, another batch. Merged LAST at both layers so a forged value cannot survive.
    const { defaultMetadata, overrides } = plan({
      metadata: { batch_id: 'forged-batch', batch_v: 99 },
      plantMetadata: { [P1]: { batch_id: 'forged-row', batch_v: 42 } },
    });
    expect(defaultMetadata.batch_id).toBe(BATCH_ID);
    expect(defaultMetadata.batch_v).toBe(1);
    expect(overrides[P1].batch_id).toBe(BATCH_ID);
    expect(overrides[P1].batch_v).toBe(1);
  });

  it('drops overrides for plantings outside the server-resolved scope', () => {
    // The scope SELECT is the sole authority on which plantings get written. A metadata map must
    // never be able to widen it, nor leave orphan keys that make a 3-row batch look like a 4-row one.
    const OUTSIDE = 'cccccccc-3333-4333-8333-cccccccccccc';
    const { overrides } = plan({ plantMetadata: { [P1]: { water_depth: 'light' }, [OUTSIDE]: { water_depth: 'deep' } } });
    expect(Object.keys(overrides)).toEqual([P1]);
  });

  it('matches plant ids case-insensitively — Postgres renders uuid::text lowercased', () => {
    // The SQL side looks the override up as `overrides -> p.id::text`, and uuid::text is always
    // lowercase. A client echoing an uppercased id would otherwise silently lose its override.
    const { overrides } = plan({ plantMetadata: { [P1.toUpperCase()]: { water_depth: 'deep' } } });
    expect(overrides[P1].water_depth).toBe('deep');
  });

  it('strips the reserved `_` namespace from client-supplied batch metadata', () => {
    // `_skip_critter_award` is an internal bypass the single POST honours. The batch path is a NEW
    // surface; opening a bulk bypass lever at the same moment is not a trade worth making.
    const { defaultMetadata, overrides } = plan({
      metadata: { _skip_critter_award: true, water_depth: 'light' },
      plantMetadata: { [P1]: { _skip_critter_award: true } },
    });
    expect(defaultMetadata._skip_critter_award).toBeUndefined();
    expect(defaultMetadata.water_depth).toBe('light');
    expect(overrides[P1]._skip_critter_award).toBeUndefined();
  });

  it('tolerates junk shapes without throwing (the validator rejects them first, but never assume)', () => {
    expect(stripReservedMetadataKeys(null)).toEqual({});
    expect(stripReservedMetadataKeys(['a'])).toEqual({});
    expect(plan({ metadata: null, plantMetadata: null }).defaultMetadata)
      .toEqual({ batch_id: BATCH_ID, batch_v: 1 });
  });

  it('produces JSON-serialisable output — both halves are bound as ::jsonb parameters', () => {
    const { defaultMetadata, overrides } = plan({
      metadata: { water_depth: 'normal' },
      plantMetadata: { [P1]: { water_depth: 'deep' } },
    });
    expect(JSON.parse(JSON.stringify(defaultMetadata))).toEqual(defaultMetadata);
    expect(JSON.parse(JSON.stringify(overrides))).toEqual(overrides);
  });
});
