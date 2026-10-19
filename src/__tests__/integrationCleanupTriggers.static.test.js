// V4-SPACESOFTDEL-001 (multi-space Phase 1, step 1.3a) — static guard: integration code disables no trigger of ANY
// table except the one sanctioned pair, and never drops a trigger on, or the function behind, a spaces/weather guard.
//
// WHY. migrations/v5-spaceguard-001 puts guards on public.spaces (spaces_delete_guard, spaces_truncate_guard,
// spaces_repoint_guard, the trg_audit_spaces_* audit triggers) and BEFORE TRUNCATE guards on weather_daily and
// weather_cold_range. The integration suite runs on a fork of staging (integration-test.yml), so once those
// guards are on staging a teardown that hits one is refused. The fix is to delete the children first
// (tests/integration/_cleanup.js, season-stats.int.test.js). The tempting shortcut is
// `ALTER TABLE spaces DISABLE TRIGGER spaces_delete_guard`: it makes the teardown pass, and DISABLE TRIGGER is a
// catalog change, so on a shared database it lifts the guard for everyone until something re-enables it.
//
// WHAT IT PINS, over every .js/.mjs/.ts file under tests/integration (helpers included, comments stripped):
//   1. every `ALTER TABLE <t> DISABLE TRIGGER <name>` is the one sanctioned pair,
//      cultivar_weight_sample.trg_cws_immutable (_cleanup.js purgeImmutableSamples and the three cal1 files;
//      that trigger makes samples append-only and teardown is the one place allowed to lift it);
//   2. no DISABLE TRIGGER ALL / USER, and no session_replication_role (replica mode silences every trigger);
//   3. no DISABLE TRIGGER this scan cannot attribute to a table and a trigger name (a built-up string);
//   4. the sanctioned pair names none of the guarded tables, so "add it to the list" is not a way round 1;
//   5. no `DROP TRIGGER <name> ON <guarded table>` (or on a table it cannot read), and no `DROP FUNCTION` of a
//      GUARD_FUNCTIONS name. A DROP TRIGGER on any other table is allowed (kitchen-ferment drops its own fixture's).
// Rule 1 is deliberately broad (any table): a future test that needs a reviewed DISABLE adds its pair to SANCTIONED.
// The scanner is a function, and a planted `DISABLE TRIGGER spaces_delete_guard` is run through it below, so a
// scanner that stops matching reds here rather than passing everything.
//
// WHAT IT DOES NOT CATCH: a teardown that deletes in the wrong order. That shows as residue: _cleanup.js
// countFixtureResidue probes spaces and its three CASCADE children, and season-stats asserts its settle().
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

const ROOT = process.cwd()
const INTEGRATION = resolve(ROOT, 'tests/integration')

// Tables whose triggers integration cleanup may never lift. plots: migrations/v5-plottier-001 (multi-space 3.1)
// puts the same three guards on it (plots_delete_guard, plots_truncate_guard, plots_repoint_guard).
const GUARDED_TABLES = ['spaces', 'weather_daily', 'weather_cold_range', 'spacetheme', 'plots']
// The trigger functions behind those guards (migrations/v5-spaceguard-001/0a-guards.sql,
// migrations/v5-plottier-001/0a-plots.sql), including the audit function behind trg_audit_spaces_* and
// trg_audit_plots_ins. Dropping one, CASCADE or not, removes the guard.
const GUARD_FUNCTIONS = ['guard_spaces_delete', 'guard_space_truncate', 'guard_spaces_repoint', 'audit_stmt_insert',
  'guard_plots_delete', 'guard_plots_repoint']
// The only DISABLE TRIGGER integration code may issue, as table.trigger. Adding a pair is a reviewed change to this
// list, and the test below refuses any pair on a guarded table or naming a guard.
const SANCTIONED = ['cultivar_weight_sample.trg_cws_immutable']

function listFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listFiles(p))
    else if (/\.(js|mjs|ts)$/.test(name)) out.push(p)
  }
  return out.sort()
}

// Comments cannot execute: drop block comments and whole-line // comments (a // inside a string, such as a URL,
// is left alone because only lines that START with // are dropped).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n')
}

const unquote = (s) => s.replace(/"/g, '').replace(/^public\./i, '').toLowerCase()

/** Every finding in one source text. Each is a string naming what was found. */
function scanSource(src) {
  const text = stripComments(src)
  const findings = []
  if (/session_replication_role/i.test(text)) findings.push('session_replication_role')
  const disables = [...text.matchAll(/DISABLE\s+TRIGGER\b/gi)]
  const attributed = [
    ...text.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([\w."${}]+)\s+DISABLE\s+TRIGGER\s+([\w"${}]+)/gi),
  ]
  for (const m of attributed) {
    const table = unquote(m[1])
    const trigger = unquote(m[2])
    if (trigger === 'all' || trigger === 'user') findings.push(`${table}: DISABLE TRIGGER ${trigger.toUpperCase()}`)
    else if (!SANCTIONED.includes(`${table}.${trigger}`)) findings.push(`${table}.${trigger}`)
  }
  if (disables.length !== attributed.length) {
    findings.push(`${disables.length - attributed.length} DISABLE TRIGGER not attributable to ALTER TABLE <t> DISABLE TRIGGER <name>`)
  }
  // DROP TRIGGER <name> ON <guarded table>: removes the guard outright. A table this scan cannot read (a built-up
  // string) counts as guarded.
  const drops = [...text.matchAll(/DROP\s+TRIGGER\b/gi)]
  const dropsOn = [...text.matchAll(/DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?([\w"${}]+)\s+ON\s+(?:ONLY\s+)?([\w."${}]+)/gi)]
  for (const m of dropsOn) {
    const table = unquote(m[2])
    if (GUARDED_TABLES.includes(table) || table.includes('${')) findings.push(`DROP TRIGGER ${unquote(m[1])} ON ${table}`)
  }
  if (drops.length !== dropsOn.length) {
    findings.push(`${drops.length - dropsOn.length} DROP TRIGGER not attributable to DROP TRIGGER <name> ON <table>`)
  }
  // DROP FUNCTION of a guard function (CASCADE takes its triggers with it). The statement runs to the next quote,
  // backtick, `;` or line end; a built-up name counts as a guard.
  for (const m of text.matchAll(/DROP\s+FUNCTION\b([^'`;\n]*)/gi)) {
    const stmt = m[1].replace(/"/g, '').toLowerCase()
    for (const fn of GUARD_FUNCTIONS) if (new RegExp(`\\b${fn}\\b`).test(stmt)) findings.push(`DROP FUNCTION ${fn}`)
    if (stmt.includes('${')) findings.push(`DROP FUNCTION not attributable: ${stmt.trim()}`)
  }
  return findings
}

describe('integration cleanup lifts no trigger but the one sanctioned DISABLE, and drops no spaces/weather guard (V4-SPACESOFTDEL-001)', () => {
  it('finds the integration files, so the scan is not vacuous', () => {
    const files = listFiles(INTEGRATION).map((f) => relative(ROOT, f))
    expect(files).toContain('tests/integration/_cleanup.js')
    expect(files).toContain('tests/integration/season-stats.int.test.js')
  })

  it('no file under tests/integration disables any trigger but the sanctioned pair (add one to SANCTIONED in review), or drops a guard', () => {
    const bad = []
    for (const f of listFiles(INTEGRATION)) {
      for (const finding of scanSource(readFileSync(f, 'utf8'))) bad.push(`${relative(ROOT, f)}: ${finding}`)
    }
    expect(bad).toEqual([])
  })

  it('the sanctioned DISABLE is still where it was (the allowance is not stale)', () => {
    const src = stripComments(readFileSync(join(INTEGRATION, '_cleanup.js'), 'utf8'))
    expect(src).toMatch(/ALTER TABLE cultivar_weight_sample DISABLE TRIGGER trg_cws_immutable/)
  })

  it('the sanctioned list names no guarded table and no guard', () => {
    for (const pair of SANCTIONED) {
      const [table, trigger] = pair.split('.')
      expect(GUARDED_TABLES, pair).not.toContain(table)
      expect(trigger, pair).not.toMatch(/spaces|weather|truncate_guard|delete_guard|repoint_guard/)
    }
  })

  // Positive controls: the scanner sees each shape it exists to refuse.
  it.each([
    ["await sql('ALTER TABLE spaces DISABLE TRIGGER spaces_delete_guard')", 'spaces.spaces_delete_guard'],
    ['await directSql`ALTER TABLE public.spaces DISABLE TRIGGER spaces_truncate_guard`', 'spaces.spaces_truncate_guard'],
    ["await sql('ALTER TABLE weather_daily DISABLE TRIGGER weather_daily_truncate_guard')", 'weather_daily.weather_daily_truncate_guard'],
    ["await sql('ALTER TABLE spaces\n  DISABLE TRIGGER ALL')", 'spaces: DISABLE TRIGGER ALL'],
    ["await sql('ALTER TABLE cultivar_weight_sample DISABLE TRIGGER USER')", 'cultivar_weight_sample: DISABLE TRIGGER USER'],
    ["await sql(`ALTER TABLE ${t} DISABLE TRIGGER ${g}`)", '${t}.${g}'],
    ["await sql(`DISABLE TRIGGER ` + name)", 'not attributable'],
    ["await sql(\"SET session_replication_role = 'replica'\")", 'session_replication_role'],
    ["await sql('DROP TRIGGER spaces_delete_guard ON spaces')", 'DROP TRIGGER spaces_delete_guard ON spaces'],
    ['await directSql`DROP TRIGGER IF EXISTS "weather_daily_truncate_guard" ON ONLY public.weather_daily CASCADE`',
      'DROP TRIGGER weather_daily_truncate_guard ON weather_daily'],
    ["await sql('drop trigger weather_cold_range_truncate_guard on weather_cold_range')",
      'DROP TRIGGER weather_cold_range_truncate_guard ON weather_cold_range'],
    ["await sql('DROP FUNCTION public.guard_spaces_delete() CASCADE')", 'DROP FUNCTION guard_spaces_delete'],
    ["await sql('DROP FUNCTION IF EXISTS guard_space_truncate, guard_spaces_repoint')", 'DROP FUNCTION guard_space_truncate'],
    ["await sql(`DROP TRIGGER ${g} ON ${t}`)", 'DROP TRIGGER ${g} ON ${t}'],
    ["await sql('ALTER TABLE plots DISABLE TRIGGER plots_delete_guard')", 'plots.plots_delete_guard'],
    ["await sql('DROP TRIGGER plots_truncate_guard ON public.plots')", 'DROP TRIGGER plots_truncate_guard ON plots'],
    ["await sql('DROP FUNCTION public.guard_plots_repoint() CASCADE')", 'DROP FUNCTION guard_plots_repoint'],
  ])('a planted %s is refused', (planted, expected) => {
    const findings = scanSource(planted)
    expect(findings.length, `no finding for ${planted}`).toBeGreaterThan(0)
    expect(findings.join(' | ')).toContain(expected)
  })

  it('the sanctioned pair, a commented-out DISABLE and a DROP on an unguarded table are not findings', () => {
    expect(scanSource("await sql('ALTER TABLE cultivar_weight_sample DISABLE TRIGGER trg_cws_immutable')")).toEqual([])
    expect(scanSource('  // ALTER TABLE spaces DISABLE TRIGGER spaces_delete_guard\n')).toEqual([])
    // kitchen-ferment.int.test.js drops its own fixture audit trigger; not a guarded table
    expect(scanSource("directSql('DROP TRIGGER trg_audit_kitchen_stage_log_upd ON public.kitchen_stage_log')")).toEqual([])
    expect(scanSource("sql('DROP FUNCTION IF EXISTS test_helper_fn()')")).toEqual([])
  })
})
