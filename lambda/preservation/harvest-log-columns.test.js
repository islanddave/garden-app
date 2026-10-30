// OPS-SCHEMAAUDITJOIN-001 — the public.harvest_log columns lambda/preservation reads.
//
// One statement in index.js, and the only place in the repo that proves ownership of a
// harvest row from harvest_log.created_by directly — everywhere else the household check is
// made on the joined event or its container. It names the table with NO alias, so its
// identifiers cannot be attributed automatically and are pinned by hand below.
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

// L-081 KEYED contract. Every column below verified present on public.harvest_log in live prod Neon on
// 2026-08-29 (15 columns), read through the read-only role.
// The keyed form binds columns to ONE relation, so this file cannot assert its list onto whatever
// table select-columns.test.js in this directory declares — that cross-product is what made joined
// relations unauditable in the first place.
//
// V5-INFLIGHTBATCH-001 added `event_id`. The kitchen-batch predicate bulk-add resolves a date window
// over harvest_log, and harvest_log has NO date column of its own — a harvest hangs off an event, so
// the window is `event_log.event_date` reached through this FK. It is the ONLY new column here; the
// window's crop/variety/plant selectors all resolve through garden_node and cultivar, which have their
// own contracts beside this one.
const AUDIT_COLUMNS = {
  harvest_log: ['created_by', 'deleted_at', 'event_id', 'id', 'quantity', 'unit'],
};

const HARVEST_LOG_COLUMNS = AUDIT_COLUMNS.harvest_log;

// The harvest_log statements in this directory's handlers, scanned by lambda/_test-stubs/columnContract.js.
const READS = tableReads(import.meta.url, 'harvest_log');

// Reads that name harvest_log with NO alias. Nothing can attribute their bare identifiers
// automatically — the surrounding query may scan other tables through their own aliases — so each
// arm is PINNED to its literal SQL and its columns are listed by hand. Edit the query and the pin
// stops matching and this file reds, which is the only way the hand-listed columns stay honest.
const UNALIASED_ARMS = [
  {
    file: 'index.js',
    // The ownership gate a preservation record passes before it may cite a harvest as its
    // source. All three predicates are load-bearing and so the pin covers the whole statement:
    // drop created_by and any household's harvest can be cited; drop deleted_at and a retracted
    // harvest can.
    pin: /SELECT id FROM harvest_log\s+WHERE id = \$\{harvestLogId\}\s+AND created_by = ANY\(\$\{householdIds\}\)\s+AND deleted_at IS NULL/,
    columns: ['id', 'created_by', 'deleted_at'],
  },
];

describe('OPS-SCHEMAAUDITJOIN-001 — lambda/preservation harvest_log column contract', () => {
  it('finds the harvest_log statements, so the assertions below are not vacuous', () => {
    expect(READS.handlers.length).toBeGreaterThan(0);
    // Exact count, not a floor: a new statement against this table should be reviewed against the
    // contract rather than inherit it. Update this number in the same commit that adds one.
    // 1 -> 3 with V5-INFLIGHTBATCH-001: index.js's unaliased ownership gate, plus kitchenRoutes.js's
    // loadOwnedHarvestLogs (the batched form of that same gate) and the predicate bulk-add's
    // INSERT..SELECT. Both new ones bind the table as `h`.
    // Release F: +2 — the pick loader and the line search's recent picks, which read quantity and unit.
    expect(READS.statements).toHaveLength(5);
    expect(READS.aliases).toEqual(['h']);
  });

  it('accounts for every unaliased harvest_log read', () => {
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
    expect(referenced).toEqual([...HARVEST_LOG_COLUMNS].sort());
  });

  it('never reaches for a column that belongs to another table', () => {
    // None of these exist on harvest_log, and every one of them is a live confusion in this repo.
    // There is NO plant_id: a harvest row hangs off an event, and the planting is reached through
    // event_log.plant_id — the only FK here is project_id, the container. There is no date column
    // either; `event_date` belongs to the joined event_log row and `harvest_date` is the ALIAS the
    // handlers give it after the timezone shift, never a column. The measured column is
    // `weight_grams` — bare `weight` is what the wire payload calls it. And a harvest row carries no
    // `name`; the crop label comes from crop_types or plant_varieties several joins away.
    const NOT_ON_TABLE = ['plant_id', 'event_date', 'harvest_date', 'weight', 'name'];
    for (const col of NOT_ON_TABLE) {
      expect(HARVEST_LOG_COLUMNS).not.toContain(col);
      expect(READS.refsTo(col)).toEqual([]);
      for (const arm of UNALIASED_ARMS) {
        expect(arm.columns, `${arm.file}: ${col} is not a harvest_log column`).not.toContain(col);
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
    expect(parsed.map(([key]) => key)).toEqual(['harvest_log']);
    const cols = parsed[0][1];
    expect(cols).toEqual(HARVEST_LOG_COLUMNS);
  });
});
