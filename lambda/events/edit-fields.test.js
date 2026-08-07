// BUG-EVENTEDITFIELDS-001 — EventDetail could not edit what EventNew had just created.
// Slice 1: severity/flagged_as_issue + the five treatment columns. Static-source per L-072 house
// style, plus pure-function tests for the resolver. DB-free.
//
// THE SHAPE OF THE BUG: the PUT SET-list wrote 8 columns and RETURNED flagged_as_issue, severity
// and resolved_at — visible in the response, unwritable by any request. 72 flagged rows on prod
// were unfixable through the app. The five treatment columns were worse: writable by the POST,
// never returned by the GET, so the edit form could not even see them.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateClear, resolveFlagPair, CLEARABLE_FIELDS, CLEARABLE_SET } from './clearFields.js';
import { VALID_TREATMENT_CATEGORIES, TREATMENT_CATEGORY_ERROR, validateTreatmentCategory } from './validators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

const TREATMENT_COLS = ['treatment_product_id', 'treatment_product_text', 'treatment_category',
                        'treatment_amount', 'pest_target'];

// The PUT's UPDATE, isolated.
//
// Anchored BACKWARDS from a token unique to this statement, not forwards from the first
// `UPDATE event_log el` — that first match is the PATCH resolve route (~:928), whose SET-list is
// resolved_at/resolved_by/updated_at. A forward slice from there runs past the PATCH's own
// RETURNING and into this statement, so a naive "does the block contain private_notes" guard
// PASSES while the block is a superset of two statements. That is the aliasing failure this
// codebase keeps re-learning: a green assertion against the wrong text proves nothing.
const putUpdate = () => {
  const marker = SRC.indexOf('private_notes = ${body.private_notes');
  expect(marker, 'the PUT SET-list marker must exist').toBeGreaterThan(-1);
  const i = SRC.lastIndexOf('UPDATE event_log el', marker);
  const j = SRC.indexOf('RETURNING el.id', marker);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  const block = SRC.slice(i, j);
  // Positive AND negative anchoring: it must be the PUT, and it must not have swallowed the PATCH.
  expect(block, 'anchored on the wrong UPDATE').toContain('private_notes');
  expect(block, 'the slice swallowed the PATCH resolve route')
    .not.toContain('resolved_at = COALESCE(el.resolved_at, NOW())');
  return block;
};

describe('the PUT writes the columns it used to only return', () => {
  it('sets flagged_as_issue from the RESOLVED pair, never straight from the body', () => {
    // Binding body.flagged_as_issue directly reintroduces the 23514: the column is NOT NULL and
    // chk_event_log_severity_requires_flag is VALIDATED, so flagged=false beside a surviving
    // severity aborts the transaction and the generic catch turns it into an opaque 500.
    expect(putUpdate()).toMatch(/flagged_as_issue\s*=\s*\$\{pair\.flagged\}::boolean/);
    expect(putUpdate()).toMatch(/severity\s*=\s*\$\{pair\.severity\}::smallint/);
    expect(putUpdate(), 'the body must not reach these columns unresolved')
      .not.toMatch(/flagged_as_issue\s*=\s*\$\{body\./);
  });

  for (const col of TREATMENT_COLS) {
    it(`${col} is settable, clearable, and force-nulled when the type is not a treatment type`, () => {
      const b = putUpdate();
      expect(b, `${col} must be force-nulled when the edit changes the type away from a treatment type`)
        .toMatch(new RegExp(`${col}\\s*= CASE WHEN NOT \\$\\{isTreatment\\}::boolean THEN NULL`));
      expect(b, `${col} needs a clear arm`)
        .toMatch(new RegExp(`WHEN \\$\\{clear\\} @> ARRAY\\['${col}'\\] THEN NULL`));
      expect(b, `${col} must PRESERVE on an absent key, not full-replace`)
        .toMatch(new RegExp(`ELSE COALESCE\\(\\$\\{body\\.${col} \\?\\? null\\}, el\\.${col}\\) END`));
    });
  }

  it('the four legacy full-replace columns are NOT migrated in this commit', () => {
    // title/notes/private_notes/quantity keep `${body.x ?? null}` — an omitted key clears them.
    // That grammar is documented and every caller always sends them. Changing it here would be an
    // unrelated behaviour change smuggled into a bug fix, and it is not what this ticket is for.
    const b = putUpdate();
    for (const col of ['title', 'notes', 'private_notes', 'quantity']) {
      expect(b).toMatch(new RegExp(`${col}\\s*= \\$\\{body\\.${col} \\?\\? null\\}`));
    }
  });

  it('no backtick reaches the SQL template literal', () => {
    // index.js is one large JS template literal. A backtick inside a -- comment closes the string
    // mid-statement and surfaces as a rollup "Expected a semicolon" attributed to the TEST file,
    // not the handler.
    expect(putUpdate()).not.toContain('`');
  });
});

describe('the GET returns what the PUT writes — read and write ship together', () => {
  it('the by-id GET selects all five treatment columns and resolved_by', () => {
    // Shipping the write path without this is strictly WORSE than the original bug: the form seeds
    // itself from the GET body, so a round-trip would blank five populated columns, and every
    // client-only test would still pass.
    //
    // Anchored on `e.private_notes,` — the ONLY occurrence of that token in the file, and it sits
    // in this select list. `pp.display_name AS project_name` appears FIVE times (the feed route at
    // :585 is the first), so an indexOf on it slices the wrong route and the assertion fails for a
    // reason that has nothing to do with the code under test.
    const i = SRC.indexOf('e.private_notes,');
    expect(i, 'the by-id GET select marker must be unique and present').toBeGreaterThan(-1);
    expect(SRC.indexOf('e.private_notes,', i + 1), 'marker must be unique').toBe(-1);
    const block = SRC.slice(i, SRC.indexOf('FROM event_log', i));
    for (const col of TREATMENT_COLS) {
      expect(block, `GET must return ${col}`).toMatch(new RegExp(`e\\.${col}`));
    }
    expect(block).toMatch(/e\.resolved_by/);
  });

  it('the PUT RETURNING carries them too', () => {
    const i = SRC.indexOf('RETURNING el.id');
    const block = SRC.slice(i, i + 900);
    for (const col of TREATMENT_COLS) {
      expect(block, `RETURNING must carry ${col}`).toMatch(new RegExp(`el\\.${col}`));
    }
  });
});

describe('resolveFlagPair — the partial-update semantics the POST one-liner cannot express', () => {
  const flaggedRow = { flagged_as_issue: true, severity: 2 };
  const plainRow = { flagged_as_issue: false, severity: null };

  it('preserves both when the edit touches neither', () => {
    expect(resolveFlagPair({ notes: 'x' }, flaggedRow, [])).toEqual({ flagged: true, severity: 2 });
  });

  it('UNFLAGGING clears the severity in the same statement — never a 23514', () => {
    // The single most important case. chk_event_log_severity_requires_flag is VALIDATED, so
    // flagged=false beside a surviving severity=2 is a hard constraint violation.
    expect(resolveFlagPair({ flagged_as_issue: false }, flaggedRow, []))
      .toEqual({ flagged: false, severity: null });
  });

  it('flags a previously-unflagged event when given a severity', () => {
    expect(resolveFlagPair({ flagged_as_issue: true, severity: 3 }, plainRow, []))
      .toEqual({ flagged: true, severity: 3 });
  });

  it('refuses flagging with no severity', () => {
    // The DB would NOT catch this — the CHECK permits flagged=true with a NULL severity — so a
    // flagged issue would silently lose its urgency. Only this check stops it.
    expect(resolveFlagPair({ flagged_as_issue: true }, plainRow, []).error)
      .toMatch(/severity required when flagged_as_issue/);
  });

  it('refuses a severity without the flag', () => {
    expect(resolveFlagPair({ severity: 2 }, plainRow, []).error)
      .toMatch(/severity requires flagged_as_issue/);
  });

  it('refuses an out-of-range severity with the create path message', () => {
    expect(resolveFlagPair({ flagged_as_issue: true, severity: 99 }, plainRow, []).error)
      .toMatch(/severity must be 1, 2, or 3/);
  });

  it('refuses clearing the severity while the event stays flagged', () => {
    expect(resolveFlagPair({ flagged_as_issue: true }, flaggedRow, ['severity']).error)
      .toMatch(/severity required when flagged_as_issue/);
  });

  it('allows clearing the severity as part of unflagging', () => {
    expect(resolveFlagPair({ flagged_as_issue: false }, flaggedRow, ['severity']))
      .toEqual({ flagged: false, severity: null });
  });
});

describe('validateClear — the events allowlist', () => {
  it('accepts every allowlisted field and refuses the rest', () => {
    expect(CLEARABLE_FIELDS.length).toBe(6);
    for (const f of CLEARABLE_FIELDS) expect(validateClear([f], {})).toBeNull();
  });

  it('project_id is NOT clearable — the inner-join trap', () => {
    // The PUT's ownership SELECT, the PUT's UPDATE and the DELETE all INNER JOIN container on
    // el.project_id. A NULL project_id makes the event permanently un-editable AND un-deletable,
    // with no in-app recovery.
    expect(CLEARABLE_SET.has('project_id')).toBe(false);
    expect(validateClear(['project_id'], {})).toMatch(/cannot be cleared/);
    expect(SRC, 'no clear arm may exist for project_id').not.toMatch(/@> ARRAY\['project_id'\]/);
  });

  for (const col of ['plant_id', 'location_id', 'flagged_as_issue', 'event_type', 'event_date',
                     'is_public', 'resolved_at', 'metadata', 'source']) {
    it(`${col} is not clearable`, () => {
      expect(CLEARABLE_SET.has(col)).toBe(false);
      expect(validateClear([col], {})).toMatch(/cannot be cleared/);
    });
  }

  it('legacy callers are untouched', () => {
    for (const v of [undefined, null, []]) expect(validateClear(v, {})).toBeNull();
  });

  it('refuses a key that is both cleared and set', () => {
    expect(validateClear(['severity'], { severity: 2 })).toMatch(/both cleared and set/);
  });

  it('allowlist and SQL cannot drift apart', () => {
    // Driven off the imported allowlist. A field added to clearFields.js with no SQL arm would be
    // an accepted-but-inert clear — the exact defect that shipped in varieties and stayed green.
    // severity is excluded: it is resolved in JS and bound directly, not via a CASE arm.
    for (const f of CLEARABLE_FIELDS.filter(f => f !== 'severity')) {
      expect(SRC, `${f} is allowlisted but has no SQL clear arm`)
        .toMatch(new RegExp(`@> ARRAY\\['${f}'\\] THEN NULL`));
    }
  });
});

describe('the treatment-category rule is shared with the create path, not re-typed', () => {
  it('the PUT calls the shared validator', () => {
    expect(SRC).toMatch(/const catErr = validateTreatmentCategory\(body\.treatment_category\)/);
  });

  it('the rule and its message have one source', () => {
    expect(VALID_TREATMENT_CATEGORIES).toEqual(['fertilizer', 'amendment', 'pest_control', 'other']);
    expect(validateTreatmentCategory('bogus')).toEqual({ status: 400, error: TREATMENT_CATEGORY_ERROR });
    expect(validateTreatmentCategory(null)).toBeNull();
    expect(validateTreatmentCategory('fertilizer')).toBeNull();
  });
});
