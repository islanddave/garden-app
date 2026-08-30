// V4-PHOTOUNTAG-001 — returning a tagged photo to the untagged inbox (re-tag PUT, intake_status).
//
// THE DEFECT THIS FILE EXISTS FOR: the re-tag PUT derived intake_status entirely from setsParent and
// never read body.intake_status. Tagging drained the inbox (intake_status -> NULL) correctly, but
// clearing the parents again made setsParent false, so the CASE fell to `ELSE p.intake_status` and the
// row kept NULL — parentless AND non-pending, which photos_must_have_parent forbids. Postgres answers
// 23514, isUpstream() does not classify it, and the caller gets an opaque 500. Drain was a one-way
// door: no request body meant "put this back in the inbox".
//
// WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT. This directory's suite is mock-sql only: there is no
// database anywhere in it, so nothing here executes a CHECK constraint or observes a stored row. What
// is proven is the STATEMENT AND THE PARAMETERS the handler emits — the real functions run against a
// recording fake `sql`, and the CASE arms are read back out of the emitted text. Whether Postgres then
// accepts the row is an integration concern; the constraint text those emissions are designed against
// was read separately from live prod and staging (pg_get_constraintdef, both convalidated, 2026-08-30):
//   photos_intake_status_valid — intake_status IS NULL OR IN ('pending_tag','upload_failed')
//   photos_must_have_parent    — one of the six parent columns IS NOT NULL,
//                                OR COALESCE(intake_status = 'pending_tag', false)
//
// STRUCTURE: the extract-and-execute pattern of space-photos.test.js / dedupe-add-parent.test.js —
// index.js is not importable from the repo root (its @aws-sdk/@clerk/@neondatabase deps are
// per-Lambda), so the functions under test are pulled verbatim from source and instantiated. Route
// wiring, which has no extractable function, is asserted against DECOMMENTED source.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct (household-mode.test.js). The `//` arm is
// URL-safe; the `--` arm requires surrounding space so a JS decrement is never read as SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const SRC = decomment(RAW);

function extractFunction(src, header) {
  const start = src.indexOf(header);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// Brace-balanced block extraction from a comment anchor (evidence-capture.test.js). A fixed-size
// window would stop inside the block and leave every negative assertion below unreachable.
const blockFrom = (src, marker) => {
  const start = src.indexOf(marker);
  if (start === -1) return '';
  const open = src.indexOf('{', src.indexOf('if (', start));
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
};

function makeSql() {
  const calls = [];
  const sql = (strings, ...values) => {
    calls.push({ text: strings.join('¶'), values });
    return Promise.resolve([]);
  };
  sql.calls = calls;
  return sql;
}

const resolveSrc = extractFunction(SRC, 'function resolveIntakeRequest');
const updateSrc = extractFunction(SRC, 'function buildRetagUpdate');
const instantiate = (fnSrc) => new Function(`return (${fnSrc});`)();

const resolveIntakeRequest = resolveSrc && instantiate(resolveSrc);
const buildRetagUpdate = updateSrc && instantiate(updateSrc);

// The PUT block, anchored on the marker this feature added to its header comment.
const PUT_BLOCK = decomment(blockFrom(RAW, 'V4-PHOTOUNTAG-001 adds the INVERSE of (1)'));

// The three-arm CASE, read straight out of the EMITTED statement: arm order, each arm's literal, and
// which bound parameter each arm tests. Grounded in the text the handler actually produced, so
// re-ordering or deleting an arm in index.js changes this answer rather than agreeing with it.
const ARMS = /intake_status = CASE\s+WHEN ¶::boolean THEN (\S+)\s+WHEN ¶::boolean THEN ('[a-z_]+')\s+ELSE (\S+) END/;

// Resolve the CASE first-true-wins, the way Postgres would. Parameter positions are counted from the
// ¶ placeholders preceding the CASE rather than hardcoded, so adding a column to the SET list ahead
// of it cannot silently shift this onto the wrong value.
function intakeOutcome({ text, values }) {
  const m = text.match(ARMS);
  if (!m) return 'CASE-SHAPE-UNRECOGNISED';
  const i = (text.slice(0, text.indexOf('intake_status = CASE')).match(/¶/g) ?? []).length;
  if (values[i] === true) return m[1];
  if (values[i + 1] === true) return m[2];
  return m[3];
}

const PHOTO = 'photo-1';
const HOUSEHOLD = ['user_dave', 'user_jen'];
const emit = ({ body = {}, setsParent = false, restoresInbox = false } = {}) => {
  const sql = makeSql();
  buildRetagUpdate(sql, PHOTO, body, HOUSEHOLD, setsParent, restoresInbox);
  return sql.calls[0];
};

describe('V4-PHOTOUNTAG-001 — extraction guards (guard for the guards)', () => {
  it('both functions were extracted and the CASE shape is recognised', () => {
    // Every negative and outcome assertion below runs through these. An extraction that silently
    // returned null, or a CASE the reader no longer matches, would make them pass on nothing.
    expect(resolveSrc, 'resolveIntakeRequest not extracted').toBeTruthy();
    expect(updateSrc, 'buildRetagUpdate not extracted').toBeTruthy();
    expect(emit().text, 'the emitted CASE no longer matches ARMS').toMatch(ARMS);
    expect(PUT_BLOCK, 'PUT block extraction collapsed').toContain('buildRetagUpdate(');
  });
});

describe('V4-PHOTOUNTAG-001 — the request contract (resolveIntakeRequest)', () => {
  it("accepts 'pending_tag' — the only status a parentless row may carry", () => {
    expect(resolveIntakeRequest({ intake_status: 'pending_tag' })).toEqual({ restoresInbox: true });
  });

  it('treats an omitted status as "not requested"', () => {
    expect(resolveIntakeRequest({})).toEqual({ restoresInbox: false });
    expect(resolveIntakeRequest({ caption: 'x', project_id: 'proj-1' })).toEqual({ restoresInbox: false });
  });

  it('treats an EXPLICIT null as "not requested", not as a value to store', () => {
    // The POST guard's `!= null` idiom, not a new dialect. An explicit null leaves the CASE on its
    // pre-existing arms, which can only preserve or clear — never violate a CHECK.
    expect(resolveIntakeRequest({ intake_status: null })).toEqual({ restoresInbox: false });
  });

  it("rejects 'upload_failed' even though POST accepts it", () => {
    // Valid under photos_intake_status_valid, but photos_must_have_parent requires a parent for it,
    // so on the un-tag it would most plausibly accompany it is a guaranteed 23514 -> opaque 500.
    // A re-tag has no business asserting an upload-pipeline state. Deliberately narrower than
    // INTAKE_STATUSES; do not widen this to reuse that list.
    const out = resolveIntakeRequest({ intake_status: 'upload_failed' });
    expect(out.restoresInbox).toBeUndefined();
    expect(out.error).toMatch(/pending_tag/);
  });

  it('rejects arbitrary values rather than letting them reach the CHECK', () => {
    for (const v of ['tagged', 'skipped', 'PENDING_TAG', 'pending_tag ', '', 0, false, 7, {}, []]) {
      const out = resolveIntakeRequest({ intake_status: v });
      expect(out.error, `accepted ${JSON.stringify(v)}`).toBeTruthy();
      expect(out.restoresInbox, `accepted ${JSON.stringify(v)}`).toBeUndefined();
    }
  });
});

describe('V4-PHOTOUNTAG-001 — the four contract branches, as the statement emits them', () => {
  it('clears every parent AND asks for pending_tag -> the row goes back to the inbox', () => {
    // THE BRANCH THIS TICKET EXISTS FOR. Before the fix there was no second arm at all, so this
    // emitted `ELSE p.intake_status` and a tagged row kept NULL while parentless — 23514.
    const { text, values } = emit({ body: { intake_status: 'pending_tag' }, restoresInbox: true });
    expect(intakeOutcome({ text, values })).toBe("'pending_tag'");
    // The parents this route owns are all cleared in the same statement, which is what makes the
    // parentless branch of photos_must_have_parent the one that has to carry the row.
    expect(values.slice(2, 5)).toEqual([null, null, null]);
  });

  it('sets a parent -> intake_status is cleared, exactly as before', () => {
    const { text, values } = emit({ body: { project_id: 'proj-1' }, setsParent: true });
    expect(intakeOutcome({ text, values })).toBe('NULL');
    expect(values).toContain('proj-1');
  });

  it('sets a parent AND asks for pending_tag -> the parent wins and the row still drains', () => {
    // Arm ORDER is the contract. A full-replace client that echoes the row's current intake_status
    // back while tagging must not be 400'd or left in the carousel; a tagged row is not in the inbox.
    const { text, values } = emit({
      body: { project_id: 'proj-1', intake_status: 'pending_tag' }, setsParent: true, restoresInbox: true,
    });
    expect(intakeOutcome({ text, values })).toBe('NULL');
  });

  it('omits intake_status -> the pre-existing arm, so an un-tagged pending_tag row STAYS pending', () => {
    // The regression branch: with restoresInbox false the CASE reduces to the shipped
    // `WHEN setsParent THEN NULL ELSE p.intake_status`, and every legacy caller behaves as before.
    const { text, values } = emit({ body: { caption: 'just a caption' } });
    expect(intakeOutcome({ text, values })).toBe('p.intake_status');
  });

  it('binds the two flags as booleans and adds exactly one parameter to the shipped statement', () => {
    // The shipped SET list bound six values (photoId, householdIds, three parents, caption) plus the
    // setsParent flag. A second flag is the whole cost of this feature; anything more means a
    // parameter crept in somewhere the reviewer did not look.
    const { values } = emit({ restoresInbox: true });
    expect(values).toHaveLength(8);
    expect(values.slice(6)).toEqual([false, true]);
  });
});

describe('V4-PHOTOUNTAG-001 — the un-tag path cannot reach a photo the caller does not own', () => {
  it('the prev CTE is the ownership gate and the UPDATE inherits it through the join', () => {
    // The un-tag changes the SET list only, so it adds no new surface here — but that is worth
    // pinning rather than assuming, because the UPDATE carries NO created_by predicate of its own.
    // A caller outside the household gets an empty prev, zero rows, and the route's 404.
    const { text, values } = emit();
    const cte = text.slice(text.indexOf('WITH prev AS ('), text.indexOf('UPDATE photos p'));
    expect(cte).toMatch(/created_by = ANY\(¶\)/);
    expect(cte).toMatch(/AND deleted_at IS NULL/);
    expect(text).toMatch(/FROM prev\s+WHERE p\.id = prev\.id/);
    expect(values).toContainEqual(['user_dave', 'user_jen']);
  });

  it('household scoping is not conditional on the intake request', () => {
    // A restore that skipped the scope — or widened it to the photo id alone — would turn "return my
    // photo to my inbox" into "detach anyone's photo".
    for (const restoresInbox of [false, true]) {
      const { text, values } = emit({ restoresInbox, body: { intake_status: 'pending_tag' } });
      expect(text, `scope lost when restoresInbox=${restoresInbox}`).toMatch(/created_by = ANY\(¶\)/);
      expect(values[1]).toEqual(['user_dave', 'user_jen']);
    }
  });

  it('the statement never names a parent column the route does not own', () => {
    // event_id / inventory_item_id / space_id survive an un-tag, so a row parented by one keeps
    // satisfying photos_must_have_parent on its own. space_id in particular must stay absent: this
    // template executes with SPACE_PHOTOS_ENABLED off and would 42703 wherever the column is not
    // applied (space-photos.test.js owns that invariant fleet-wide).
    const { text } = emit();
    for (const c of ['event_id', 'inventory_item_id', 'space_id']) {
      expect(text, `re-tag UPDATE names ${c}`).not.toMatch(new RegExp(`${c}\\s*=`));
    }
  });
});

describe('V4-PHOTOUNTAG-001 — route wiring', () => {
  it('validates before any ownership loader runs, so a rejected request does no I/O', () => {
    const validated = PUT_BLOCK.indexOf('const intake = resolveIntakeRequest(body);');
    expect(validated, 'resolveIntakeRequest not called in the PUT block').toBeGreaterThan(-1);
    expect(PUT_BLOCK).toMatch(/if \(intake\.error\) return resp\(400, \{ error: intake\.error \}\);/);
    for (const loader of ['loadOwnedProject', 'loadOwnedPlantingRef', 'loadOwnedLocation']) {
      expect(PUT_BLOCK.indexOf(loader), `${loader} runs before validation`).toBeGreaterThan(validated);
    }
    expect(PUT_BLOCK.indexOf('buildRetagUpdate(')).toBeGreaterThan(validated);
  });

  it('passes the resolved flag through instead of hardcoding it', () => {
    // A call site that passed a literal `false` in that position would leave the feature dead with
    // every test above still green, since they drive buildRetagUpdate directly.
    expect(PUT_BLOCK).toMatch(/buildRetagUpdate\(\s*sql, photoId, body, householdIds, setsParent, intake\.restoresInbox,?\s*\)/);
  });

  it('the route still emits no re-tag UPDATE of its own', () => {
    // The template moved into buildRetagUpdate. A second, inline copy left behind would be the one
    // that actually ran while every assertion above graded the function nobody calls.
    expect(PUT_BLOCK).not.toMatch(/UPDATE photos p/);
    expect((SRC.match(/RETURNING p\.\*, prev\.intake_status AS prev_intake_status/g) ?? []))
      .toHaveLength(1);
  });
});
