// V4-ARCHIVEHIDE-001 (L4) — the bulk entity-tags map must not load ARCHIVED plantings.
//
// This leak measures ZERO rows on prod today (no archived planting currently carries a tag,
// 2026-08-13) and is therefore the one most likely to be deleted as "not a real bug". It is LATENT,
// not absent: tagging any planting and archiving it opens it, and the consumer's happening not to
// look up the extra keys does not satisfy "must not be loaded at all". This file is what keeps the
// predicate from being removed for lack of a visible symptom.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const iBulk = SRC.indexOf('const directRows = await sql`');
const iSingle = SRC.indexOf('const direct = await sql`');
const BULK = SRC.slice(iBulk, iSingle);
const SINGLE = SRC.slice(iSingle);

describe('tags Lambda — archived plantings are excluded from the bulk map (L4)', () => {
  it('the slices are real', () => {
    expect(iBulk).toBeGreaterThan(-1);
    expect(iSingle).toBeGreaterThan(iBulk);
    expect(BULK).toMatch(/const projRows = await sql`/);
  });

  it('both bulk queries (direct + projected) filter archived_at', () => {
    expect((BULK.match(/AND gn\.archived_at IS NULL/g) || []).length).toBe(2);
  });

  it('did not trade the deleted_at axis for the archived_at axis', () => {
    expect((BULK.match(/WHERE gn\.deleted_at IS NULL/g) || []).length).toBe(2);
  });

  // The single-entity read is the planting's OWN detail page — the one route an archived planting
  // still has (lambda/events/index.js: "Deletion hides; archiving does not"). Filtering it would
  // strip the tags off the page you go to in order to unarchive.
  it('does NOT filter the single-entity ?entity_id= read', () => {
    expect(SINGLE).toMatch(/et\.entity_id = \$\{eid\}/);
    expect(SINGLE).not.toMatch(/archived_at/);
  });

  // entityExists() is the WRITE-path authz check for attaching a tag. It is deliberately left alone:
  // gating it on archived_at would make an archived planting's detail page unable to accept a tag,
  // which is a capability removal, not a leak fix.
  it('leaves the write-path existence check unfiltered', () => {
    const i = SRC.indexOf('async function entityExists');
    expect(i).toBeGreaterThan(-1);
    expect(SRC.slice(i, SRC.indexOf('export const handler', i))).not.toMatch(/archived_at/);
  });
});
