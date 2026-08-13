// V4-WATERMATH-001 F0, edit half — the events PUT persists and returns `metadata`.
//
// THE SHAPE OF THE BUG: the POST has always stored body.metadata verbatim (F0 made two of its keys
// load-bearing for the water ledger), but the PUT's SET-list never carried the column and its
// RETURNING never read it back. So EVERY edit — a fixed typo in the notes, a quality star — was a
// metadata event horizon: the row kept its jsonb only because the UPDATE ignored the column, and
// the response blanked the client's copy because EventDetail re-seeds its whole event state from
// the PUT body (setEvent). WATER_DEPTH_EDIT_ENABLED is default-FALSE on exactly this gap (see
// src/lib/featureFlags.js) — flipping it is a separate owner decision, deliberately NOT made here.
//
// Static-source per L-072 house style (the edit-fields.test.js precedent for this same route),
// plus executing tests for the pure resolver that carries the semantics. DB-free.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMetadataArm, CLEARABLE_SET, validateClear } from './clearFields.js';
import { validateEventMetadata } from './validators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const SRC = decomment(RAW);

// The PUT's UPDATE, isolated — same backwards anchoring as edit-fields.test.js, and for the same
// reason: a forward slice from the first `UPDATE event_log el` lands on the PATCH resolve route.
const putUpdate = () => {
  const marker = SRC.indexOf('private_notes = ${body.private_notes');
  expect(marker, 'the PUT SET-list marker must exist').toBeGreaterThan(-1);
  const i = SRC.lastIndexOf('UPDATE event_log el', marker);
  const j = SRC.indexOf('RETURNING el.id', marker);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  const block = SRC.slice(i, j);
  expect(block, 'anchored on the wrong UPDATE').toContain('private_notes');
  expect(block, 'the slice swallowed the PATCH resolve route')
    .not.toContain('resolved_at = COALESCE(el.resolved_at, NOW())');
  return block;
};

// The whole PUT arm, from its route test to its response — for assertions about ordering (the
// validator must run before any SQL) and about the response line itself.
const putArm = () => {
  const i = SRC.indexOf("if (method === 'PUT')");
  expect(i, 'the PUT arm must exist').toBeGreaterThan(-1);
  expect(SRC.indexOf("if (method === 'PUT')", i + 1), 'PUT route test must be unique').toBe(-1);
  const j = SRC.indexOf('return resp(200, { ...updatedRows[0]', i);
  expect(j, 'the PUT response line must exist after the arm start').toBeGreaterThan(i);
  return SRC.slice(i, j + 120);
};

describe('resolveMetadataArm — the HAS-KEY semantics, executed', () => {
  it('absent key preserves: has=false, and the value bind is inert', () => {
    expect(resolveMetadataArm({ event_type: 'watering', notes: 'x' }))
      .toEqual({ has: false, value: null });
  });

  it('explicit null clears: has=true with a NULL value', () => {
    // THE distinction the wire actually carries. JSON.parse is used here (not a literal) because
    // the handler's body comes from JSON.parse(event.body) — this is the exact object shape the
    // route sees, and JSON has no undefined, so has-key vs null is a real, reachable difference.
    expect(resolveMetadataArm(JSON.parse('{"metadata":null}')))
      .toEqual({ has: true, value: null });
  });

  it('an object replaces wholesale — the value passes through untouched', () => {
    const m = { water_depth: 'deep', water_depth_source: 'user', batch_id: 'b-1' };
    const r = resolveMetadataArm({ event_type: 'watering', metadata: m });
    expect(r.has).toBe(true);
    expect(r.value).toBe(m); // same reference: no cloning, no key stripping on the single path
  });

  it('a metadata-free wire body parses to has=false — the regression case, at the wire boundary', () => {
    // A stale PWA bundle (the normal case after a deploy, not an edge case) PUTs the pre-F0 body
    // with no metadata key at all. That must resolve to "leave the column alone".
    expect(resolveMetadataArm(JSON.parse('{"event_type":"watering","title":"fixed typo"}')).has)
      .toBe(false);
  });

  it('degenerate bodies cannot fabricate a write', () => {
    expect(resolveMetadataArm(null)).toEqual({ has: false, value: null });
    expect(resolveMetadataArm(undefined)).toEqual({ has: false, value: null });
    // undefined-under-key is unreachable over the wire; it resolves to clear, same as JSON null.
    expect(resolveMetadataArm({ metadata: undefined })).toEqual({ has: true, value: null });
  });
});

describe('the PUT writes metadata with the HAS-KEY arm', () => {
  it('the SET arm gates on the resolved has-flag and binds the resolved value', () => {
    const b = putUpdate();
    expect(b).toMatch(/metadata\s*= CASE WHEN \$\{meta\.has\}::boolean THEN \$\{meta\.value\}::jsonb/);
  });

  it('the preserve arm reads the pre-update row — absent key keeps el.metadata byte-identical', () => {
    // The regression the mission exists for: a metadata-free PUT (every pre-F0 caller, every save
    // from a stale bundle) must not alter metadata a POST previously stored. In SQL, a SET
    // expression sees the pre-UPDATE row, so ELSE el.metadata is a true no-op on the column.
    expect(putUpdate()).toMatch(/THEN \$\{meta\.value\}::jsonb\s*\n\s*ELSE el\.metadata END/);
  });

  it('never the full-replace grammar, never the COALESCE write-once trap', () => {
    const b = putUpdate();
    // Full-replace (the legacy title/notes grammar) would blank the column on every metadata-free
    // save — the exact opposite of preserve-on-absent.
    expect(b, 'body.metadata must not be bound directly').not.toMatch(/metadata\s*=\s*\$\{body\.metadata/);
    // COALESCE conflates JSON null with absent, making the column write-once-settable
    // (BUG-COALESCECLEAR-001's class) — the explicit-null clear channel would silently die.
    expect(b, 'no COALESCE may carry the metadata bind').not.toMatch(/COALESCE\(\s*\$\{meta\.value\}/);
  });

  it('the value bind carries a jsonb cast — a NULL bind must be typed (Neon)', () => {
    // "could not determine data type of parameter" is a missing-cast error, not a null error; a
    // ::cast always rescues it. The clear case binds NULL, so the cast is load-bearing here.
    expect(putUpdate()).toMatch(/\$\{meta\.value\}::jsonb/);
  });

  it('the vocabulary check is the SHARED validator, called before any SQL runs', () => {
    const arm = putArm();
    const call = arm.indexOf('const metaErr = validateEventMetadata(body.metadata)');
    expect(call, 'the PUT must call the shared validator').toBeGreaterThan(-1);
    expect(arm.slice(call), 'a rejected body must 400 with the validator status/message')
      .toMatch(/if \(metaErr\) return resp\(metaErr\.status, \{ error: metaErr\.error \}\)/);
    // Ordering: validation precedes the ownership pre-read (the first SQL in the arm), so an
    // invalid body costs no queries and cannot half-run the route.
    const firstSql = arm.indexOf('await sql`');
    expect(firstSql).toBeGreaterThan(-1);
    expect(call, 'validateEventMetadata must run before the first query').toBeLessThan(firstSql);
  });

  it('the validator admits both spellings of leave-and-clear', () => {
    // The shared validator must not 400 the clear channel or the absent case; water-metadata
    // tests own the rest of its vocabulary behaviour.
    expect(validateEventMetadata(null)).toBeNull();
    expect(validateEventMetadata(undefined)).toBeNull();
    // And still rejects garbage arriving through the PUT — same rule as the POST, one source.
    expect(validateEventMetadata([1, 2]).status).toBe(400);
    expect(validateEventMetadata({ water_depth: 'soak' }).error).toMatch(/water_depth must be one of/);
  });
});

describe('the PUT returns what it now writes — write and read-back ship together', () => {
  it('RETURNING carries el.metadata', () => {
    const i = SRC.indexOf('RETURNING el.id');
    const block = SRC.slice(i, SRC.indexOf('`', i));
    expect(block, 'RETURNING must carry metadata').toMatch(/el\.metadata/);
  });

  it('the response spreads the returned row, so metadata reaches the client un-stripped', () => {
    // EventDetail replaces its entire event state from this body (setEvent(updated)). A response
    // without metadata blanks the Details block on every save even when the row kept the value —
    // the featureFlags.js WATER_DEPTH_EDIT_ENABLED comment names this exact failure.
    expect(putArm()).toMatch(/return resp\(200, \{ \.\.\.updatedRows\[0\], harvest: harvestRow \}\)/);
  });

  it('the by-id GET still returns e.metadata — the edit form seeds from it', () => {
    const i = SRC.indexOf('e.private_notes,');
    expect(i, 'the by-id GET select marker must be unique and present').toBeGreaterThan(-1);
    expect(SRC.indexOf('e.private_notes,', i + 1), 'marker must be unique').toBe(-1);
    expect(SRC.slice(i, SRC.indexOf('FROM event_log', i))).toMatch(/e\.metadata/);
  });
});

describe('scope pins — what this change deliberately does NOT do', () => {
  it('plant_metadata is not part of the PUT contract', () => {
    // plant_metadata is the batch POST's per-plant fan-out input (validators.js
    // buildBatchMetadataPlan): each fanned-out row lands as its OWN event_log row whose merged
    // metadata was written at create time. A PUT edits exactly one of those rows by id, so its
    // event-level `metadata` key IS the per-plant surface — a plant_metadata key here would have
    // no second row to address. EventDetail sends no such key. Pinned so a future batch-edit
    // feature has to design this on purpose rather than inherit an accidental half-contract.
    expect(putArm()).not.toContain('plant_metadata');
  });

  it('metadata stays OFF the clear:[] allowlist — explicit null is its clear channel', () => {
    expect(CLEARABLE_SET.has('metadata')).toBe(false);
    expect(validateClear(['metadata'], {})).toMatch(/cannot be cleared/);
    expect(putUpdate(), 'no clear arm may exist for metadata')
      .not.toMatch(/@> ARRAY\['metadata'\]/);
  });

  it('WATER_DEPTH_EDIT_ENABLED is not flipped by this change', () => {
    // Requirement 3: the flag flip is a separate owner decision. The lambda side is now ready;
    // the flag stays FALSE until the owner turns it on.
    const flags = readFileSync(resolve(__dirname, '../../src/lib/featureFlags.js'), 'utf8');
    expect(flags).toMatch(/export const WATER_DEPTH_EDIT_ENABLED = false/);
  });

  it('the metadata arm does not touch the side-effect machinery', () => {
    // Requirement 4: column persistence + response shape only. cacheDirty's axes are
    // type/date/flag/anchors — metadata must not join them (entity_memory derives nothing from
    // it), and no reward/award hook exists on the PUT to disturb.
    const arm = putArm();
    const dirty = arm.indexOf('const cacheDirty');
    expect(dirty).toBeGreaterThan(-1);
    const dirtyLine = arm.slice(dirty, arm.indexOf('\n', dirty));
    expect(dirtyLine, 'metadata must not become a cache-dirty axis').not.toContain('meta');
    expect(arm, 'no award hook may appear in the PUT arm').not.toContain('awardCritter');
  });
});
