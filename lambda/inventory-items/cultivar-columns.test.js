// OPS-SCHEMAAUDITJOIN-001 — the public.cultivar columns lambda/inventory-items reads.
//
// Three statements in index.js, all the same two-column join: a seed packet resolves the
// cultivar it holds so the item can be labelled. The narrowest cultivar contract in the repo,
// and note the alias is `pv` even though the relation is the VIEW, not plant_varieties — the
// guard below binds columns by what the alias is bound TO, not by what it is called.
//
// cultivar is a VIEW over plant_varieties, so a column dropped from the view is a 500 at
// runtime with nothing failing at deploy time — that is BUG-SEEDDETAIL500-001's exact shape,
// and the reason a view gets a column contract at all.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN select-columns.test.js: parse_test_file returns on the
// keyed AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:128-137), so dropping a keyed block into an existing contract
// file SILENTLY DESTROYS that file's own coverage. Always a new file.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN
// directory — it groups by Path(handler).parent — and only when the AUDIT_COLUMNS literal is in
// this file's own source text, because parse_test_file does read_text() then regex. A shared
// contract module is invisible to it, which is why a relation several Lambdas JOIN needs a
// contract in each of their directories rather than one in a common place.
//
// Static source inspection rather than import: these handlers load @neondatabase/serverless and
// @clerk/backend at module scope and cannot be imported in the unit suite.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. The `--(\s.*)?$` arm matches a BARE `--`
// separator line as well as `-- text`; the `--\s.*$` form that 156 other files in this repo carry
// does not, and a surviving `--` hides the CTE declaration that follows it
// (scripts/dev-main-schema-audit.py:261-273).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk rather
// than hardcoded, so a handler added here that JOINs cultivar is covered the day it lands
// instead of the day someone remembers to extend a list.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract. Every column below verified present on public.cultivar in live prod Neon on
// 2026-08-29 (42 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
// `crop_type_slug` added 2026-09-03 for V5-SEEDSAVEDFILTER-001 (the Saved Seeds crop facet).
// VERIFIED THE WAY THIS FILE REQUIRES, not the cheap way: read from `information_schema.columns`
// WHERE table_name='cultivar' against live prod, so it is confirmed on the VIEW rather than on the
// `plant_varieties` base table underneath it. That is the whole point of this contract — a column
// that exists on the base table and not on the view is a runtime 500 that nothing catches at deploy
// (BUG-SEEDDETAIL500-001, whose three columns are named at the bottom of this file).
// V5-SEEDCARDS-001 (2026-09-19) — the seed list now projects the facts a seed card shows. Each of
// these was read from information_schema.columns WHERE table_name='cultivar' on live prod the same
// day (the VIEW, not the base table): breeding_system, days_to_maturity_min/max, dtm_basis,
// origin_country, origin_region, scoville_min/max, source_url, species.
// V5-SEEDCARDS-001 (2026-09-19) — scoville_source added beside the two numbers, so an estimated
// figure renders as "est. ... SHU". NOT YET ON PROD: it arrives with migrations/v5-scovillesource-001,
// which appends it to the cultivar VIEW (not only to plant_varieties) and must be applied to staging
// and prod before this reaches dev. Until then dev-main-schema-audit.py reports exactly this one
// column missing from prod, and that report is the ordering guard working.
// V5-SEEDMULTIPARENT-001 (release 2a, 2026-10-06) — four more, and they are not all alike:
//   • variety_rank — the rank of the variety a lot is FILED under (every lot projection) and of each
//     parent planting's variety (source_plants). On the view since v5-varietyhybridflag-001; it is
//     column 46 of the 47 in migrations/v5-scovillesource-001/0a-additive-ddl.sql:147.
//   • created_by, deleted_at — read ONLY of the variety a lot is filed under (alias fv): a mixed jar
//     must be filed under a LIVE mix the HOUSEHOLD made, and a re-file needs a live target. Both are
//     in that same 47-column list (:115, :118). The parent-planting alias (pv) never reads either —
//     a soft-deleted variety still counts as a planting's variety — and a test below pins that.
//   • blend_key — NOT YET ON PROD. It arrives with migrations/v5-varietyblend-001, which appends it
//     to the cultivar VIEW (48th column, last), and that migration must be applied to staging and
//     prod before this reaches dev. Until then dev-main-schema-audit.py reports exactly this one
//     column missing from prod, which is the ordering guard working. It is read only by statements
//     a request with TWO OR MORE parent plantings issues (seed-lot-rules.js); a one-parent save and
//     every read on this page are free of it — pinned below, because that is what keeps the
//     commonest writes from depending on the new column.
// These four were read from the migration TEXT, not from information_schema: this lane opens no
// database. The first three are in a view definition captured verbatim from prod on 2026-09-19;
// the fourth is lane S's contract (R2A-CONTRACT section 1). The integration lane runs the audit.
const AUDIT_COLUMNS = {
  cultivar: [
    'blend_key', 'breeding_system', 'created_by', 'crop_type_slug', 'days_to_maturity_max',
    'days_to_maturity_min', 'deleted_at', 'display_name', 'dtm_basis', 'id', 'origin_country',
    'origin_region', 'scoville_max', 'scoville_min', 'scoville_source', 'source_url', 'species',
    'variety_rank',
  ],
};

const CULTIVAR_COLUMNS = AUDIT_COLUMNS.cultivar;

// Extraction mirrors scripts/dev-main-schema-audit.py:238-286 so this guard sees the same
// statements Phase 4 credits. Only SQL inside a tagged sql`` template counts.
const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
// `IS [NOT] DISTINCT FROM x.col` contains the literal token FROM. Scrub it BEFORE scanning or the
// operator's right-hand alias is captured as a relation — that is where the auditor's `l` phantom
// came from (dev-main-schema-audit.py:239-242).
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

// Regex literals are re-created on every evaluation, so each call gets a fresh lastIndex. The alias
// group is OPTIONAL: an unaliased `FROM public.cultivar WHERE ...` captures the next keyword,
// which NOT_AN_ALIAS rejects and UNALIASED_ARMS then has to account for by hand.
const bindings = (s) => [...s.matchAll(
  /\b(?:FROM|JOIN)\s+(?:public\.)?cultivar\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?/gi,
)].map((m) => (m[1] ?? '').toLowerCase());

const NOT_AN_ALIAS = new Set([
  'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
  'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
]);

const aliasesOf = (s) => [...new Set(bindings(s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
const unaliasedIn = (s) => bindings(s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;

// Scoped to statements that BIND cultivar, so an `x.col` belonging to some other query in the
// same file can never be read as this table's.
const columnsOf = (s) => [...new Set(aliasesOf(s).flatMap((a) => [...s.matchAll(
  new RegExp(String.raw`\b${a}\.([a-z_][a-z0-9_]*)\b`, 'gi'),
)].map((m) => m[1].toLowerCase())))];

const STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)]
    .map((m) => m[1].replace(DISTINCT_FROM, ' '))
    .filter((s) => bindings(s).length > 0)
    .map((sql) => ({ file: f, sql }));
});

// Reads that name cultivar with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/inventory-items cultivar column contract', () => {
  it('finds the cultivar statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    // 3 -> 4 with V5-SEEDMULTIPARENT-001: seed-lot-parents.js readSourcePlants LEFT JOINs the
    // cultivar of each parent PLANTING (pv.id, pv.display_name, pv.breeding_system — all three
    // already in the contract above, so the list did not move). The other three are index.js's
    // seed reads, which the two per-statement tests below still pin at exactly three.
    //
    // 4 -> 11 with release 2a, counted by file so a twelfth cannot hide in the total:
    //   index.js            5  the three seed reads, plus the POST's and the wide PUT's RETURNING,
    //                          each of which now reads the filed variety's rank in a scalar subquery;
    //   seed-lot-parents.js 1  readSourcePlants, as before (two more columns of the same join);
    //   seed-lot-rules.js   3  the rules' read of each planting's variety, the "is the lot filed
    //                          under their mix" check, and the judge inside the transaction;
    //   seed-lot-filing.js  2  the filing judge (the target, and the parents' crop) and the read-back.
    //
    // 11 -> 12 with release 3 (V5-SEEDLOTADDITION-001):
    //   seed-lot-additions.js 1  readOpenLots, the read behind GET /seed-lots-open. It binds the view
    //                          three times, each in a scope of its own and each as `pv`: the planting's
    //                          variety (its crop), the variety the lot is filed under (name, rank,
    //                          crop) and each parent planting's variety (its crop). Four columns, all
    //                          already in the contract above, so the list did not move. No blend_key,
    //                          no `fv`, and no liveness or ownership test of a variety.
    expect(STATEMENTS).toHaveLength(12);
    const perFile = Object.fromEntries(HANDLERS.map((f) => [f, STATEMENTS.filter((s) => s.file === f).length]));
    expect(Object.fromEntries(Object.entries(perFile).filter(([, count]) => count > 0))).toEqual({
      'index.js': 5, 'seed-lot-additions.js': 1, 'seed-lot-filing.js': 2, 'seed-lot-parents.js': 1, 'seed-lot-rules.js': 3,
    });
    const openLots = STATEMENTS.find((s) => s.file === 'seed-lot-additions.js').sql;
    expect(bindings(openLots)).toEqual(['pv', 'pv', 'pv']);
    expect(columnsOf(openLots).sort()).toEqual(['crop_type_slug', 'display_name', 'id', 'variety_rank']);
    // Two aliases, and they mean two different rows: `pv` is the variety a row resolves through
    // (the lot's, or a parent planting's); `fv` is the variety a lot is, or is about to be, FILED under.
    expect([...new Set(STATEMENTS.flatMap((s) => aliasesOf(s.sql)))].sort())
      .toEqual(['fv', 'pv']);
  });

  it('asks liveness and ownership only of the FILED variety — a soft-deleted variety is still a planting\'s variety', () => {
    // R2A-CONTRACT section 3: "a soft-deleted cultivar still counts as the planting's variety here,
    // in the rules below and as a mix component". So no statement may filter the parent-side alias on
    // deleted_at or created_by; those two columns are in the contract for `fv` alone.
    for (const { file, sql } of STATEMENTS) {
      expect(sql, `${file}: pv.deleted_at filters a planting's variety`).not.toMatch(/\bpv\.deleted_at\b/);
      expect(sql, `${file}: pv.created_by scopes a planting's variety`).not.toMatch(/\bpv\.created_by\b/);
    }
    const filed = STATEMENTS.filter(({ sql }) => aliasesOf(sql).includes('fv'));
    expect(filed.map((s) => s.file).sort()).toEqual(['seed-lot-filing.js', 'seed-lot-rules.js', 'seed-lot-rules.js']);
    for (const { file, sql } of filed) expect(sql, file).toMatch(/\bfv\.deleted_at IS NULL\b/);
  });

  it('reads blend_key only in the parent RULES — never in a read, a one-parent write or a re-file', () => {
    // The column does not exist until migrations/v5-varietyblend-001 is applied. Keeping it out of
    // every statement the app issues today means a deploy that got ahead of that migration breaks
    // only requests naming two or more parent plantings, which no shipped client sends.
    const naming = STATEMENTS.filter(({ sql }) => /\bblend_key\b/.test(sql));
    expect(naming.map((s) => s.file)).toEqual(['seed-lot-rules.js', 'seed-lot-rules.js', 'seed-lot-rules.js']);
    for (const f of ['index.js', 'seed-lot-parents.js', 'seed-lot-filing.js']) {
      const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
      const templates = [...src.matchAll(SQL_TEMPLATE)].map((m) => m[1]);
      expect(templates.filter((t) => /\bblend_key\b/.test(t)), f).toEqual([]);
    }
  });

  it('projects the filed variety\'s rank on all five lot projections in index.js', () => {
    // Release 2a: list (both templates), detail, and the POST and wide-PUT replies. The union above
    // stays green if one of them drops it, so it is pinned per statement.
    const inIndex = STATEMENTS.filter((s) => s.file === 'index.js');
    expect(inIndex).toHaveLength(5);
    for (const { sql } of inIndex) expect(sql).toMatch(/\bpv\.variety_rank\b/);
    // The two that are writes read it in RETURNING, off the row as the statement left it.
    const returning = inIndex.filter(({ sql }) => /RETURNING \*, \(SELECT pv\.variety_rank FROM public\.cultivar pv\s+WHERE pv\.id = inventory_items\.variety_id\) AS variety_rank/.test(sql));
    expect(returning).toHaveLength(2);
  });

  it('accounts for every unaliased cultivar read', () => {
    // An unaliased read added without a pin here would slip past columnsOf() entirely and the
    // tightness assertion below would still pass — this count is what closes that hole.
    const bare = STATEMENTS.reduce((n, s) => n + unaliasedIn(s.sql), 0);
    expect(bare).toBe(UNALIASED_ARMS.length);
    for (const arm of UNALIASED_ARMS) {
      const src = decomment(readFileSync(resolve(__dirname, arm.file), 'utf8'));
      expect(arm.pin.test(src), `unaliased arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = [...new Set([
      ...STATEMENTS.flatMap((s) => columnsOf(s.sql)),
      ...UNALIASED_ARMS.flatMap((a) => a.columns),
    ])].sort();
    expect(referenced.length).toBeGreaterThan(0);
    // Both directions. Extra columns are not harmless padding: the contract is what Phase 1 audits
    // against prod, so a column nothing reads makes the audit assert something the code never does.
    expect(referenced).toEqual([...CULTIVAR_COLUMNS].sort());
  });

  it('projects scoville_source in every statement that projects the scoville numbers', () => {
    // The contract above is a UNION over the directory, so it stays green if one of the three reads
    // drops the source while the other two keep it — and that read would then hand an estimated
    // figure to a card with nothing saying it is one (v5-scovillesource-001). Pinned per statement.
    const withNumbers = STATEMENTS.filter(({ sql }) => /\bpv\.scoville_(?:min|max)\b/.test(sql));
    expect(withNumbers).toHaveLength(3);
    for (const { file, sql } of withNumbers) {
      expect(sql, `${file}: a read projects the scoville numbers without their source`)
        .toMatch(/\bpv\.scoville_source\b/);
    }
  });

  it('projects EVERY seed-card fact in each of the three reads (both list templates and by-id)', () => {
    // V5-SEEDCARDS-001. The same union blind spot, for the rest of the facts My seeds' expanded row
    // and the packet card show: a fact dropped from ONE read stays green above while that surface
    // shows it as absent. Pinned per statement (the pre-promote QA pass's mutants L6-L8 survived
    // the whole lambda/ suite without this).
    const FACTS = [
      /\bpv\.scoville_min\b/, /\bpv\.scoville_max\b/, /\bpv\.scoville_source\b/,
      /\bpv\.origin_country\b/, /\bpv\.origin_region\b/, /\bpv\.species\b/, /\bpv\.breeding_system\b/,
      /\bpv\.days_to_maturity_min\b/, /\bpv\.days_to_maturity_max\b/, /\bpv\.dtm_basis\b/,
      /\bpv\.source_url\s+AS\s+variety_source_url\b/, /\bpv\.crop_type_slug\s+AS\s+crop_slug\b/,
    ];
    const withNumbers = STATEMENTS.filter(({ sql }) => /\bpv\.scoville_(?:min|max)\b/.test(sql));
    expect(withNumbers).toHaveLength(3);
    for (const { file, sql } of withNumbers) {
      for (const re of FACTS) expect(sql, `${file}: a seed read is missing ${re}`).toMatch(re);
    }
  });

  it('never reaches for a column that belongs to another table', () => {
    // cultivar is a VIEW over plant_varieties (verified against prod: pg_get_viewdef reads
    // `SELECT id, name AS display_name, ... FROM plant_varieties`), and these five are exactly the
    // traps that creates. The label is `display_name` HERE and `name` on the base table, so `name`
    // resolves through the view to nothing. unit_weights, weight_confidence and weight_source are
    // the three columns the view does NOT project — they exist on plant_varieties and on crop_types,
    // and reading them off this relation is the single most likely way to reproduce
    // BUG-SEEDDETAIL500-001. `variety_id` is the FK POINTING AT this view's id from plants; here the
    // column is plain `id`.
    const NOT_ON_TABLE = ['name', 'unit_weights', 'weight_confidence', 'weight_source', 'variety_id'];
    for (const col of NOT_ON_TABLE) {
      expect(CULTIVAR_COLUMNS).not.toContain(col);
      for (const { file, sql } of STATEMENTS) {
        for (const a of aliasesOf(sql)) {
          expect(sql, `${file}: ${a}.${col} is not a cultivar column`)
            .not.toMatch(new RegExp(String.raw`\b${a}\.${col}\b`, 'i'));
        }
      }
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not a cultivar column`).not.toContain(col);
      }
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block
    // with NO warning and NO skip count, and Phase 4 just keeps counting this relation as
    // uncovered. A misspelled KEY is worse — Phase 1's empty-relation guard returns exit 2 and
    // schema-audit.yml maps exit 2 to a ::warning and exit 0, so one typo silences all four phases
    // behind a green check. Replicate the auditor's own two regexes against this file's own source.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    // The match must stop at the block's OWN `};`, not run on to the next one in the file.
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(['cultivar']);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(CULTIVAR_COLUMNS);
  });
});
