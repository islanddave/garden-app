// V4-SOURCEREG-001 — the two `public.source` FKs on the plants write paths.
//
// WHY THE MECHANISM HERE IS NOT THE ONE lambda/inventory-items USES, even though the columns are the
// same two. That handler's PUT is a static full-row overwrite, so its hazard is an omitted key
// NULLing a column. This one is a COALESCE merge with an explicit `clear: []` channel
// (BUG-COALESCECLEAR-001), so an omitted key already preserves — and the hazard inverts: COALESCE
// can SET but never UNSET, so without a presence sentinel a source picked by mistake would be
// PERMANENT. The sentinel is what makes the column clearable, which is exactly why hasVariety /
// hasLocation / hasAssignee / hasFeatured / hasAcquiredMature exist a few lines above it.
//
// So the clear cases below are the reason this file exists, and the preservation cases are the
// control that proves the sentinel is not simply always-on.
//
// WHY NOT THE `clear` CHANNEL. validate.js's tier-3 block states the house rule as one clearing
// mechanism per column and enumerates location_id and acquired_mature as deliberately ABSENT from
// CLEARABLE_FIELDS for precisely that reason. Reaching NULL that way would also need
// lambda/plants/validate.js and its byte-mirrored client half src/lib/clearKeys.js to move together
// (src/__tests__/clearKeys.test.js asserts the two lists EQUAL), and would still leave the picker's
// natural `source_id: form.source_id || null` payload unable to say "remove this".
//
// THE STRUCTURAL ASSERTION AND THE FLAG ASSERTION ARE BOTH NEEDED, and put-seed-validate.test.js
// records why: a CASE wired to a constant `true` satisfies the shape check while writing exactly
// what a bare assignment would. So every case below pins the ELSE arm AND the value bound to that
// specific flag.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

// The house neon stub (lambda/_test-stubs/neon-serverless.js) returns a bare tagged function, and
// this is the first handler under it whose write path uses sql.transaction — the plants PUT batches
// set_config + the UPDATE + the audit writes so a missed audit row cannot outlive the edit it
// describes. Extending the shared stub would edit a module twelve other test files import, so the
// transaction seam is added HERE and nowhere else. Statements are already-settled promises (the tag
// executes eagerly, exactly as the shared stub does), so awaiting them in order reproduces the
// driver's contract: an array of row-arrays positionally aligned with the statements passed in,
// which is what index.js reads as `_txr[1]`.
vi.mock('@neondatabase/serverless', async () => {
  const { stubState: st } = await import('../_test-stubs/state.js');
  return {
    neon: () => {
      const tagged = async (strings, ...values) => {
        const text = Array.isArray(strings) ? strings.join('?') : String(strings);
        st.sqlCalls.push({ text, values });
        return st.sqlHandler(text, values);
      };
      tagged.transaction = (stmts) => Promise.all(stmts);
      return tagged;
    },
  };
});

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const PLANT = '9f1c2b3a-4d5e-4f60-8a71-2b3c4d5e6f70';
const PROJECT = '11112222-3333-4444-8555-666677778888';
// Two distinct live sources, so "the originator" and "the shop" are never satisfiable by the same
// value — an assertion that passed because both ids happened to be equal would prove nothing about
// a pair whose whole point is that they differ.
const ORIGINATOR = 'a1111111-1111-4111-8111-111111111111';
const SHOP = 'b2222222-2222-4222-8222-222222222222';
const GONE = 'c3333333-3333-4333-8333-333333333333';
// The pointer ALREADY STORED on the row under edit. Distinct from every id above, so "preserved"
// can never be satisfied by a value the request itself supplied.
const STORED = 'd4444444-4444-4444-8444-444444444444';

// The value bound to ONE named placeholder, not "is this value anywhere in the list". This UPDATE
// binds seven such boolean flags, so `expect(values).toContain(false)` would be satisfied by any of
// the other six while the flag under test stayed pinned to `true` — the vacuity put-seed-validate
// .test.js recorded. The stub builds its text as `strings.join('?')`, so a placeholder's value is
// indexed by how many '?' precede it.
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};

// BUG-PLANTSOURCEIDCLEAR-001. Resolve what ONE column's CASE block actually writes for THIS
// request, by walking its arms against their bound values the way Postgres would.
//
// Deliberately understands BOTH shapes: the pre-fix presence sentinel (WHEN <flag> THEN <value>
// ELSE p.col) and the shipped clear-channel merge (WHEN <clear> @> ARRAY[...] THEN NULL ELSE
// COALESCE(<value>, p.col)). A helper that only parsed the new shape would red on the old code with
// "no match", which proves nothing about the data loss — this one reports that the old code WRITES
// NULL, which is the bug itself, demonstrated rather than asserted.
//
// Bindings are positional: the stub builds text as strings.join('?'), so a placeholder's value is
// indexed by how many '?' precede it. \b guards the column name because acquired_from_source_id
// ENDS in source_id and would otherwise capture the wrong block, and the tempered
// `(?:(?!= CASE)[\s\S])` bounds the search to ONE assignment — the same extractor-swallows-too-much
// defect clear-fields.test.js records at its own drift guard.
const qs = (s) => (s.match(/\?/g) ?? []).length;
const resolveCase = (call, col, stored) => {
  const m = call.text.match(new RegExp(`\\b${col}\\s*= CASE((?:(?!= CASE)[\\s\\S])*?)\\bEND\\b`));
  expect(m, `${col} has no CASE ... END block`).toBeTruthy();
  let idx = qs(call.text.slice(0, m.index));
  const parts = m[1].split(/\bELSE\b/);
  const elsePart = parts.length > 1 ? parts.pop() : '';
  for (const arm of parts.join(' ').split(/\bWHEN\b/).slice(1)) {
    const [condRaw, thenRaw = ''] = arm.split(/\bTHEN\b/);
    const condVals = call.values.slice(idx, (idx += qs(condRaw)));
    const thenQ = qs(thenRaw);
    const thenVals = call.values.slice(idx, (idx += thenQ));
    const fires = /@>\s*ARRAY\[/.test(condRaw)
      ? Array.isArray(condVals[0]) && condVals[0].includes(condRaw.match(/ARRAY\['([^']+)'\]/)?.[1])
      : condVals[0] === true;
    if (fires) return thenQ === 0 && /\bNULL\b/i.test(thenRaw) ? null : (thenVals[0] ?? null);
  }
  // ELSE is either a bare `p.<col>` (the old sentinel's preserve arm) or `COALESCE(<bound>, p.col)`
  // (the shipped shape), where a non-null binding SETS and a null one falls through to stored.
  return /COALESCE\s*\(/i.test(elsePart) ? (call.values.slice(idx, idx + qs(elsePart))[0] ?? stored) : stored;
};

const callMatching = (re) => {
  const hits = stubState.sqlCalls.filter((c) => re.test(c.text));
  expect(hits, `no statement matched ${re}`).toHaveLength(1);
  return hits[0];
};
const sourceLookups = () => stubState.sqlCalls.filter((c) => /FROM public\.source\b/.test(c.text));

// Routes by statement so the source probes and the write can answer differently — a single blanket
// sqlHandler cannot express "this id is live and that one is not", which is the whole subject of the
// liveness block below.
const routeSql = ({ live = [ORIGINATOR, SHOP], updated = [{ id: PLANT }] } = {}) => (text, values) => {
  if (/FROM public\.source\b/.test(text)) return live.includes(values[0]) ? [{ ok: 1 }] : [];
  if (/SELECT gn\.status AS old_status/.test(text)) return [{ old_status: 'active', proj_id: PROJECT }];
  if (/UPDATE public\.garden_node p/.test(text)) return updated;
  if (/INSERT INTO public\.garden_node/.test(text)) return [{ id: PLANT }];
  return [];
};

// The EXACT shape PlantingEditor's handleSave produces (src/components/PlantingEditor.jsx:249-273) —
// the point of the preservation cases is that this payload is what the real client sends, so an
// invented body that happened to omit the two keys would prove nothing about the screens in
// production. Neither key appears, and that absence IS the fixture.
const plantingEditorPayload = () => ({
  name: 'Aji Charapita',
  variety: 'Aji Charapita',
  variety_id: 'd58b5155-0c23-4365-bfad-30549b8ca069',
  quantity: 1,
  notes: null,
  status: 'active',
  sown_at: '2026-03-14',
  sown_at_approx: false,
  qty_initial: 1,
  seeds_sown: 6,
  seeds_germinated: 4,
  source_type: 'seed_packet',
  source_ref: 'Lot 4421',
  source_generation: null,
  lineage_note: null,
  parent_plant_id: null,
  container_type: 'fabric_bag',
  container_size: '5 gal',
  location_id: null,
});

const createPayload = () => ({
  name: 'Cascadia Snap Pea',
  quantity: 2,
  status: 'active',
});

const put = (body, id = PLANT) => ({
  requestContext: { http: { method: 'PUT' } },
  rawPath: `/api/plants/${id}`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const post = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/api/plants',
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = routeSql();
});

// BUG-PLANTSOURCEIDCLEAR-001 REVISED THIS BLOCK. It used to assert that a bare `source_id: null`
// CLEARS the column — the presence sentinel — and that assertion was correct against the design of
// the day. The design changed because that shape cost 7 live prod rows their provenance: clearing
// moved to the `clear` channel and presence now only SETS. These cases therefore red on purpose
// against the old code, which is a test encoding a decision that was reversed, not a gap.
// The clear cases live in the BUG-PLANTSOURCEIDCLEAR-001 describes below.
describe('V4-SOURCEREG-001 PUT — a bare null is no longer a clear', () => {
  it('does NOT clear source_id on an explicit null the request did not ask to clear', async () => {
    const { status } = parse(await handler(put({ ...plantingEditorPayload(), source_id: null })));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE public\.garden_node p/);
    expect(resolveCase(call, 'source_id', STORED)).toBe(STORED);
    // The clear arm must be the one guarding NULL, not a bare assignment.
    expect(call.text).toMatch(/\bsource_id\s*= CASE WHEN \?\s*@> ARRAY\['source_id'\] THEN NULL ELSE COALESCE\(/);
  });

  it('needs no liveness lookup for a null — a null is not an id to check', async () => {
    const { status } = parse(await handler(put({ source_id: null, acquired_from_source_id: null })));
    expect(status).toBe(200);
    expect(sourceLookups()).toHaveLength(0);
  });
});

describe('V4-SOURCEREG-001 PUT — an omitted key must not touch the column', () => {
  it('leaves source_id alone when the real editor payload does not mention it', async () => {
    const { status } = parse(await handler(put(plantingEditorPayload())));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE public\.garden_node p/);
    // Structure: an ELSE arm that re-reads the stored column.
    // Structure: a preserve arm that re-reads the stored column…
    expect(call.text).toMatch(/\bsource_id\s*= CASE[\s\S]*?COALESCE\(\?, p\.source_id\) END/);
    // …AND the value that actually resolves. Without the second assertion a CASE hardwired to a
    // constant would satisfy the first while writing null into the column.
    expect(resolveCase(call, 'source_id', STORED)).toBe(STORED);
  });

  it('leaves acquired_from_source_id alone when the real editor payload does not mention it', async () => {
    const { status } = parse(await handler(put(plantingEditorPayload())));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE public\.garden_node p/);
    expect(call.text).toMatch(/\bacquired_from_source_id\s*= CASE[\s\S]*?COALESCE\(\?, p\.acquired_from_source_id\) END/);
    expect(resolveCase(call, 'acquired_from_source_id', STORED)).toBe(STORED);
  });

  it('issues no source lookup at all when neither key is present', async () => {
    // Every PUT in production today takes this branch — nothing in src/ sends either key — so the
    // cost of this feature on the deployed app has to be zero round trips, not one cheap one.
    const { status } = parse(await handler(put(plantingEditorPayload())));
    expect(status).toBe(200);
    expect(sourceLookups()).toHaveLength(0);
  });
});

describe('V4-SOURCEREG-001 — liveness', () => {
  it('400s naming source_id when it points at a soft-deleted source, and not its sibling', async () => {
    stubState.sqlHandler = routeSql({ live: [SHOP] });
    const { status, body } = parse(await handler(put({ source_id: GONE, acquired_from_source_id: SHOP })));
    expect(status).toBe(400);
    expect(body.error).toBe('source_id does not match a source you can use');
    expect(body.error).not.toContain('acquired_from');
    // A rejected write must leave no row edited.
    expect(stubState.sqlCalls.filter((c) => /UPDATE public\.garden_node p/.test(c.text))).toHaveLength(0);
  });

  it('400s naming acquired_from_source_id when THAT one is the dead id', async () => {
    stubState.sqlHandler = routeSql({ live: [ORIGINATOR] });
    const { status, body } = parse(await handler(put({ source_id: ORIGINATOR, acquired_from_source_id: GONE })));
    expect(status).toBe(400);
    expect(body.error).toBe('acquired_from_source_id does not match a source you can use');
  });

  it('asks the liveness question with deleted_at IS NULL and binds the id under test', async () => {
    // The DB FK proves the row EXISTS and is blind to deleted_at, so this predicate is the entire
    // difference between the check and no check at all.
    await handler(put({ source_id: ORIGINATOR }));
    const [probe] = sourceLookups();
    expect(probe.text).toMatch(/SELECT 1 FROM public\.source WHERE id = \?\s*AND deleted_at IS NULL/);
    expect(probe.values).toEqual([ORIGINATOR]);
  });

  it('400s a malformed uuid with ZERO statements issued', async () => {
    // 22P02 is not mapped by this handler's catch, so an unfiltered id would surface as an opaque
    // 500. Zero statements also pins the ORDER: the check runs before the ownership pre-flight.
    const { status, body } = parse(await handler(put({ source_id: 'Johnnys Selected Seeds' })));
    expect(status).toBe(400);
    expect(body.error).toBe('source_id does not match a source you can use');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('applies the same check on POST', async () => {
    stubState.sqlHandler = routeSql({ live: [] });
    const { status, body } = parse(await handler(post({ ...createPayload(), source_id: GONE })));
    expect(status).toBe(400);
    expect(body.error).toBe('source_id does not match a source you can use');
    expect(stubState.sqlCalls.filter((c) => /INSERT INTO public\.garden_node/.test(c.text))).toHaveLength(0);
  });
});

describe('V4-SOURCEREG-001 — distinctness', () => {
  it('400s a body naming one source twice, on PUT, with no round trip', async () => {
    const { status, body } = parse(await handler(put({ source_id: ORIGINATOR, acquired_from_source_id: ORIGINATOR })));
    expect(status).toBe(400);
    expect(body.error).toBe('source_id and acquired_from_source_id must name different sources');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('400s the same body on POST, with no round trip', async () => {
    const { status, body } = parse(await handler(post({ ...createPayload(), source_id: SHOP, acquired_from_source_id: SHOP })));
    expect(status).toBe(400);
    expect(body.error).toBe('source_id and acquired_from_source_id must name different sources');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('does NOT treat two nulls as a collision', async () => {
    // NULL means "not recorded", never "the same place as the other one". Two unrecorded facts are
    // not one duplicated fact, and rejecting them would make a plain clear-both request unsendable.
    const { status } = parse(await handler(put({ source_id: null, acquired_from_source_id: null })));
    expect(status).toBe(200);
  });

  it('answers the PARTIAL collision — the one the body compare cannot see — with a sentence', async () => {
    // A body sending only acquired_from_source_id that matches the row's STORED source_id reaches
    // chk_plants_source_distinct, because no validator on this verb reads the pre-update row. The
    // old generic arm answered `Constraint violation: chk_plants_source_distinct`.
    stubState.sqlHandler = (text, values) => {
      if (/FROM public\.source\b/.test(text)) return [{ ok: 1 }];
      if (/SELECT gn\.status AS old_status/.test(text)) return [{ old_status: 'active', proj_id: PROJECT }];
      if (/UPDATE public\.garden_node p/.test(text)) {
        const err = new Error('new row violates check constraint');
        err.code = '23514';
        err.constraint = 'chk_plants_source_distinct';
        throw err;
      }
      return [];
    };
    const { status, body } = parse(await handler(put({ acquired_from_source_id: SHOP })));
    expect(status).toBe(400);
    expect(body.error).toBe(
      'The originator and the place you got it from have to be two different sources. Clear one of them, or pick a different one.',
    );
    expect(body.error).not.toContain('chk_');
  });

  it('leaves every OTHER constraint on the generic arm', async () => {
    // The map is keyed by name and consulted first; a constraint that is not in it must keep the
    // text it has today, or this becomes a silent rewrite of unrelated error messages.
    stubState.sqlHandler = (text) => {
      if (/SELECT gn\.status AS old_status/.test(text)) return [{ old_status: 'active', proj_id: PROJECT }];
      if (/UPDATE public\.garden_node p/.test(text)) {
        const err = new Error('nope');
        err.code = '23514';
        err.constraint = 'chk_plants_qty_lost_nonneg';
        throw err;
      }
      return [];
    };
    const { status, body } = parse(await handler(put({ notes: 'x' })));
    expect(status).toBe(400);
    expect(body.error).toBe('Constraint violation: chk_plants_qty_lost_nonneg');
  });
});

describe('V4-SOURCEREG-001 POST — the create path binds both columns', () => {
  it('names both columns in the INSERT column list and binds the ids sent', async () => {
    const { status } = parse(await handler(post({ ...createPayload(), source_id: ORIGINATOR, acquired_from_source_id: SHOP })));
    expect(status).toBe(201);
    const call = callMatching(/INSERT INTO public\.garden_node/);
    // BY POSITION, not toContain: a 40-parameter INSERT would satisfy `values.includes(ORIGINATOR)`
    // from any column, which is how a value bound to the wrong slot passes as proof.
    const cols = call.text
      .slice(call.text.indexOf('(') + 1, call.text.indexOf(')'))
      .split(',').map((s) => s.trim());
    expect(cols).toContain('source_id');
    expect(cols).toContain('acquired_from_source_id');
    expect(call.values[cols.indexOf('source_id')]).toBe(ORIGINATOR);
    expect(call.values[cols.indexOf('acquired_from_source_id')]).toBe(SHOP);
  });

  it('binds null for both when the create says nothing about provenance', async () => {
    const { status } = parse(await handler(post(createPayload())));
    expect(status).toBe(201);
    const call = callMatching(/INSERT INTO public\.garden_node/);
    const cols = call.text
      .slice(call.text.indexOf('(') + 1, call.text.indexOf(')'))
      .split(',').map((s) => s.trim());
    expect(call.values[cols.indexOf('source_id')]).toBe(null);
    expect(call.values[cols.indexOf('acquired_from_source_id')]).toBe(null);
    expect(sourceLookups()).toHaveLength(0);
  });
});

// BUG-PLANTSOURCEIDCLEAR-001 — 7 live prod rows lost their provenance to the case below.
//
// The shape is the one MEASURED in audit_events: a WIDE editor body (it carries quantity and
// location_id, which is what separated the 7 destroyers from the 24 harmless narrow bodies) that
// also carries source_id the client never hydrated. Under the bare presence sentinel, merely
// INCLUDING the key was the clear, so the first save of any planting erased it and answered 200.
//
// These cases assert the WRITTEN VALUE, not the SQL shape. put-seed-validate.test.js recorded why:
// a CASE wired to a constant satisfies a structural check while writing what a bare assignment
// would, so "there is an ELSE arm" is not evidence that the ELSE arm is the one that fires.

describe('BUG-PLANTSOURCEIDCLEAR-001 — an unhydrated null must not erase a stored source', () => {
  it('PRESERVES source_id when a wide editor body carries a null the user never chose', async () => {
    const { status } = parse(await handler(put({
      ...plantingEditorPayload(),
      quantity: 3,             // wide. `quantity, source_id, updated_at, version` is verbatim the
      source_id: null,         // changed-key set of 3 of the 7 destroyed prod rows.
    })));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE public\.garden_node p/);
    expect(resolveCase(call, 'source_id', STORED)).toBe(STORED);
  });

  it('PRESERVES acquired_from_source_id on the same body', async () => {
    const { status } = parse(await handler(put({
      ...plantingEditorPayload(), quantity: 3, acquired_from_source_id: null,
    })));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE public\.garden_node p/);
    expect(resolveCase(call, 'acquired_from_source_id', STORED)).toBe(STORED);
  });

  it('still SETS a source the user actually picked', async () => {
    // The guard must not be a blanket "ignore this column" — that would trade data loss for a dead
    // control, which is the defect V4-SOURCEREG-001 was itself fixing.
    const { status } = parse(await handler(put({ ...plantingEditorPayload(), source_id: ORIGINATOR })));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE public\.garden_node p/);
    expect(resolveCase(call, 'source_id', STORED)).toBe(ORIGINATOR);
  });
});

describe('BUG-PLANTSOURCEIDCLEAR-001 — deliberate clearing still works', () => {
  it('CLEARS source_id when the request explicitly names it in clear[]', async () => {
    // The intent marker. clearPatch emits this only when the LOADED row held a value and the form
    // is now empty (src/lib/clearKeys.js buildClearKeys), i.e. exactly "the user removed it".
    const { status } = parse(await handler(put({
      ...plantingEditorPayload(), source_id: null, clear: ['source_id'],
    })));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE public\.garden_node p/);
    expect(resolveCase(call, 'source_id', STORED)).toBe(null);
  });

  it('CLEARS acquired_from_source_id independently of its sibling', async () => {
    const { status } = parse(await handler(put({
      source_id: ORIGINATOR, acquired_from_source_id: null, clear: ['acquired_from_source_id'],
    })));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE public\.garden_node p/);
    expect(resolveCase(call, 'acquired_from_source_id', STORED)).toBe(null);
    // Clearing one while setting the other in one payload is the "I had these backwards"
    // correction, and it must not be an either/or.
    expect(resolveCase(call, 'source_id', STORED)).toBe(ORIGINATOR);
  });

  it('400s a request that both clears and sets the same column', async () => {
    // validateClear's ambiguity rule. Picking a winner for a contradictory request is the failure
    // mode the clear channel exists to remove, so this must never reach SQL.
    const { status, body } = parse(await handler(put({ source_id: ORIGINATOR, clear: ['source_id'] })));
    expect(status).toBe(400);
    expect(body.error).toBe('source_id cannot be both cleared and set in the same request');
    expect(stubState.sqlCalls.filter((c) => /UPDATE public\.garden_node p/.test(c.text))).toHaveLength(0);
  });
});

describe('V4-SOURCEREG-001 — the write echoes what it wrote', () => {
  it('returns both columns from all three RETURNING lists', async () => {
    // Three, not two, and the third is the trap acquired-mature.test.js recorded: a create with no
    // succession_group_id and no parent_plant_id runs a second UPDATE whose RETURNING REPLACES the
    // response, so widening only the INSERT would leave the commonest create shape answering
    // without the columns it just wrote.
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'index.js'), 'utf8');
    expect(src.match(/RETURNING p\.[^\n]*\bp\.source_id\b[^\n]*\bp\.acquired_from_source_id\b/g))
      .toHaveLength(1);
    expect(src.match(/RETURNING id,[^\n]*[^.]\bsource_id\b[^\n]*[^.]\bacquired_from_source_id\b/g))
      .toHaveLength(2);
  });
});
