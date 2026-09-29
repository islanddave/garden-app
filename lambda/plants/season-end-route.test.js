// End of season (src/pages/SeasonEnd.jsx) — the server half: the GET /api/plants/season-end read, and
// the PUT contract the page's two request bodies rely on.
//
// Runtime, under the house stubs (vitest.config.ts aliases Neon/Clerk/AWS to lambda/_test-stubs) with a
// recording neon: the handler is imported and actually run, so these assert the statements it SENDS
// and the response it BUILDS, not source text. The stub cannot execute SQL — the read was run verbatim
// against live prod inside BEGIN READ ONLY … ROLLBACK on 2026-09-29 (245 rows, 114 of them listed by
// src/lib/seasonEnd.js), which is the evidence it executes; this file holds its predicates in place.
//
// MUTATION-PROVEN (each applied to index.js, RED observed, reverted):
//   · drop `AND pp.archived_at IS NULL` from the season-end read       -> "keeps the grid's live predicates" RED
//   · drop 'status_change' from the last_logged_at NOT IN list          -> "last_logged_at leaves out" RED
//   · drop '/api/plants/season-end' from COLLECTION_PATHS               -> "is a literal route" RED
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

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

// BUCKET is read at module load; without it the hero is never signed and the strip/sign step is untested.
vi.stubEnv('S3_PHOTOS_BUCKET', 'stub-photos-bucket');
const { handler } = await import('./index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const USER = 'user_stub_owner';
const PLANT = '9f1c2b3a-4d5e-4f60-8a71-2b3c4d5e6f70';
const PROJECT = '11112222-3333-4444-8555-666677778888';
const STORED_LOSS = 'weather';

const get = (rawPath) => ({ requestContext: { http: { method: 'GET' } }, rawPath, headers: { authorization: 'Bearer stub-token' } });
const put = (body, id = PLANT) => ({
  requestContext: { http: { method: 'PUT' } }, rawPath: `/api/plants/${id}`,
  headers: { authorization: 'Bearer stub-token' }, body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });
const squash = (s) => s.replace(/\s+/g, ' ');

// The value bound immediately after `re` in a recorded statement.
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};
// What a `col = CASE WHEN clear @> ARRAY['col'] THEN NULL ELSE COALESCE(?, p.col) END` arm writes.
const clearableWrites = (call, col, stored) => {
  const clear = boundAfter(call, new RegExp(`\\b${col}\\s*= CASE WHEN `));
  if (Array.isArray(clear) && clear.includes(col)) return null;
  const v = boundAfter(call, new RegExp(`\\b${col}\\s*= CASE WHEN \\?\\s*@>\\s*ARRAY\\['${col}'\\] THEN NULL ELSE COALESCE\\(`));
  return v ?? stored;
};
const callsMatching = (re) => stubState.sqlCalls.filter((c) => re.test(c.text));

const HERO_PATH = `plants/${PLANT}/hero.jpg`;
const seasonRow = () => ({
  id: PLANT, name: 'Sungold', status: 'fruiting', kind: 'planting', project_id: PROJECT, location_id: 'loc-1',
  featured_photo_id: 'ph-1', featured_is_explicit: true, featured_photo_storage_path: HERO_PATH,
  variety_ref: { name: 'Sungold', crop_type_slug: 'tomato', default_lifecycle: 'tender_perennial' },
  last_logged_at: '2026-09-26T16:00:00.000Z',
});

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
});

describe('GET /api/plants/season-end — the End of season read', () => {
  it('is a literal route, never captured as a planting id by the by-id matcher', () => {
    expect(SRC).toMatch(/COLLECTION_PATHS\s*=\s*\[[^\]]*'\/api\/plants\/season-end'[^\]]*\]/);
    expect(SRC).toMatch(/rawPath === '\/api\/plants\/season-end' && method === 'GET'/);
  });

  it('sends ONE read and no write, and answers { plants } with the hero signed, never its storage path', async () => {
    stubState.sqlHandler = (text) => (/FROM public\.garden_node gp/.test(text) ? [seasonRow()] : []);
    const { status, body } = parse(await handler(get('/api/plants/season-end')));
    expect(status).toBe(200);
    expect(stubState.sqlCalls).toHaveLength(1);
    expect(callsMatching(/\b(UPDATE|INSERT|DELETE)\b/)).toEqual([]);
    expect(Array.isArray(body.plants)).toBe(true);
    const [row] = body.plants;
    expect(row).not.toHaveProperty('featured_photo_storage_path');
    expect(row.featured_photo_view_url).toContain(HERO_PATH);
    expect(row.featured_photo_thumb_url).toContain(`thumbs/${HERO_PATH}`);
    expect(row).toMatchObject({ id: PLANT, kind: 'planting', status: 'fruiting', last_logged_at: '2026-09-26T16:00:00.000Z' });
    expect(row.variety_ref).toEqual({ name: 'Sungold', crop_type_slug: 'tomato', default_lifecycle: 'tender_perennial' });
  });

  it('keeps the grid\'s live predicates: not deleted, not archived, container live and not archived, household-owned', async () => {
    stubState.sqlHandler = () => [];
    await handler(get('/api/plants/season-end'));
    const [call] = stubState.sqlCalls;
    const sql = squash(call.text);
    expect(sql).toMatch(/AND gp\.deleted_at IS NULL/);
    expect(sql).toMatch(/AND gp\.archived_at IS NULL/);
    expect(sql).toMatch(/AND pp\.archived_at IS NULL/);
    expect(sql).toMatch(/\( pp\.created_by = ANY\(\?\) AND pp\.deleted_at IS NULL \)/);
    expect(sql).toMatch(/OR \(gp\.container_id IS NULL AND gp\.created_by = ANY\(\?\)\)/);
    // The ownership arms bind the household scope, never a literal.
    expect(call.values.some((v) => Array.isArray(v) && v.includes(USER))).toBe(true);
  });

  it('returns the raw facts the page decides on: kind, the crop\'s default_lifecycle, last_logged_at', async () => {
    stubState.sqlHandler = () => [];
    await handler(get('/api/plants/season-end'));
    const sql = squash(stubState.sqlCalls[0].text);
    expect(sql).toMatch(/SELECT gp\.id, gp\.display_name AS name, gp\.status, gp\.kind,/);
    expect(sql).toMatch(/'default_lifecycle', \(SELECT ct\.default_lifecycle FROM public\.crop_types ct WHERE ct\.slug = pv\.crop_type_slug AND ct\.deleted_at IS NULL/);
    expect(sql).toMatch(/la\.last_logged_at/);
  });

  it('last_logged_at leaves out the station\'s rain and status edits (the page\'s own Undo writes one)', async () => {
    stubState.sqlHandler = () => [];
    await handler(get('/api/plants/season-end'));
    const sql = squash(stubState.sqlCalls[0].text);
    expect(sql).toMatch(/SELECT max\(el\.event_date\) AS last_logged_at FROM public\.event_log el WHERE el\.plant_id = gp\.id AND el\.deleted_at IS NULL AND el\.event_type NOT IN \('rain', 'status_change'\)/);
  });
});

// The page sends exactly two bodies to PUT /api/plants/:id — { status: 'ended' } to end a planting,
// and { status: <its own prior status> } to put it back. What the route does with each is the contract.
describe('PUT /api/plants/:id — the End of season write and its undo', () => {
  const routeSql = (oldStatus) => (text) => {
    if (/SELECT gn\.status AS old_status/.test(text)) return [{ old_status: oldStatus, proj_id: PROJECT }];
    if (/UPDATE public\.garden_node p/.test(text)) return [{ id: PLANT }];
    return [];
  };

  it('{ status: "ended" } sets the status, preserves every other column, and records a status_change in the same transaction', async () => {
    stubState.sqlHandler = routeSql('fruiting');
    const { status } = parse(await handler(put({ status: 'ended' })));
    expect(status).toBe(200);
    const [update] = callsMatching(/UPDATE public\.garden_node p/);
    expect(boundAfter(update, /\bstatus\s*= COALESCE\(/)).toBe('ended');
    // COALESCE partial update: an absent key binds null and keeps the stored value.
    expect(boundAfter(update, /\bdisplay_name\s*= COALESCE\(/)).toBeNull();
    expect(clearableWrites(update, 'loss_cause', STORED_LOSS)).toBe(STORED_LOSS);
    expect(clearableWrites(update, 'notes', 'kept')).toBe('kept');
    const events = callsMatching(/INSERT INTO event_log/);
    expect(events).toHaveLength(1);
    expect(events[0].values).toContain('status_change');
    expect(callsMatching(/\bDELETE\b|archived_at\s*=/)).toEqual([]);
  });

  it('{ status: <prior> } puts it back with a NEW status_change — nothing is deleted', async () => {
    stubState.sqlHandler = routeSql('ended');
    const { status } = parse(await handler(put({ status: 'fruiting' })));
    expect(status).toBe(200);
    const [update] = callsMatching(/UPDATE public\.garden_node p/);
    expect(boundAfter(update, /\bstatus\s*= COALESCE\(/)).toBe('fruiting');
    const events = callsMatching(/INSERT INTO event_log/);
    expect(events).toHaveLength(1);
    expect(events[0].values).toContain('status_change');
    expect(callsMatching(/\bDELETE\b/)).toEqual([]);
  });
});
