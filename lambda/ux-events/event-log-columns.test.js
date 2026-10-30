// OPS-SCHEMAAUDITJOIN-001 — the public.event_log columns lambda/ux-events reads.
//
// One column, one arm, no alias. This directory's only event_log reference is the first
// arm of the three-way UNION behind the admin capture-events metric. The alias set below is
// therefore empty and the whole contract rests on the pin — if the pin stops matching, this file
// reds rather than passing on a contract it can no longer check.
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

// L-081 KEYED contract. Every column below verified present on public.event_log in live prod Neon on
// 2026-08-29 (28 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
const AUDIT_COLUMNS = {
  event_log: ['created_at'],
};

const EVENT_LOG_COLUMNS = AUDIT_COLUMNS.event_log;

// The event_log statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'event_log');

// Reads that name event_log with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [
  {
    file: 'index.js',
    // M2, captures-per-week. Note this arm has NO archived_at filter while the garden_node
    // and container arms beside it do — event_log has no archived_at at all, which is why the
    // asymmetry is correct here and not an oversight to tidy up.
    pin: /\(\s*SELECT created_at FROM event_log\s+UNION ALL/,
    columns: ['created_at'],
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/ux-events event_log column contract', () => {
  it('finds the event_log statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    expect(READS.statements).toHaveLength(1);
    expect(READS.aliases).toEqual([]);
  });

  it('accounts for every unaliased event_log read', () => {
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
    expect(referenced).toEqual([...EVENT_LOG_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these exist on event_log, and each is a live confusion: container_id and
    // display_name are garden_node's, the date column is event_date not event_at, and the two actor
    // columns are created_by and logged_by, never user_id.
    const NOT_ON_TABLE = ['container_id', 'display_name', 'name', 'event_at', 'user_id'];
    for (const col of NOT_ON_TABLE) {
      expect(EVENT_LOG_COLUMNS).not.toContain(col);
      expect(READS.refsTo(col)).toEqual([]);
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
    expect(parsed.map(([key]) => key)).toEqual(['event_log']);
    const cols = parsed[0][1];
    expect(cols).toEqual(EVENT_LOG_COLUMNS);
  });
});
