// OPS-L081COLS-001 / V5-NAVCUSTOM-001 — the public.user_notification_prefs columns lambda/critter reads
// and writes, as an L-081 contract scripts/dev-main-schema-audit.py can audit against prod.
//
// WHY NOW: V5-NAVCUSTOM-001 put more_pins and bar_layout into readUserPrefs' explicit SELECT, which runs
// on every user's boot. A critter Lambda that reaches prod before migrations/v5-navcustom-001 500s every
// boot prefs read. The real control is the runbook (prod DDL before the dev push). This file is the cheap
// machine check behind it: Phase 1 of the audit reads the keyed contract below and fails when prod's
// information_schema lacks any listed column. Until now that SELECT was audited by nothing: Phase 2 sees
// INSERT column lists only, and select-columns.test.js here covers critter_state alone (its KNOWN GAP).
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN select-columns.test.js: parse_test_file returns on the keyed
// AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:128-137), so a keyed block dropped into that file would SILENTLY
// DESTROY its critter_state coverage. Same reason app-config-columns.test.js is its own file.
//
// WHY IT HAS TO LIVE IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN directory
// (it groups by Path(handler).parent), and only when the AUDIT_COLUMNS literal is in this file's own
// source text. lambda/events/critterAward.js also reads this table and is NOT covered by this file.
//
// WHAT THIS FILE DOES NOT PROVE: that the columns exist on prod. The list is derived from this
// directory's own SQL (the five statements pinned below); existence is what the auditor checks, and before
// v5-navcustom-001 is applied to prod it reports more_pins and bar_layout missing, which is the point.
//
// Static source inspection rather than import: the contract has to be asserted against the SQL TEXT.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. The `--(\s.*)?$` arm matches a BARE `--`
// separator line as well as `-- text` (scripts/dev-main-schema-audit.py:261-273).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk rather than
// hardcoded, so a handler added here that touches the table is covered the day it lands.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract: every user_notification_prefs column this directory's SQL names, and no other.
// The first seventeen predate V5-NAVCUSTOM-001; more_pins and bar_layout exist only once
// migrations/v5-navcustom-001 is applied.
const AUDIT_COLUMNS = {
  user_notification_prefs: ['created_by', 'critter_visit', 'quiet_hours_start', 'quiet_hours_end', 'coachmark_seen_at', 'opt_in_prompt_seen_at', 'last_garden_view_at', 'garden_group_by', 'garden_sort_order', 'garden_expanded', 'garden_bloom_seen', 'garden_helper_rung1_seen', 'today_skipped', 'log_many_all_selected', 'whats_new_last_seen', 'more_pins', 'bar_layout', 'created_at', 'updated_at'],
};

const PREFS_COLUMNS = AUDIT_COLUMNS.user_notification_prefs;

const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
// `IS [NOT] DISTINCT FROM x.col` contains the literal token FROM (dev-main-schema-audit.py:239-242).
const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;
// Mirrors the auditor's Phase 4 extractor for this one relation. Built fresh on every call, never
// shared: .test() on a /g/ regex advances lastIndex and would skip matches silently.
const relationRe = () => /\b(?:FROM|JOIN)\s+(?:public\.)?user_notification_prefs\b(?!\s*\.)/gi;
// The four upserts write the table. Phase 2 audits their INSERT lists; this contract covers the whole
// statement, because SET and RETURNING name columns too and RETURNING is a read by any other name.
const writeTargetRe = () => /\bINSERT\s+INTO\s+(?:public\.)?user_notification_prefs\b(?!\s*\.)/gi;
// The upserts' COALESCE arms qualify the stored value: public.user_notification_prefs.critter_visit.
const QUALIFIED = /\b(?:public\.)?user_notification_prefs\./gi;

const NAMES_TABLE = (s) => relationRe().test(s) || writeTargetRe().test(s);

// Every statement is unaliased, so nothing can attribute a bare identifier by alias. Instead every
// identifier surviving the removal of the ${...} interpolations, the quoted literals, the relation and
// qualifier references and the words below is treated as a column reference. Fail-closed by
// construction: an identifier this set does not know reads as an unknown column and reds this file.
const SQL_WORDS = new Set([
  'select', 'from', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'lateral',
  'where', 'and', 'or', 'not', 'is', 'null', 'in', 'any', 'all', 'exists', 'between', 'like',
  'ilike', 'as', 'on', 'using', 'order', 'group', 'by', 'having', 'limit', 'offset', 'asc',
  'desc', 'distinct', 'true', 'false', 'case', 'when', 'then', 'else', 'end', 'with', 'public',
  // Write path. `excluded` is the ON CONFLICT pseudo-relation.
  'insert', 'into', 'values', 'conflict', 'do', 'update', 'set', 'excluded', 'returning',
  // Functions and cast targets these statements use.
  'coalesce', 'now', 'time', 'jsonb', 'boolean', 'text',
]);

const STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)]
    .map((m) => m[1]
      .replace(/\$\{[^}]*\}/g, ' ')
      .replace(DISTINCT_FROM, ' ')
      // 'in_app_only', '21:00', '07:00' are values, not identifiers.
      .replace(/'[^']*'/g, ' '))
    .filter(NAMES_TABLE)
    .map((sql) => ({ file: f, sql }));
});

const columnsOf = (s) => [...new Set(
  [...s.replace(relationRe(), ' ').replace(writeTargetRe(), ' ').replace(QUALIFIED, ' ')
    .matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)]
    .map((m) => m[1].toLowerCase())
    .filter((w) => !SQL_WORDS.has(w)),
)].sort();

// Unaliased statements give the mechanical extraction nothing to anchor to except the statements
// themselves. These pins prove the statements it reads are still the ones documented here: edit one and
// its pin stops matching and this file reds, rather than passing on a contract from SQL that is gone.
const PINNED_ARMS = [
  {
    file: 'index.js',
    // readUserPrefs — the boot read (GET /api/notifications/prefs). The statement this file exists for.
    pin: /SELECT critter_visit, quiet_hours_start, quiet_hours_end,[\s\S]*?more_pins, bar_layout,\s+created_at, updated_at\s+FROM public\.user_notification_prefs\s+WHERE created_by = \$\{clerkSub\}\s+LIMIT 1/,
  },
  {
    file: 'index.js',
    // Route 6, POST /api/notifications/garden-view-opened.
    pin: /INSERT INTO public\.user_notification_prefs \(created_by, last_garden_view_at\)\s+VALUES \(\$\{userId\}, now\(\)\)\s+ON CONFLICT \(created_by\) DO UPDATE\s+SET last_garden_view_at = now\(\), updated_at = now\(\)/,
  },
  {
    file: 'index.js',
    // Route 8, PATCH /api/notifications/prefs — the upsert, its COALESCE merge and RETURNING.
    pin: /INSERT INTO public\.user_notification_prefs \(created_by, critter_visit, [^)]*, more_pins, bar_layout\)[\s\S]*?more_pins\s+= COALESCE\(\$\{mp\}::jsonb, public\.user_notification_prefs\.more_pins\)[\s\S]*?RETURNING critter_visit, [\s\S]*?, more_pins, bar_layout, updated_at/,
  },
  {
    file: 'index.js',
    // Route 9, POST /api/notifications/coachmark-dismissed.
    pin: /INSERT INTO public\.user_notification_prefs \(created_by, coachmark_seen_at\)[\s\S]*?RETURNING coachmark_seen_at/,
  },
  {
    file: 'index.js',
    // Route 10, POST /api/notifications/opt-in-dismissed.
    pin: /INSERT INTO public\.user_notification_prefs \(created_by, opt_in_prompt_seen_at\)[\s\S]*?RETURNING opt_in_prompt_seen_at/,
  },
];

describe('OPS-L081COLS-001 — lambda/critter user_notification_prefs column contract', () => {
  it('finds the five statements, so the assertions below are not vacuous', () => {
    expect(HANDLERS.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(STATEMENTS).toHaveLength(PINNED_ARMS.length);
    for (const arm of PINNED_ARMS) {
      const src = decomment(readFileSync(resolve(__dirname, arm.file), 'utf8'));
      expect(arm.pin.test(src), `arm no longer matches in ${arm.file}: ${arm.pin}`).toBe(true);
    }
  });

  it('references no column absent from the contract, and declares none it does not use', () => {
    const referenced = [...new Set(STATEMENTS.flatMap((s) => columnsOf(s.sql)))].sort();
    expect(referenced.length).toBeGreaterThan(0);
    // Both directions. A column nothing reads would make the audit assert something the code never does.
    expect(referenced).toEqual([...PREFS_COLUMNS].sort());
  });

  it('covers every column of the boot read, more_pins and bar_layout included', () => {
    // The statement a missing column breaks for every user at once. Read its SELECT list on its own, so
    // a column added there without a contract entry reds here by name.
    const boot = STATEMENTS.filter((s) => relationRe().test(s.sql));
    expect(boot).toHaveLength(1);
    const selectList = boot[0].sql.match(/SELECT([\s\S]*?)FROM/i)[1]
      .split(',').map((c) => c.trim().toLowerCase());
    expect(selectList).toContain('more_pins');
    expect(selectList).toContain('bar_layout');
    expect(selectList.filter((c) => !PREFS_COLUMNS.includes(c))).toEqual([]);
  });

  it('never names can_edit_bar — it is computed per request and never stored (CONTRACT §2)', () => {
    expect(PREFS_COLUMNS).not.toContain('can_edit_bar');
    for (const { file, sql } of STATEMENTS) {
      expect(sql, `${file}: can_edit_bar is not a column`).not.toMatch(/\bcan_edit_bar\b/i);
    }
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    // The terminating `};` is mandatory: without it _AUDIT_COLUMNS_DECL ignores the whole block with NO
    // warning and NO skip count. A misspelled KEY is worse: Phase 1's empty-relation guard returns exit 2
    // and schema-audit.yml maps exit 2 to a ::warning and exit 0, so one typo silences all four phases
    // behind a green check. Replicate the auditor's own two regexes against this file's own source.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    // The match must stop at the block's OWN `};`, not run on to the next one in the file.
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(['user_notification_prefs']);
    const cols = [...pairs[0][2].matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
    expect(cols).toEqual(PREFS_COLUMNS);
  });
});
