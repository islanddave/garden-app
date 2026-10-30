// OPS-SCHEMAAUDITJOIN-001 — the public.crop_types columns lambda/varieties reads.
//
// Six statements. Four are unaliased, so those four are pinned by hand below; the two in
// crop-type-admin.js (V4-CROPTYPERETIRE-001) alias the table `ct` and are read automatically. This is
// crop_types' home directory: index.js owns the /api/varieties/crop-types route that lists,
// mints, and restores types, and it is the only reader of category and sort_order. One pin is
// deliberately the query with NO deleted_at filter — the collision set for a new slug must
// include soft-deleted rows, because slug is the PK and a resurrect would violate it rather
// than conflict (index.js:159-161). Note the INSERT and the restore UPDATE in the same route
// are outside this contract by construction: Phase 4 and the bindings() scan below both look
// only at FROM/JOIN, and INSERT column lists are Phase 2's job.
//
// A new relation this directory reads goes in as a key of one of its keyed AUDIT_COLUMNS files, not
// a new file (scripts/count-ratchets.json). Never put both forms in one file: parse_test_file returns on
// the keyed form first, so a keyed block in an AUDIT_TABLES file silently drops that file's tables.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in
// this file's own source text, because parse_test_file does read_text() then regex. A shared
// contract module is invisible to it, which is why a relation several Lambdas JOIN needs a
// contract in each of their directories rather than one in a common place.
//
// Static source inspection rather than import: lambda/_test-stubs make the handlers importable, but
// the stub never evaluates SQL, so the columns a statement names are visible only in its source text.
import { describe, it, expect } from 'vitest';
import { ownContract, tableReads } from '../_test-stubs/columnContract.js';

// L-081 KEYED contract. Every column below verified present on public.crop_types in live prod Neon on
// 2026-08-29 (24 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
// OPS-CROPTYPEALIASCLIENT-001 adds search_aliases. It was already contracted in the DASHBOARD
// directory's copy of this file (added by migration v4-croptypealias-001, verified present on prod
// AND staging 2026-08-28); this Lambda began reading it when the crop-types vocab route widened its
// projection so a client filter can finally answer "cantaloupe".
//
// V4-CROPTYPERETIRE-001 adds four keys. crop-type-admin.js counts the rows of every table with a
// foreign key to crop_types(slug) before it lets a type be retired, and four of those tables had no
// reader in this directory until then (plant_varieties, the fifth, is read through public.cultivar and
// has its own contract file). The counts take deleted rows too, so deleted_at is NOT read off any of
// the four and is not listed. Columns per migrations/: preservation_log v4-putup-001 0a :72,
// pantry_item v5-pantry-001 0a :89, kitchen_batch_input v5-putupmake-001 0a (batch_id,
// crop_type_slug :255), preservation_source v5-putupmultisource-001 0a :200. Not read from a live
// database by the lane that added them.
const AUDIT_COLUMNS = {
  crop_types: ['category', 'default_lifecycle', 'deleted_at', 'display_name', 'dtm_basis', 'search_aliases', 'slug', 'sort_order'],
  kitchen_batch_input: ['batch_id', 'crop_type_slug'],
  pantry_item: ['crop_type_slug'],
  preservation_log: ['crop_type_slug'],
  preservation_source: ['crop_type_slug'],
};

const CROP_TYPES_COLUMNS = AUDIT_COLUMNS.crop_types;

// The crop_types statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'crop_types');

// Reads that name crop_types with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [
  {
    file: 'crop-derive.js',
    // The crop-type vocabulary the deriver matches a free-text name against. Soft-deleted types
    // are excluded here — unlike the mint path in varieties/index.js, deriving must not resolve
    // to a retired type.
    pin: /SELECT slug, display_name, default_lifecycle FROM public\.crop_types WHERE deleted_at IS NULL/,
    columns: ['slug', 'display_name', 'default_lifecycle', 'deleted_at'],
  },
  {
    file: 'index.js',
    // GET /api/varieties/crop-types — the controlled vocabulary the planting form renders.
    // sort_order and category exist only for this list; nothing else in the repo reads them.
    // search_aliases is the OPS-CROPTYPEALIASCLIENT-001 widening: it is matched against but never
    // rendered, which the client half pins (src/__tests__/cropTypeAliasClient.test.jsx). This is
    // the only response shape in the repo that carries the column — the dashboard's search SELECTs
    // still must not, and lambda/dashboard/crop-types-columns.test.js still asserts that.
    pin: /SELECT slug, display_name, default_lifecycle, category, sort_order, dtm_basis, search_aliases\s+FROM public\.crop_types\s+WHERE deleted_at IS NULL\s+ORDER BY sort_order ASC, display_name ASC/,
    columns: ['slug', 'display_name', 'default_lifecycle', 'category', 'sort_order', 'dtm_basis', 'search_aliases', 'deleted_at'],
  },
  {
    file: 'index.js',
    // The collision set for a newly minted slug. The ABSENCE of a deleted_at filter is the
    // point and is pinned for that reason: slug is the primary key, so a soft-deleted row still
    // occupies it and a mint that ignored it would hit a PK violation instead of the restore
    // path below (index.js:159-161).
    pin: /const allSlugs = await sql`SELECT slug FROM public\.crop_types`;/,
    columns: ['slug'],
  },
  {
    file: 'index.js',
    // The steer-to-existing read after resolveCropTypeName finds a collision. It selects
    // deleted_at as DATA rather than as a filter — that value is what decides between restoring
    // the row and telling the caller the type already exists.
    pin: /SELECT slug, display_name, default_lifecycle, category, sort_order, deleted_at\s+FROM public\.crop_types WHERE slug = \$\{verdict\.existingSlug\}/,
    columns: ['slug', 'display_name', 'default_lifecycle', 'category', 'sort_order', 'deleted_at'],
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/varieties crop_types column contract', () => {
  it('finds the crop_types statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(READS.statements).toHaveLength(6);
    expect(READS.aliases)
      .toEqual(['ct']);
  });

  it('accounts for every unaliased crop_types read', () => {
    // An unaliased read added without a pin here would slip past columnsOf() entirely and the
    // tightness assertion below would still pass — this count is what closes that hole.
    expect(READS.unaliased).toBe(UNALIASED_ARMS.length);
    for (const arm of UNALIASED_ARMS) {
      expect(READS.pinHolds(arm), `unaliased arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = READS.referenced(UNALIASED_ARMS);
    expect(referenced.length).toBeGreaterThan(0);
    // Both directions. Extra columns are not harmless padding: the contract is what Phase 1 audits
    // against prod, so a column nothing reads makes the audit assert something the code never does.
    expect(referenced).toEqual([...CROP_TYPES_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these exist on crop_types, and each is a live confusion. This table has NO id at all —
    // `slug` is the PRIMARY KEY and the FK target of plant_varieties and preservation_log, which is
    // why a rename is a resurrect rather than a polite conflict (varieties/index.js:159-161). The
    // label is `display_name`, not `name`. `crop_type_slug` is what the CHILD tables call their FK
    // into here; on this table it is plain `slug`. And the two defaulted columns are
    // `default_lifecycle` and `default_unit` — bare `lifecycle` and `unit` belong to plant_varieties
    // and harvest_log respectively, and reading either off this table would silently be undefined.
    const NOT_ON_TABLE = ['id', 'name', 'crop_type_slug', 'lifecycle', 'unit'];
    for (const col of NOT_ON_TABLE) {
      expect(CROP_TYPES_COLUMNS).not.toContain(col);
      expect(READS.refsTo(col)).toEqual([]);
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not a crop_types column`).not.toContain(col);
      }
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block
    // with NO warning and NO skip count, and Phase 4 just keeps counting this relation as
    // uncovered. A misspelled KEY is worse — Phase 1's empty-relation guard returns exit 2 and
    // schema-audit.yml maps exit 2 to a ::warning and exit 0, so one typo silences all four phases
    // behind a green check. Replicate the auditor's own two regexes against this file's own source.
    const parsed = ownContract(import.meta.url);
    expect(parsed).not.toBeNull();
    expect(parsed.map(([key]) => key)).toEqual(
      ['crop_types', 'kitchen_batch_input', 'pantry_item', 'preservation_log', 'preservation_source'],
    );
    const cols = parsed[0][1];
    expect(cols).toEqual(CROP_TYPES_COLUMNS);
  });

  it('the four dependent-table keys list exactly the columns crop-type-admin.js reads off each', () => {
    // Every read of these four tables in this directory is in crop-type-admin.js and aliased, so the
    // columns are whatever follows each alias there. Both directions, as for crop_types above.
    const src = READS.source('crop-type-admin.js');
    for (const [rel, declared] of Object.entries(AUDIT_COLUMNS).filter(([k]) => k !== 'crop_types')) {
      const aliases = [...new Set([...src.matchAll(
        new RegExp(String.raw`\b(?:FROM|JOIN)\s+(?:public\.)?${rel}\s+([a-z_][a-z0-9_]*)`, 'gi'),
      )].map((m) => m[1]))];
      expect(aliases, `${rel} is not read under one alias`).toHaveLength(1);
      const used = [...new Set([...src.matchAll(
        new RegExp(String.raw`\b${aliases[0]}\.([a-z_][a-z0-9_]*)\b`, 'gi'),
      )].map((m) => m[1].toLowerCase()))].sort();
      expect(used, rel).toEqual([...declared].sort());
      for (const f of READS.handlers.filter((h) => h !== 'crop-type-admin.js')) {
        const other = READS.source(f);
        expect(other, `${f} reads ${rel}; extend this contract`)
          .not.toMatch(new RegExp(String.raw`\b(?:FROM|JOIN)\s+(?:public\.)?${rel}\b`, 'i'));
      }
    }
  });
});
