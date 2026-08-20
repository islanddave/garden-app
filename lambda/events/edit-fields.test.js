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

const TREATMENT_COLS = ['treatment_product_id', 'treatment_product_text', 'treatment_category',
                        'treatment_amount', 'pest_target'];

// Which JS predicate each column's force-null arm is gated on.
//
// BUG-TREATMENTPRODUCT-001 split what used to be one gate. treatment_product_text is the ONE column
// fertilizing also captures, so it moved to `capturesProductText`; the other four stay pinned to
// `isTreatment` and that pinning is DELIBERATE — widening them would let a fertilizing edit keep a
// pest_target the POST could never have written, which is a new bug, not the same fix.
const FORCE_NULL_GATE = {
  treatment_product_id:   'isTreatment',
  treatment_product_text: 'capturesProductText',
  treatment_category:     'isTreatment',
  treatment_amount:       'isTreatment',
  pest_target:            'isTreatment',
};

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

// The PUT's predicate preamble — the `const isTreatment` / `const capturesProductText` lines that
// sit immediately above its UPDATE. Anchored backwards from the same SET-list marker putUpdate()
// uses, because BOTH names are ALSO defined in the POST handler ~900 lines further down: a bare
// SRC.includes finds the POST's copy and passes while the PUT has no predicate at all — which is
// EXACTLY the drift BUG-TREATMENTPRODUCT-001 was (the POST widened, the PUT did not, and the PUT
// runs last so it won). The two arms are told apart by their operand: the PUT reads `body.event_type`,
// the POST reads a pre-extracted `eventType`.
const putPreamble = () => {
  const marker = SRC.indexOf('private_notes = ${body.private_notes');
  expect(marker, 'the PUT SET-list marker must exist').toBeGreaterThan(-1);
  const end = SRC.lastIndexOf('UPDATE event_log el', marker);
  const start = SRC.lastIndexOf('const isTreatment', end);
  expect(start, 'the PUT must define its own isTreatment above its UPDATE').toBeGreaterThan(-1);
  const block = SRC.slice(start, end);
  expect(block, 'anchored on the POST arm, not the PUT').toContain('body.event_type');
  return block;
};

// The predicates, EXECUTED rather than merely matched. The two `const` lines are lifted verbatim
// out of the PUT's own preamble and evaluated, so the cases below run the SHIPPED expression, not a
// re-typed copy of it that is free to drift. A regex alone would pass against
// `const capturesProductText = isTreatment` — a rename carrying no behaviour, which is the vacuous
// guard this codebase keeps re-learning to distrust. new Function's input is this repo's own
// source, already read at the top of this file.
const putGate = () => {
  const lines = putPreamble().split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('const isTreatment') || l.startsWith('const capturesProductText'));
  expect(lines.length, 'the PUT preamble must define both predicates').toBe(2);
  // eslint-disable-next-line no-new-func
  return new Function('body', `${lines.join('\n')}\nreturn { isTreatment, capturesProductText };`);
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
    it(`${col} is settable, clearable, and force-nulled when the type does not own it`, () => {
      const b = putUpdate();
      const gate = FORCE_NULL_GATE[col];
      expect(b, `${col} must be force-nulled when the edit changes the type to one that does not own it`)
        .toMatch(new RegExp(`${col}\\s*= CASE WHEN NOT \\$\\{${gate}\\}::boolean THEN NULL`));
      expect(b, `${col} needs a clear arm`)
        .toMatch(new RegExp(`WHEN \\$\\{clear\\} @> ARRAY\\['${col}'\\] THEN NULL`));
      expect(b, `${col} must PRESERVE on an absent key, not full-replace`)
        .toMatch(new RegExp(`ELSE COALESCE\\(\\$\\{body\\.${col} \\?\\? null\\}, el\\.${col}\\) END`));
    });
  }

  it("a fertilizing event's product text survives an edit — the whole preserve chain", () => {
    // BUG-TREATMENTPRODUCT-001, the round trip that was broken. EventDetail sends event_type on
    // EVERY save and sends treatment_product_text on NONE for fertilizing, so all three links have
    // to hold or the value is gone on the next unrelated edit:
    //   1. the gate resolves TRUE for fertilizing, so the force-null arm is skipped;
    //   2. the column's CASE is bound to THAT gate, not to isTreatment;
    //   3. the ELSE preserves on an absent key instead of full-replacing with NULL.
    expect(putGate()({ event_type: 'fertilizing' }).capturesProductText,
      'fertilizing must skip the force-null arm').toBe(true);
    const b = putUpdate();
    expect(b, 'treatment_product_text must be gated on capturesProductText')
      .toMatch(/treatment_product_text\s*= CASE WHEN NOT \$\{capturesProductText\}::boolean THEN NULL/);
    expect(b, 'an absent key must preserve the stored value, not blank it')
      .toMatch(/ELSE COALESCE\(\$\{body\.treatment_product_text \?\? null\}, el\.treatment_product_text\) END/);
  });

  it('a genuinely non-product event type still nulls the column — the gate is not open', () => {
    // The over-widening this fix must NOT become. `capturesProductText = true`, or a gate that
    // admits every type, would leave a product string on a watering event that the POST could never
    // have created — the orphaned-treatment-data case the original isTreatment gate exists for.
    const gate = putGate();
    for (const t of ['watering', 'observation', 'harvest', 'transplant', 'sowing']) {
      expect(gate({ event_type: t }).capturesProductText, `${t} must NOT capture product text`).toBe(false);
    }
    // The two types that always owned it, plus the one this fix adds — no more, no less.
    for (const t of ['pest_treatment', 'doctored', 'fertilizing']) {
      expect(gate({ event_type: t }).capturesProductText, `${t} must capture product text`).toBe(true);
    }
    // And the widened gate must not have leaked into isTreatment, which still guards the other four.
    expect(gate({ event_type: 'fertilizing' }).isTreatment,
      'fertilizing must not become a treatment type').toBe(false);
    expect(putUpdate(), 'the force-null arm must still exist at all')
      .toMatch(/treatment_product_text\s*= CASE WHEN NOT \$\{capturesProductText\}::boolean THEN NULL/);
  });

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

// ── Slice 3: the re-anchor ───────────────────────────────────────────────────────────────────────
//
// These are static-source because the risk is SHAPE, and because the one failure that matters is
// invisible to any assertion that reads back the event row: a re-anchor that updates event_log and
// skips the OLD-anchor recompute moves the event correctly and leaves the vacated planting claiming
// a watering it no longer has — forever, because every forward upsert is GREATEST. Behavioural
// coverage for that lives in tests/integration (not in this commit; see the residuals note).
// The block marker is a COMMENT banner, so the offsets are taken in RAW; the window is decommented
// before returning so the arm assertions below run against code, not against prose describing it.
const putTail = () => {
  const i = RAW.indexOf('Slice 3: care-cache maintenance for a re-anchor');
  expect(i, 'the re-anchor block must exist').toBeGreaterThan(-1);
  return decomment(RAW.slice(i, RAW.indexOf('return resp(200, { ...updatedRows[0]', i)));
};

describe('slice 3: the re-anchor maintains the cache on BOTH anchors', () => {
  it('has four arms with DISTINCT bind names', () => {
    // undo-recompute.test.js finds its four arms by scanning BACKWARDS from a tail string with
    // lastIndexOf. Reusing ${projectId} / ${plantId} here would let its assertions silently
    // retarget onto these statements — a green suite proving nothing about the arms it names.
    const t = putTail();
    for (const bind of ['${oldProjectId}', '${newProjectId}', '${oldPlantId}', '${newPlantId}']) {
      expect(t, `${bind} must appear in the re-anchor block`).toContain(bind);
    }
    expect(t, 'must not reuse the undo route bind names')
      .not.toMatch(/FROM surv WHERE em\.project_id = \$\{projectId\}/);
    expect(t, 'must not reuse the undo route bind names')
      .not.toMatch(/FROM surv WHERE em\.plant_id = \$\{plantId\}/);
  });

  it('the OLD-anchor arms assign from surv and NEVER through GREATEST', () => {
    // THE test. GREATEST cannot lower a value, so an old-anchor arm written with it would leave
    // the vacated anchor permanently claiming the moved event. Invisible to every read of the row.
    const t = putTail();
    expect(t).toMatch(/FROM surv WHERE em\.project_id = \$\{oldProjectId\}/);
    expect(t).toMatch(/FROM surv WHERE em\.plant_id = \$\{oldPlantId\}/);
    for (const col of ['last_watered_at', 'last_event_at', 'last_fertilized_at',
                       'last_pruned_at', 'last_observed_at', 'last_harvested_at']) {
      expect(t, `${col} must not be assigned through GREATEST in a re-anchor arm`)
        .not.toMatch(new RegExp(`${col}\\s*=\\s*GREATEST`));
    }
  });

  it('the NEW-anchor arms are upserts, not bare UPDATEs', () => {
    // A bare UPDATE silently matches zero rows when the destination has never carried an event —
    // a brand-new planting would get no cache at all, and nothing would report it.
    const t = putTail();
    expect(t).toMatch(/INSERT INTO entity_memory[\s\S]*?ON CONFLICT \(project_id\) DO UPDATE SET/);
    expect(t).toMatch(/INSERT INTO entity_memory[\s\S]*?ON CONFLICT \(plant_id\) WHERE plant_id IS NOT NULL DO UPDATE SET/);
  });

  it('per-arm writer parity: the harvest filters DIFFER, on purpose', () => {
    // A recompute must invert ITS OWN arm's writer. The project-keyed forward writer maps
    // 'harvest'; the plant-keyed one maps IN ('harvest','first_harvest'). A tidy-up refactor that
    // unifies them would move last_harvested_at to a date no forward write ever produced — and
    // would pass a laxer test. This asserts they stay different.
    const t = putTail();
    expect(t).toMatch(/e\.project_id = \$\{oldProjectId\} AND e\.event_type = 'harvest'/);
    expect(t).toMatch(/e\.plant_id = \$\{oldPlantId\} AND e\.event_type IN \('harvest','first_harvest'\)/);
  });

  it('next_water_at is gated on the OLD-or-NEW watering union, never on a plant-keyed arm', () => {
    const t = putTail();
    // BUG-CACHEGATE-001 GAP 3. This asserted a gate on the POST-edit event type — a fact about the
    // EVENT, not about the key it LEFT — so a re-anchor that also retyped left the vacated
    // container holding a due date derived from a watering that was by then neither its event nor
    // a watering, while last_watered_at correctly walked backwards in the same statement. The gate
    // is now the OLD-or-NEW union, derived in JS.
    expect(t).toMatch(/next_water_at = CASE WHEN NOT \$\{waterTouched\}::boolean THEN em\.next_water_at/);
    expect(t, "the vacated due date must come from that key's OWN surviving waterings")
      .toMatch(/WHEN surv\.mw IS NULL THEN NULL ELSE surv\.mw \+/);
    // Gated, NOT removed: the nightly daily-plan engine owns "due", so an unrelated retitle must
    // not re-derive it.
    expect(t, 'next_water_at must still be gated, not unconditional').toContain('CASE WHEN NOT');
    // The plant arms carry recency only — the nightly daily-plan engine owns "due".
    const plantArm = t.slice(t.indexOf('${oldPlantId}'));
    expect(plantArm, 'no plant-keyed arm may touch next_water_at').not.toContain('next_water_at');
  });

  it('the post-edit event type no longer gates the vacated key', () => {
    // Pins the ABSENCE so a revert to the old gate cannot ship green.
    //
    // Asserts the PLACEHOLDER form, not the bare word: the surrounding comment necessarily NAMES
    // the removed binding in prose to explain why it went, and a bare-word check trips on that
    // explanation. The placeholder is also the form that actually matters — inside this template
    // literal it interpolates even within a `--` SQL comment, so a stale one is a runtime
    // ReferenceError on every re-anchor, not merely a dead gate. (That is exactly what happened
    // while making this change; lambda/sql-comment-hygiene.test.js now bans the shape fleet-wide.)
    // Deliberately RAW, and this is the one assertion in the file that MUST NOT be decommented: a
    // `${...}` placeholder inside a `--` comment is still interpolated by JavaScript, so stripping
    // comments here would hide the exact defect this guards. Comments are in scope on purpose.
    const block = RAW.slice(RAW.indexOf('Slice 3: care-cache maintenance'));
    expect(block, 'the movedType placeholder must be gone from the re-anchor block')
      .not.toMatch(/\$\{movedType\}/);
  });

  it('project_id is bound from the resolved local and can never become NULL', () => {
    const b = putUpdate();
    expect(b).toMatch(/project_id\s*=\s*\$\{newProjectId\}::uuid/);
    expect(b, 'the body must not reach project_id unresolved').not.toMatch(/project_id\s*=\s*\$\{body\./);
    expect(SRC, 'no clear arm may exist for project_id').not.toMatch(/@> ARRAY\['project_id'\]/);
  });

  it('every id being moved TO is ownership-gated with a generic 400', () => {
    // The UPDATE's household predicate authorizes the event's CURRENT container and says nothing
    // about the destination. Without these three gates a caller can move their own event onto
    // another household's planting. Generic message either way — found-vs-forbidden is a leak.
    for (const [field, loader] of [['project_id', 'loadOwnedProject'],
                                   ['location_id', 'loadOwnedLocation']]) {
      expect(SRC, `${field} must be gated through ${loader}`)
        .toMatch(new RegExp(`body\\.${field} != null && !await ${loader}\\(sql, body\\.${field}, householdIds\\)`));
      expect(SRC).toMatch(new RegExp(`error: 'Invalid ${field}'`));
    }
    // plant_id is gated in TWO halves since BUG-EVENTPROJPLANTPAIR-001: the loader call moved up to
    // where the anchor-pair derivation needs its result, and the rejection stayed here. Both halves
    // are asserted — the load alone would let a foreign planting through, and the rejection alone
    // could be checking a ref that nothing ever populated from the tight predicate.
    expect(SRC, 'plant_id must still be loaded through the tight loadOwnedPlantingRef predicate')
      .toMatch(/const newPlantRef = body\.plant_id != null\s*\?\s*await loadOwnedPlantingRef\(sql, body\.plant_id, householdIds\)/);
    expect(SRC, 'and an unowned planting must still be refused')
      .toMatch(/body\.plant_id != null && !newPlantRef/);
    expect(SRC).toMatch(/error: 'Invalid plant_id'/);
  });

  it('a re-anchor that would strip both anchors is a 400, not a 23514', () => {
    expect(putTail.toString()).toBeTruthy();
    expect(SRC).toMatch(/newProjectId == null && newPlantId == null/);
    expect(SRC).toMatch(/an event must keep a plant_id or a project_id/);
  });

  it('harvest_log.project_id follows, and carries its own RETURNING', () => {
    // The RETURNING is not cosmetic: harvest-weight-preserve.test.js finds the weight statement by
    // scanning forward for the next RETURNING, so a sibling harvest_log UPDATE without one would
    // extend that slice across two statements and weaken every assertion in it.
    const t = putTail();
    expect(t).toMatch(/UPDATE harvest_log hl SET project_id = \$\{newProjectId\}::uuid/);
    expect(t).toMatch(/RETURNING hl\.id/);
  });

  it('no stray backtick reaches the re-anchor SQL', () => {
    // Counted, not searched: putTail() slices from a COMMENT, so it necessarily contains the
    // sql`...` template delimiters themselves — a bare not.toContain would fail on correct code.
    // The real invariant is that every backtick in the block is a delimiter: one to open each
    // sql` template and one to close it, and nothing in between. A stray backtick inside a --
    // comment closes the template mid-statement and surfaces as a rollup parse error attributed
    // to the TEST file rather than the handler.
    const t = putTail();
    const ticks = (t.match(/`/g) || []).length;
    const opens = (t.match(/sql`/g) || []).length;
    expect(opens, 'the re-anchor block must contain sql templates').toBeGreaterThanOrEqual(4);
    expect(ticks, `${ticks} backticks for ${opens} templates — one is stray`).toBe(opens * 2);
  });
});
