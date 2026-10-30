// OPS-SCHEMAAUDITJOIN-001 — the public.source / public.source_kind columns lambda/varieties reads.
//
// WHY THIS FILE HAD TO SHIP WITH THE ROUTES AND NOT AFTER THEM: Phase 4 of
// scripts/dev-main-schema-audit.py counts (directory, relation) pairs a handler binds in FROM/JOIN
// that no column contract in that handler's OWN directory declares, and fails when the count
// exceeds scripts/schema-audit-join-baseline.json. V4-SOURCEREG-001 introduced the first two reads
// of these relations anywhere in lambda/, so landing them without this file raises the baseline by
// two — and the L-081 ratchet is a one-way instrument: a new relation gets a contract, the number
// never goes up.
//
// A new relation this directory reads goes in as a key of one of its keyed AUDIT_COLUMNS files, not
// a new file (scripts/count-ratchets.json). Never put both forms in one file: parse_test_file returns on
// the keyed form first, so a keyed block in an AUDIT_TABLES file silently drops that file's tables.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in
// this file's own source text, because parse_test_file does read_text() then regex.
//
// Six statements, every one unaliased, so all six are pinned by hand below. Two of them exist to
// read soft-deleted rows ON PURPOSE and are pinned for that reason: source.match_key is unique only
// among live rows (so the collision probe must see the deleted ones to offer a restore), and
// source_kind.slug is the PRIMARY KEY (so a resurrect would violate it rather than conflict).
//
// Static source inspection rather than import: these handlers load @neondatabase/serverless and
// @clerk/backend at module scope. (source-routes.test.js in this directory does import the handler,
// through the vitest.config.ts stub aliases — but the assertions here are about SQL TEXT, which is
// what the auditor itself reads, and reading it the same way is the point.)
import { describe, it, expect } from 'vitest';
import { ownContract, tableReads } from '../_test-stubs/columnContract.js';

// L-081 KEYED contract. Every column below verified present on live prod Neon 2026-09-04 through
// information_schema.columns (source: 12 columns, source_kind: 7) — EXCEPT instagram_url and
// facebook_url, which v5-sourcecontact-001 adds. That migration must be applied to staging and prod
// before this contract (and the handler that reads them) is promoted, or Phase 1 reds on prod.
// created_by joined with the same change: PATCH /sources/:id reads it to decide who may edit.
// The keyed form binds columns to ONE relation each, so this file cannot assert source's list onto
// source_kind — the cross-product the unkeyed form produces is what made joined relations
// unauditable in the first place.
const AUDIT_COLUMNS = {
  source: ['address', 'created_by', 'deleted_at', 'facebook_url', 'id', 'instagram_url', 'kind', 'locality', 'match_key', 'name', 'notes', 'website_url'],
  source_kind: ['deleted_at', 'display_name', 'slug', 'sort_order'],
};

const RELATIONS = Object.keys(AUDIT_COLUMNS);

// Each relation's statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
// `public.source` is a strict PREFIX of `public.source_kind`; the scanner's trailing \b (it fails before
// `_`) is what keeps the two apart. Without it every source_kind statement also reads as a source
// statement, the counts still add up, and source's contract silently inherits source_kind's columns.
const READS = Object.fromEntries(RELATIONS.map((rel) => [rel, tableReads(import.meta.url, rel)]));

// Reads that name the relation with NO alias. Nothing can attribute their bare identifiers
// automatically, so each arm is PINNED to its literal SQL and its columns are listed by hand. Edit
// the query and the pin stops matching and this file reds, which is the only thing keeping the
// hand-listed columns honest.
const UNALIASED_ARMS = {
  source: [
    {
      file: 'index.js',
      // GET /api/varieties/sources — the list SourcePicker renders. This projection IS the wire
      // contract; deleted_at appears as a filter only and never reaches the client.
      pin: /SELECT id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes\s+FROM public\.source\s+WHERE deleted_at IS NULL\s+ORDER BY name ASC/,
      columns: ['id', 'name', 'kind', 'locality', 'address', 'website_url', 'instagram_url', 'facebook_url', 'notes', 'deleted_at'],
    },
    {
      file: 'index.js',
      // The collision probe for a new source. Reading match_key (a GENERATED column) rather than
      // recomputing the fold in SQL is the point: it is the exact value uq_source_match_key_live
      // indexes. The ABSENCE of a deleted_at filter is also the point and is pinned for it — that
      // index is PARTIAL, so a soft-deleted row does not block the INSERT but IS the row the
      // caller wants restored, and deleted_at is selected here as DATA rather than as a filter.
      pin: /SELECT id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes, deleted_at\s+FROM public\.source\s+WHERE match_key = \$\{matchKey\}\s+ORDER BY deleted_at DESC NULLS FIRST\s+LIMIT 1/,
      columns: ['id', 'name', 'kind', 'locality', 'address', 'website_url', 'instagram_url', 'facebook_url', 'notes', 'deleted_at', 'match_key'],
    },
    {
      file: 'index.js',
      // GET /api/varieties/sources/:id — what SourceEdit loads. Live rows only; created_by is NOT
      // projected here, the screen has no use for it.
      pin: /SELECT id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes\s+FROM public\.source\s+WHERE id = \$\{sourceId\}\s+AND deleted_at IS NULL\s+`/,
      columns: ['id', 'name', 'kind', 'locality', 'address', 'website_url', 'instagram_url', 'facebook_url', 'notes', 'deleted_at'],
    },
    {
      file: 'index.js',
      // PATCH /api/varieties/sources/:id, the pre-write read. created_by is read for canEditSource
      // (authz.js) and for nothing else — it never reaches the response.
      pin: /SELECT id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes, created_by\s+FROM public\.source\s+WHERE id = \$\{sourceId\}\s+AND deleted_at IS NULL/,
      columns: ['id', 'name', 'kind', 'locality', 'address', 'website_url', 'instagram_url', 'facebook_url', 'notes', 'created_by', 'deleted_at'],
    },
    {
      file: 'index.js',
      // The rename collision probe. LIVE rows only, unlike the POST probe above: this route never
      // restores, and uq_source_match_key_live is partial, so a soft-deleted namesake blocks nothing.
      pin: /SELECT id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes\s+FROM public\.source\s+WHERE match_key = \$\{newKey\}\s+AND deleted_at IS NULL\s+AND id <> \$\{sourceId\}\s+LIMIT 1/,
      columns: ['id', 'name', 'kind', 'locality', 'address', 'website_url', 'instagram_url', 'facebook_url', 'notes', 'match_key', 'deleted_at'],
    },
  ],
  source_kind: [
    {
      file: 'index.js',
      // The FK check on POST /sources. Deliberately narrower than the FK itself: a soft-deleted
      // kind still satisfies fk_source_kind, so leaving this to the constraint would let a source
      // be typed to a retired kind.
      pin: /SELECT slug FROM public\.source_kind WHERE slug = \$\{kind\} AND deleted_at IS NULL/,
      columns: ['slug', 'deleted_at'],
    },
    {
      file: 'index.js',
      // The same check on PATCH /sources/:id (V5-SOURCECONTACT-001), byte-identical. Pinned as the
      // SECOND occurrence so each of the two unaliased reads has its own arm.
      pin: /SELECT slug FROM public\.source_kind WHERE slug = \$\{kind\} AND deleted_at IS NULL[\s\S]*SELECT slug FROM public\.source_kind WHERE slug = \$\{kind\} AND deleted_at IS NULL/,
      columns: ['slug', 'deleted_at'],
    },
    {
      file: 'index.js',
      // GET /api/varieties/source-kinds — the vocabulary the picker's kind control renders.
      // sort_order exists only for this ordering; nothing else in the repo reads it.
      pin: /SELECT slug, display_name, sort_order\s+FROM public\.source_kind\s+WHERE deleted_at IS NULL\s+ORDER BY sort_order ASC, display_name ASC/,
      columns: ['slug', 'display_name', 'sort_order', 'deleted_at'],
    },
    {
      file: 'index.js',
      // The collision set for a newly minted kind, and the one read that must see EVERYTHING.
      // Two different subsets come out of it: slugs from every row (slug is the PK, so a
      // soft-deleted row still occupies it) and labels from the live rows only
      // (uq_source_kind_display_live is PARTIAL). display_name is read here as the LABEL FOLD
      // input, not for display.
      pin: /const allKinds = await sql`SELECT slug, display_name, sort_order, deleted_at FROM public\.source_kind`;/,
      columns: ['slug', 'display_name', 'sort_order', 'deleted_at'],
    },
    {
      file: 'index.js',
      // sort_order for a mint, computed by Postgres inside the INSERT so it cannot be bound wrong.
      // max + 10, NOT the column default of 0: the twelve seeded kinds occupy 10..120 and a 0
      // would sort every minted kind above all of them.
      pin: /\(SELECT coalesce\(max\(sort_order\), 0\) \+ 10 FROM public\.source_kind\)/,
      columns: ['sort_order'],
    },
  ],
};

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/varieties source + source_kind column contract', () => {
  it('finds the statements, so the assertions below are not vacuous', () => {
    expect(READS.source.handlers.length).toBeGreaterThan(0);
    // Exact counts, not floors: a new statement against either table should be reviewed against the
    // contract rather than inherit it. Update these in the same commit that adds one.
    // source 2 -> 5 and source_kind 4 -> 5 on 2026-09-29 (V5-SOURCECONTACT-001): GET + PATCH
    // /sources/:id add the by-id read, the pre-write read, the rename probe, and a second live-kind
    // check (the PATCH's copy of the POST's).
    expect(READS.source.statements).toHaveLength(5);
    expect(READS.source_kind.statements).toHaveLength(5);
  });

  it('keeps public.source and public.source_kind apart despite the prefix', () => {
    // The failure this guards is silent: a prefix match would make every source_kind statement also
    // count as a source statement and hand source's contract four columns it never reads.
    const sourceSql = READS.source.statements.map((s) => s.sql);
    expect(sourceSql.every((s) => /public\.source\b/.test(s))).toBe(true);
    expect(sourceSql.some((s) => /public\.source_kind\b/.test(s))).toBe(false);
  });

  for (const rel of RELATIONS) {
    it(`${rel}: accounts for every unaliased read`, () => {
      // An unaliased read added without a pin here would slip past columnsOf() entirely and the
      // tightness assertion below would still pass — this count is what closes that hole.
      expect(READS[rel].unaliased).toBe(UNALIASED_ARMS[rel].length);
      for (const arm of UNALIASED_ARMS[rel]) {
        expect(READS[rel].pinHolds(arm), `unaliased arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
      }
    });

    it(`${rel}: references no column absent from the contract, and declares none it does not use`, () => {
      const referenced = READS[rel].referenced(UNALIASED_ARMS[rel]);
      expect(referenced.length).toBeGreaterThan(0);
      // Both directions. An extra column is not harmless padding: the contract is what Phase 1
      // audits against prod, so one nothing reads makes the audit assert something the code doesn't.
      expect(referenced).toEqual([...AUDIT_COLUMNS[rel]].sort());
    });
  }

  it('never reaches for a column that belongs to the OTHER source table', () => {
    // Each of these is a live confusion between the pair. source is keyed by a uuid `id` and its
    // label is `name`; source_kind has NO id at all — `slug` is the PRIMARY KEY and the FK target —
    // and its label is `display_name`. `kind` is what the CHILD column on source is called; on
    // source_kind that same value is `slug`. And `sort_order` orders the vocabulary, not the rows.
    const NOT_ON_TABLE = {
      source: ['display_name', 'slug', 'sort_order'],
      source_kind: ['id', 'name', 'kind', 'locality', 'website_url'],
    };
    for (const rel of RELATIONS) {
      for (const col of NOT_ON_TABLE[rel]) {
        expect(AUDIT_COLUMNS[rel]).not.toContain(col);
        expect(READS[rel].refsTo(col)).toEqual([]);
        for (const arm of UNALIASED_ARMS[rel]) {
          expect(arm.columns, `${arm.file}: ${col} is not a ${rel} column`).not.toContain(col);
        }
      }
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block
    // with NO warning and NO skip count, and Phase 4 just keeps counting these relations as
    // uncovered. A misspelled KEY is worse — Phase 1's empty-relation guard returns exit 2 and
    // schema-audit.yml maps exit 2 to a ::warning and exit 0, so one typo silences all four phases
    // behind a green check. Replicate the auditor's own two regexes against this file's own source.
    const parsed = ownContract(import.meta.url);
    expect(parsed).not.toBeNull();
    expect(parsed.map(([key]) => key)).toEqual(RELATIONS);
    for (const [rel, cols] of parsed) {
      expect(cols).toEqual(AUDIT_COLUMNS[rel]);
    }
  });
});
