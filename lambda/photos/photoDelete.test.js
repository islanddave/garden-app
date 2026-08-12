// W-DEL — behavioural tests for the photo soft-delete + restore core.
//
// These EXECUTE photoDelete.js against a recording fake `sql`. That distinction is the point: the
// rest of this Lambda's unit tier is static-source (`readFileSync(index.js)` + SQL-text assertions),
// a tier that cannot prove a statement RAN, cannot prove statement ORDER, cannot prove a branch was
// taken, and cannot prove a result was mapped to the right pointer. This repo has shipped an inert
// feature that passed a full green suite for exactly that reason. So the core was extracted into an
// importable module and is driven here through its real control flow.
//
// What this tier still cannot prove: that any UPDATE affects a ROW. Row-level acceptance
// (W-DEL-AC1/AC4/AC7/AC9) is integration-only, by construction.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHOTO_POINTERS, softDeletePhoto, restorePhoto } from './photoDelete.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOUSE = ['user_a', 'user_b'];
const PHOTO = '11111111-1111-4111-8111-111111111111';
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Tagged-template recorder. A statement is returned as a THENABLE carrying its own call record, so
// `sql.transaction([...])` can report exactly which statements were inside it, in order, and hand
// back per-statement rows — which is what makes the positional result mapping testable.
function fakeSql(responder = () => []) {
  const calls = [];
  const transactions = [];
  const fn = (strings, ...values) => {
    const text = norm(strings.join('?'));
    const rows = responder(text, values) ?? [];
    const call = { text, values, rows };
    calls.push(call);
    return { call, rows, then: (res, rej) => Promise.resolve(rows).then(res, rej) };
  };
  fn.calls = calls;
  fn.transactions = transactions;
  fn.transaction = async (stmts) => {
    transactions.push(stmts.map((s) => s.call));
    return stmts.map((s) => s.rows);
  };
  return fn;
}

const LIVE_PHOTO = {
  id: PHOTO, deleted_at: null, project_id: null, location_id: null,
  inventory_item_id: null, space_id: null, intake_status: null, effective_plant_id: null,
};

// Default responder: the pre-read finds a live household photo; the photo UPDATE reports success;
// every pointer null reports nothing changed.
function responderFor(photoRow, pointerRows = {}) {
  return (text) => {
    if (/^SELECT ph\.id/.test(text)) return photoRow ? [photoRow] : [];
    if (/UPDATE photos SET deleted_at = now\(\)/.test(text)) return [{ id: PHOTO, deleted_at: '2026-08-12T00:00:00Z' }];
    if (/UPDATE photos SET deleted_at = NULL/.test(text)) return [{ id: PHOTO, deleted_at: null }];
    for (const [frag, rows] of Object.entries(pointerRows)) if (text.includes(frag)) return rows;
    return [];
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('W-DEL — PHOTO_POINTERS is the one named, complete set (DD4)', () => {
  // Pinned against live prod pg_constraint (2026-08-12): 12 FK columns across 8 tables. If a new FK
  // to photos(id) lands, this fails until it is classified — which is the entire mechanism keeping
  // the null set from silently going stale. scripts/preflight-photodelete.sh re-checks it live.
  const LIVE_FKS = [
    'inventory_items.featured_image_id', 'inventory_items.featured_photo_id',
    'locations.featured_image_id', 'locations.featured_photo_id',
    'plant_projects.featured_image_id', 'plant_projects.featured_photo_id',
    'plant_varieties.photo_id',
    'plants.featured_image_id', 'plants.featured_photo_id',
    'preservation_log.photo_id',
    'share_log.photo_id',
    'spaces.featured_photo_id',
  ];

  it('enumerates exactly the live FK set — no more, no less', () => {
    expect(PHOTO_POINTERS.map((p) => `${p.table}.${p.column}`).sort()).toEqual(LIVE_FKS);
  });

  it('classifies share_log as RETAIN and everything else as NULL', () => {
    // A soft delete inside this app cannot retract an external Facebook post, so erasing the local
    // record of it would make the ledger lie. If this ever flips to 'null' the provenance is gone.
    const retain = PHOTO_POINTERS.filter((p) => p.action === 'retain').map((p) => `${p.table}.${p.column}`);
    expect(retain).toEqual(['share_log.photo_id']);
    expect(PHOTO_POINTERS.every((p) => p.action === 'null' || p.action === 'retain')).toBe(true);
  });

  it('routes plants / plant_projects / plant_varieties through their VIEWs (DD5)', () => {
    // The pointer was SET through the view (autoPromoteFeatured writes public.container /
    // public.garden_node; lambda/varieties writes public.cultivar), so it is cleared on the same
    // surface. Base-table triggers still fire either way; the rule is about not having two dialects.
    const surface = (t, c) => PHOTO_POINTERS.find((p) => p.table === t && p.column === c).surface;
    expect(surface('plants', 'featured_photo_id')).toBe('public.garden_node');
    expect(surface('plant_projects', 'featured_photo_id')).toBe('public.container');
    expect(surface('plant_varieties', 'photo_id')).toBe('public.cultivar');
  });

  it('gates ONLY the spaces arm on SPACE_PHOTOS_ENABLED', () => {
    const flagged = PHOTO_POINTERS.filter((p) => p.flag).map((p) => `${p.table}.${p.column}`);
    expect(flagged).toEqual(['spaces.featured_photo_id']);
  });
});

describe('W-DEL — the delete transaction', () => {
  it('issues ONE transaction containing set_config + the photo UPDATE + every null arm, in order', async () => {
    const sql = fakeSql(responderFor(LIVE_PHOTO));
    await softDeletePhoto(sql, { photoId: PHOTO, householdIds: HOUSE, userId: 'user_a', spaceEnabled: true });

    // Loose statements are the failure this guards: the neon driver auto-commits each tagged
    // template individually, so an un-transacted version can leave the photo deleted with its
    // pointers intact — a hero pointing at a photo no gallery will show, unclearable.
    expect(sql.transactions).toHaveLength(1);
    const tx = sql.transactions[0];
    const nullArms = PHOTO_POINTERS.filter((p) => p.action === 'null');
    expect(tx).toHaveLength(2 + nullArms.length);

    // Statement 0 — the actor GUC. trg_audit_plant_varieties reads app.actor_clerk_sub and records
    // 'system' without it; transaction-local (`true`) so it cannot leak to a pooled connection.
    expect(tx[0].text).toMatch(/SELECT set_config\('app\.actor_clerk_sub', \?, true\)/);
    expect(tx[0].values).toEqual(['user_a']);

    // Statement 1 — the soft delete itself.
    expect(tx[1].text).toContain('UPDATE photos SET deleted_at = now()');
    expect(tx[1].text).toContain('created_by = ANY(?)');
    expect(tx[1].text).toContain('AND deleted_at IS NULL');

    // Statements 2..N — one per null pointer, in PHOTO_POINTERS order, on the declared surface.
    nullArms.forEach((p, i) => {
      const t = tx[i + 2].text;
      expect(t, `${p.table}.${p.column}`).toContain(`UPDATE ${p.surface} SET ${p.column} = NULL`);
      expect(t, `${p.table}.${p.column}`).toContain(`WHERE ${p.column} = ?`);
      expect(t, `${p.table}.${p.column}`).toContain('RETURNING id');
      expect(tx[i + 2].values).toEqual([PHOTO]);
    });
  });

  it('omits the spaces arm when SPACE_PHOTOS_ENABLED is off, and never names spaces.deleted_at', async () => {
    const off = fakeSql(responderFor(LIVE_PHOTO));
    await softDeletePhoto(off, { photoId: PHOTO, householdIds: HOUSE, userId: 'user_a', spaceEnabled: false });
    expect(off.transactions[0].some((c) => /UPDATE public\.spaces/.test(c.text))).toBe(false);

    const on = fakeSql(responderFor(LIVE_PHOTO));
    await softDeletePhoto(on, { photoId: PHOTO, householdIds: HOUSE, userId: 'user_a', spaceEnabled: true });
    const spaces = on.transactions[0].find((c) => /UPDATE public\.spaces/.test(c.text));
    expect(spaces).toBeTruthy();
    // `spaces` has no deleted_at column. Asserting one raises 42703 — INSIDE a transaction, so it
    // would abort the whole delete rather than silently no-op.
    expect(spaces.text).not.toMatch(/deleted_at/);
  });

  it('NEGATIVE — never hard-deletes, never touches share_log, never names created_by in a SET', async () => {
    const sql = fakeSql(responderFor(LIVE_PHOTO));
    await softDeletePhoto(sql, { photoId: PHOTO, householdIds: HOUSE, userId: 'user_a', spaceEnabled: true });
    for (const c of sql.calls) {
      // Soft-Delete-Only Rule. A hard delete would also be BLOCKED by preservation_log
      // (ON DELETE NO ACTION) and would silently destroy share history (ON DELETE CASCADE).
      expect(c.text, c.text).not.toMatch(/DELETE\s+FROM/i);
      expect(c.text, c.text).not.toMatch(/\bTRUNCATE\b/i);
      // share_log.photo_id is the LEDGER pointer — retained by classification, not by omission.
      expect(c.text, c.text).not.toMatch(/share_log/i);
      // prevent_ownership_transfer guards six of the target tables; a NULL -> value write on
      // created_by counts as a transfer and raises.
      expect(norm(c.text).split(/\bWHERE\b/)[0], c.text).not.toMatch(/\bSET\b[\s\S]*created_by\s*=/);
    }
  });

  it('maps each RETURNING set to its own pointer — {table, column, id}, two columns on one table', async () => {
    // A photo that is BOTH a plant hero and that plant's deprecated featured_image, plus the hero of
    // two containers. 22 photos on prod are the hero of 2+ parents today, which is why the contract
    // is a {table,column,id} array and not a flat id list.
    const sql = fakeSql(responderFor(LIVE_PHOTO, {
      'UPDATE public.garden_node SET featured_photo_id': [{ id: 'plant-1' }],
      'UPDATE public.garden_node SET featured_image_id': [{ id: 'plant-9' }],
      'UPDATE public.container SET featured_photo_id': [{ id: 'proj-1' }, { id: 'proj-2' }],
    }));
    const { status, body } = await softDeletePhoto(sql, { photoId: PHOTO, householdIds: HOUSE, userId: 'user_a', spaceEnabled: true });

    expect(status).toBe(200);
    expect(body.id).toBe(PHOTO);
    expect(body.deleted_at).toBe('2026-08-12T00:00:00Z');
    // Positional mapping is the fragile part: swapping two arms would still produce a plausible
    // array. Pinning table+column+id together is what makes such a swap visible.
    expect(body.affected).toEqual([
      { table: 'plants', column: 'featured_photo_id', id: 'plant-1' },
      { table: 'plants', column: 'featured_image_id', id: 'plant-9' },
      { table: 'plant_projects', column: 'featured_photo_id', id: 'proj-1' },
      { table: 'plant_projects', column: 'featured_photo_id', id: 'proj-2' },
    ]);
  });

  it('404s an unknown or foreign photo without issuing any write', async () => {
    // Same generic 404 for both — a distinct status would be an existence oracle for another
    // household's photo ids, which every other route in this Lambda deliberately avoids.
    const sql = fakeSql(responderFor(null));
    const { status, body } = await softDeletePhoto(sql, { photoId: PHOTO, householdIds: HOUSE, userId: 'user_a' });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Photo not found' });
    expect(sql.transactions).toHaveLength(0);
    expect(sql.calls).toHaveLength(1);
  });

  it('404s a malformed id before any SQL is issued', async () => {
    const sql = fakeSql(responderFor(LIVE_PHOTO));
    expect((await softDeletePhoto(sql, { photoId: 'not-a-uuid', householdIds: HOUSE })).status).toBe(404);
    expect(sql.calls).toHaveLength(0);
  });

  it('W-DEL-AC2 — a second DELETE is a 200 that does NOT re-stamp deleted_at', async () => {
    // deleted_at is the only forensic marker of when the delete happened, and the documented
    // rollback (`UPDATE photos SET deleted_at = NULL WHERE deleted_at > <deploy ts>`) is correct
    // ONLY because a re-delete cannot move it. Two independent guards, both asserted:
    const already = { ...LIVE_PHOTO, deleted_at: '2026-08-01T00:00:00Z' };
    const sql = fakeSql(responderFor(already));
    const { status, body } = await softDeletePhoto(sql, { photoId: PHOTO, householdIds: HOUSE, userId: 'user_a' });
    expect(status).toBe(200);
    expect(body.deleted_at).toBe('2026-08-01T00:00:00Z');
    expect(body.already_deleted).toBe(true);
    // (1) the early return — no transaction at all.
    expect(sql.transactions).toHaveLength(0);

    // (2) even if the early return were removed, the UPDATE itself carries `deleted_at IS NULL`, so
    // a concurrent second delete still cannot re-stamp.
    const live = fakeSql(responderFor(LIVE_PHOTO));
    await softDeletePhoto(live, { photoId: PHOTO, householdIds: HOUSE, userId: 'user_a' });
    expect(live.transactions[0][1].text).toMatch(/UPDATE photos SET deleted_at = now\(\)[\s\S]*AND deleted_at IS NULL/);
  });

  it('reports the idempotent case rather than a failure when it loses a delete race', async () => {
    // The photo UPDATE matched 0 rows because a concurrent request deleted it first. The pointer
    // nulls in this transaction were then no-ops against already-null columns, so the end state is
    // still correct — surfacing an error the user cannot act on would be the wrong call.
    const raced = (text) => {
      if (/^SELECT ph\.id/.test(text)) return [{ ...LIVE_PHOTO, deleted_at: null }];
      return [];
    };
    const sql = fakeSql(raced);
    const { status, body } = await softDeletePhoto(sql, { photoId: PHOTO, householdIds: HOUSE, userId: 'user_a' });
    expect(status).toBe(200);
    expect(body.already_deleted).toBe(true);
    expect(body.affected).toEqual([]);
  });
});

describe('W-DEL / DD8 — restore is the durable recovery path', () => {
  const DELETED = { ...LIVE_PHOTO, deleted_at: '2026-08-12T00:00:00Z' };

  it('clears deleted_at, household-scoped, and only from the deleted state', async () => {
    const sql = fakeSql(responderFor(DELETED));
    const { status, body } = await restorePhoto(sql, { photoId: PHOTO, householdIds: HOUSE });
    expect(status).toBe(200);
    expect(body).toEqual({ id: PHOTO, deleted_at: null });
    const upd = sql.calls.find((c) => /UPDATE photos SET deleted_at = NULL/.test(c.text));
    expect(upd.text).toContain('created_by = ANY(?)');
    expect(upd.text).toContain('AND deleted_at IS NOT NULL');
  });

  it('404s unknown/foreign, and is idempotent on an already-live photo', async () => {
    expect((await restorePhoto(fakeSql(responderFor(null)), { photoId: PHOTO, householdIds: HOUSE })).status).toBe(404);
    const live = fakeSql(responderFor(LIVE_PHOTO));
    const { status, body } = await restorePhoto(live, { photoId: PHOTO, householdIds: HOUSE });
    expect(status).toBe(200);
    expect(body.already_restored).toBe(true);
    expect(live.calls.some((c) => /UPDATE photos/.test(c.text))).toBe(false);
  });

  it('replays the hero on every parent the photo is linked to, guarded on featured_photo_id IS NULL', async () => {
    // DD8: an undo that clears deleted_at WITHOUT replaying the pointers leaves the photo
    // un-featured everywhere — reproducing D1's shape via the fix for D1.
    const parented = {
      ...DELETED, project_id: 'proj-1', location_id: 'loc-1',
      inventory_item_id: 'inv-1', space_id: 'space-1', effective_plant_id: 'plant-1',
    };
    const sql = fakeSql(responderFor(parented));
    await restorePhoto(sql, { photoId: PHOTO, householdIds: HOUSE, spaceEnabled: true });

    const replays = sql.calls.filter((c) => /SET featured_photo_id = \?/.test(c.text));
    expect(replays).toHaveLength(4 + 1); // container, garden_node, locations, inventory_items, spaces
    for (const c of replays) {
      // The guard is what makes this a RESTORE rather than a takeover: a hero the user re-picked
      // while the photo was deleted wins. Drop it and restore silently displaces a live choice.
      expect(c.text, c.text).toContain('featured_photo_id IS NULL');
      expect(c.text, c.text).toContain('created_by = ANY(?)');
      expect(c.values[0]).toBe(PHOTO);
    }
    // spaces has no deleted_at column — asserting one 42703s and the replay silently never happens.
    expect(replays.find((c) => /UPDATE public\.spaces/.test(c.text)).text).not.toMatch(/deleted_at/);
  });

  it('THE LOAD-BEARING ONE — the plant replay is EVENT-INCLUSIVE, not photos.plant_id only', async () => {
    // EventNew logs event photos with {project_id, event_id} and NO plant_id; 123 of prod's 250
    // explicit plant heroes are attached that way. A photos.plant_id-only replay would silently fail
    // to restore the MAJORITY of plant heroes — and would pass any "does it replay?" style
    // assertion. The pre-read COALESCEs photos.plant_id with the event's plant_id, which is
    // byte-for-byte the linkage lambda/plants' set-featured validator enforces at WRITE time. The
    // replay must never be STRICTER than the write, or the user re-picks and the next restore drops
    // it again — forever.
    const eventPhoto = { ...DELETED, plant_id: null, effective_plant_id: 'plant-from-event' };
    const sql = fakeSql(responderFor(eventPhoto));
    await restorePhoto(sql, { photoId: PHOTO, householdIds: HOUSE });

    const pre = sql.calls[0];
    expect(pre.text).toContain('LEFT JOIN public.event_log e ON e.id = ph.event_id');
    expect(pre.text).toContain('COALESCE(ph.plant_id, e.plant_id) AS effective_plant_id');

    const plantReplay = sql.calls.find((c) => /UPDATE public\.garden_node/.test(c.text));
    expect(plantReplay).toBeTruthy();
    expect(plantReplay.values).toContain('plant-from-event');
  });

  it('does NOT event-widen the project / location / inventory / space replays', async () => {
    // Each of those validators requires an EXACT column match at write time. A replay looser than
    // its own write validator sets a hero the write would refuse — the same divergence as above, in
    // the opposite direction.
    const sql = fakeSql(responderFor({ ...DELETED, project_id: null, effective_plant_id: 'p1' }));
    await restorePhoto(sql, { photoId: PHOTO, householdIds: HOUSE, spaceEnabled: true });
    expect(sql.calls.some((c) => /UPDATE public\.container/.test(c.text))).toBe(false);
    expect(sql.calls.some((c) => /UPDATE public\.locations/.test(c.text))).toBe(false);
    expect(sql.calls.some((c) => /UPDATE public\.inventory_items/.test(c.text))).toBe(false);
    expect(sql.calls.some((c) => /UPDATE public\.spaces/.test(c.text))).toBe(false);
  });

  it('NEGATIVE — restore never nulls a pointer and never hard-deletes', async () => {
    const sql = fakeSql(responderFor({ ...DELETED, project_id: 'proj-1', effective_plant_id: 'plant-1' }));
    await restorePhoto(sql, { photoId: PHOTO, householdIds: HOUSE, spaceEnabled: true });
    for (const c of sql.calls) {
      expect(c.text, c.text).not.toMatch(/SET\s+\w*photo\w*_id\s*=\s*NULL/i);
      expect(c.text, c.text).not.toMatch(/DELETE\s+FROM/i);
      expect(c.text, c.text).not.toMatch(/share_log/i);
    }
  });

  it('maps a 23505 on idx_photos_content_hash_uniq to a typed 409, not a 500', async () => {
    // The unique index is PARTIAL (`WHERE content_hash IS NOT NULL AND deleted_at IS NULL`), so a
    // deleted row sits OUTSIDE it and coming back inside collides if the same bytes were
    // re-uploaded meanwhile. Inert on prod today (content_hash is NULL on all 1253 live rows) —
    // which is exactly why it needs a test rather than a smoke check.
    const boom = Object.assign(new Error('duplicate key'), { code: '23505' });
    const sql = fakeSql((text) => {
      if (/^SELECT ph\.id/.test(text)) return [DELETED];
      if (/UPDATE photos SET deleted_at = NULL/.test(text)) throw boom;
      return [];
    });
    const { status, body } = await restorePhoto(sql, { photoId: PHOTO, householdIds: HOUSE });
    expect(status).toBe(409);
    expect(body.code).toBe('photo_duplicate');
  });

  it('re-throws a non-23505 failure rather than masking it as a 409', async () => {
    const sql = fakeSql((text) => {
      if (/^SELECT ph\.id/.test(text)) return [DELETED];
      if (/UPDATE photos SET deleted_at = NULL/.test(text)) throw Object.assign(new Error('boom'), { code: '08006' });
      return [];
    });
    await expect(restorePhoto(sql, { photoId: PHOTO, householdIds: HOUSE })).rejects.toThrow('boom');
  });

  it('keeps the hero replay NON-FATAL — a failed replay still returns the restored photo', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sql = fakeSql((text) => {
      if (/^SELECT ph\.id/.test(text)) return [{ ...DELETED, project_id: 'proj-1' }];
      if (/UPDATE photos SET deleted_at = NULL/.test(text)) return [{ id: PHOTO, deleted_at: null }];
      if (/UPDATE public\.container/.test(text)) throw new Error('replay exploded');
      return [];
    });
    const { status, body } = await restorePhoto(sql, { photoId: PHOTO, householdIds: HOUSE });
    expect(status).toBe(200);
    expect(body.deleted_at).toBeNull();
  });
});

// The one thing the behavioural tests above structurally CANNOT see: whether the handler ever calls
// this module. A perfectly tested core nobody routes to is an inert feature that ships green — the
// exact failure mode this repo has already paid for. index.js is not importable from the repo root,
// so the wiring check is source-level by necessity; it is deliberately narrow and paired with the
// behaviour above rather than standing in for it.
describe('W-DEL — the routes are actually wired (anti-inert-feature)', () => {
  const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8').split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1')).join('\n');

  it('imports the core and dispatches DELETE /api/photos/:id to softDeletePhoto', () => {
    expect(SRC).toMatch(/import \{[^}]*softDeletePhoto[^}]*\} from '\.\/photoDelete\.js'/);
    const i = SRC.indexOf("if (idMatch && method === 'DELETE')");
    expect(i, 'no DELETE branch on the bare-:id route').toBeGreaterThan(-1);
    const block = SRC.slice(i, i + 400);
    expect(block).toMatch(/softDeletePhoto\(sql, \{/);
    expect(block).toMatch(/householdIds/);
    expect(block).toMatch(/spaceEnabled: spacePhotosEnabled/);
  });

  it('dispatches POST /api/photos/:id/restore to restorePhoto', () => {
    const i = SRC.indexOf('/^\\/api\\/photos\\/([^/]+)\\/restore$/');
    expect(i, 'no restore route').toBeGreaterThan(-1);
    expect(SRC.slice(i, i + 400)).toMatch(/restorePhoto\(sql, \{/);
  });

  it('the DELETE branch precedes the 405 fallthrough', () => {
    // _harness.js records that strict rawPath guards 405'd every request until the payload shape was
    // fixed. A DELETE that lands after the fallthrough returns 405 and every downstream assertion
    // then passes or fails for the wrong reason (W-DEL-AC0).
    expect(SRC.indexOf("if (idMatch && method === 'DELETE')"))
      .toBeLessThan(SRC.indexOf("resp(405, { error: 'Method not allowed' })"));
  });

  it('the PATCH prev CTE filters deleted_at — W-DEL makes an invisible-row PATCH routine', () => {
    const i = SRC.indexOf('WITH prev AS (');
    expect(i).toBeGreaterThan(-1);
    const end = SRC.indexOf('UPDATE photos p', i);
    expect(end).toBeGreaterThan(i);
    expect(SRC.slice(i, end)).toMatch(/AND deleted_at IS NULL/);
  });
});

describe('W-DEL — the Soft-Delete-Only Rule at the module level', () => {
  it('the module imports no S3 client and issues no object delete', () => {
    // DD2: the S3 object is retained. S3 lifecycle/GC is explicitly out of scope, and "deleted" is
    // therefore not "immediately unreachable" — an already-issued 900s presign keeps serving, and
    // the service worker's cache-first image cache keeps serving until CACHE_VERSION moves.
    const src = readFileSync(resolve(__dirname, 'photoDelete.js'), 'utf8');
    expect(src).not.toMatch(/@aws-sdk\/client-s3/);
    expect(src).not.toMatch(/DeleteObjectCommand/);
  });
});
