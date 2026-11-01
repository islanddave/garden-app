// /api/varieties: the plant varieties reference table (Layer 1 canonical reference). Mirrors
// lambda/plants/index.js + lambda/inventory-items/index.js.
//
// Auth: Clerk JWT verified per request; userId = JWT.sub. Scope is enforced in WHERE clauses (Postgres
// RLS is vestigial under Neon).
//   - GET (list/by-id): globally readable (any authenticated user, any non-deleted row)
//   - POST: owner-stamped (created_by = JWT.sub)
//   - PUT/DELETE: HOUSEHOLD-scoped plus a managed-principal arm (see ./authz.js). A foreign household
//     still reaches nothing. NOT a general widening.
//   - GET /api/varieties/crop-types: globally readable controlled vocabulary
//   - GET /api/varieties/crop-types/admin, POST /api/varieties/crop-types/retire, and the restore arm of
//     POST /api/varieties/crop-types: ADMIN only, fail-closed on ADMIN_CLERK_SUBS (./crop-type-admin.js)
//   - GET/POST /api/varieties/{sources,source-kinds}: the provenance registry, same contract as
//     crop-types: globally readable, owner-stamped on write
//   - GET/PATCH /api/varieties/sources/:id: one live source; PATCH is partial and audited, household
//     members may edit any live source, anyone else only their own (authz.js)
//   - POST /api/varieties/blend: finds or creates the named mix for a set of varieties, body
//     { component_variety_ids: uuid[], create: boolean }, both required; create:false never writes.
//     Its statements and rules live in ./blend.js, the only writer of variety_rank = 'blend' and of
//     blend_key. Both are projected by every full-row read and both write replies below; neither is
//     PUT-writable. The restore arm answers a unique-index clash with a 409 sentence.
//
// Audit: trigger trg_audit_plant_varieties writes to audit_events and reads the actor from
// app.actor_clerk_sub. Every write goes through withActor() (./audit-actor.js), which sets it after
// BEGIN and refuses an absent actor: a NULL bind would silently set the GUC to '' rather than leave it
// unset, which the trigger's COALESCE cannot catch (BUG-VARIETYACTOREMPTY-001).
//
// Rate limits: plant_varieties.create 60/hour per actor; plant_varieties.update 120/hour per actor.
//
// Columns flow through public.cultivar (the auto-updatable view over plant_varieties). Optional columns
// share one contract: omitted = COALESCE no-op on PUT, NULL on POST. Bad crop_type_slug -> FK 23503 -> 400.
//   - crop_type_slug, lifecycle, scoville_min/max, growth_habit, produces_scape
//   - classify: determinacy, day_length_response, grown_as
//   - sow profile: start_method, start_indoor_weeks_min/max, direct_sow_timing, sow_depth_in,
//     seed_spacing_in, row_spacing_in, days_to_germ_min/max, sow_season, sow_notes
//   - the PUT also writes origin_country, origin_region, breeding_system, breeding_source and
//     scoville_source (the provenance that decides whether the seed card shows "est." on a heat
//     figure) with the same COALESCE + clear contract; GET /:id reads them so the editor seeds from the
//     stored values. POST does not write them. variety_rank is not PUT-writable, with one exception the
//     handler decides itself: Open-pollinated on a row whose rank was never recorded fills
//     variety_rank = 'cultivar' in the same UPDATE (fillsCultivarRank).
// Guarded by select-columns.test.js (static-source).

import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import {
  validateBody, validateCropTypeBody, resolveCropTypeName, validateClear,
  validateSourceBody, validateSourcePatch, validateSourceKindBody, resolveSourceKindName, foldSourceKey, blankToNull,
  normalizeOriginText, touchesBreeding, breedingPairingError, fillsCultivarRank, CONSTRAINT_MESSAGES,
} from './validate.js';
import { applyDerive } from './crop-derive.js';
import { checkRateLimit, withRetryAfter } from './rate-limit.js';
import { householdScope, loadOwnedPhoto, warnRejectedFk } from './household.js';
import { requestContext } from './request-context.js';
import { withActor } from './audit-actor.js';
import { dbErrorReply, logCaughtError } from './db-error.js';
import { loadOwnedProject } from './authz-parents.js';
import { managedPrincipalPatterns, canEditSource, canEditVariety } from './authz.js';
import { blendRoute, restoreConflictMessage } from './blend.js';
import { listForAdmin, retireCropType, restoreCropType } from './crop-type-admin.js';

const CORS = {}; // Lambda URL config owns CORS — handler must not duplicate

// V5-SOURCECONTACT-001 — /api/varieties/sources/:id. The segment is captured loosely and checked
// against UUID_RE in the route, so a malformed id is a 404 there rather than a 22P02 from Postgres.
const SOURCE_ID_RE = /^\/api\/varieties\/sources\/([^/]+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

// Validators live in ./validate.js (pure, unit-testable without runtime deps).

// ── A new cultivar gets a cadence profile ROW, in the same transaction (BUG-CULTIVARNOPROFILE-001) ──
//
// v4-cadencerefill-001's standing guard (post_no_live_planting_lacks_a_cadence_profile) asserts a
// cultivar-scope care_profile row exists for every live planting's variety, and a create path that wrote
// only the plant_varieties row re-opened it each time a cultivar was minted and a planting re-pointed.
//
// WHY THE ROW IS NOT EMPTY. In this data model an EMPTY profile row is a DECISION (Collards' row omits
// every watering key on purpose, and post_collards_silence_is_still_intact guards that silence); an
// ABSENT row is a GAP. Writing `{}` here would convert every future gap into a silent false "decided".
// `_basis:'unresearched'` keeps them apart, following the `_basis:'dave_decision'` label that
// v4-cadencerefill-001 uses for a ratified guess.
//
// WHY IT CARRIES NO WATERING KEY, AND WHY THAT IS THE POINT. v_resolved_care.cadence_scopes only names a
// scope that supplied a non-null water_interval_days{,_container,_inground}, and engine.js's
// resolveCadence adopts the DB profile only when that array is non-empty. Omitting all three leaves
// cadence_scopes = [] and the engine's bundled fallback ladder runs unchanged. The create path knows
// nothing about how often to water a cultivar the user has just invented, and a number here would be a
// horticultural claim with no evidence behind it, wearing a researched row's clothes.
//
// WHAT IS DELIBERATELY ABSENT:
//   * `crop`: free text (BUG-WATERIDENTITYFREETEXT-001 is open on exactly that). Inert while the row
//     carries no cadence key, but live the moment anyone adds one, and minting crop strings at app-write
//     rate is the wrong direction. The controlled crop_type_slug is on the cultivar row.
//   * `genus`: not derivable. crop_types has no genus column, so any slug->genus map would be invention.
//     isSolanaceous() already falls back to crop_type_slug when genus is NULL.
//   * no_calendar_water / water_rule / no_calendar_feed / soil_moisture_target / _seeded: the keys
//     engine.js reads off the RAW db_cadence, bypassing the adopt gate. Any of them here would change a
//     live verdict on day one.
const NEW_CULTIVAR_PROFILE = {
  _source: 'cultivar-create',
  _basis: 'unresearched',
  notes: 'Auto-created with the cultivar so its variety has a cadence profile row '
       + '(DRG-CADENCEFLOOR-001). Carries NO watering keys, so cadence still resolves through the '
       + 'bundled fallback exactly as it did before. _basis:"unresearched" means NOBODY HAS DECIDED '
       + 'YET — the opposite of a deliberately watering-free row like Collards.',
};

// The list cap, shared by both GET list branches (BUG-VARIETIESLIMIT500-001). The unsearched list is what
// VarietyPicker and header Search filter client-side, so a cap below the live count silently drops the
// alphabetically-last cultivars from both. 2000 leaves years of headroom and keeps a full page far
// under Lambda's 6 MB response limit. Hitting it logs to CloudWatch rather than truncating in silence.
export const VARIETY_LIST_CAP = 2000

export const handler = async (event) => {
  // The kit answers OPTIONS and every sign-in refusal (401, the household gate's 403) before any statement.
  const ctx = await requestContext(event, { resp });
  if (ctx.response) return ctx.response;
  const { secrets, userId } = ctx;
  // The kit has already refused an empty sub. This copy, the client and `household` below stay in this file because
  // authz-household.test.js reads all three here, the 401 ahead of the other two.
  if (!userId) return resp(401, { error: 'Unauthorized' });

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/varieties';

  // Write scope for PUT/DELETE. `household` is the caller's own id for a non-member (and whenever
  // GARDEN_HOUSEHOLD_IDS is unset), so the widened predicate degrades to the owner-only behaviour it
  // replaced. `managedPatterns` is [] for anyone who is not a proven household member. Rationale and
  // the membership subtlety live in ./authz.js.
  //
  // The audit actor below is deliberately still ${userId}, never a household id: widening WHO MAY EDIT
  // must not blur WHO DID EDIT.
  const household = householdScope(userId);
  const managedPatterns = managedPrincipalPatterns(household);

  try {
    // Controlled crop-type vocabulary, globally readable. Checked BEFORE the /api/varieties/:id route so
    // "crop-types" is not mis-parsed as a variety id. The admin routes' rules and SQL are in
    // ./crop-type-admin.js; both refuse everyone but an admin before reading anything.
    if (rawPath === '/api/varieties/crop-types/admin') {
      if (method !== 'GET') return resp(405, { error: 'Method not allowed' });
      const out = await listForAdmin(sql, userId, process.env);
      return resp(out.status, out.body);
    }
    if (rawPath === '/api/varieties/crop-types/retire') {
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      const out = await retireCropType(sql, JSON.parse(event.body ?? '{}'), userId, process.env);
      return resp(out.status, out.body);
    }

    if (rawPath === '/api/varieties/crop-types') {
      if (method === 'GET') {
        // search_aliases is in the projection, and this is the ONE response shape in the repo that carries
        // it: the word "cantaloupe" lives only in that column on the 'melon' row, so without it every
        // client filter answers nothing for it.
        //
        // THE NEVER-RENDER RULE STILL HOLDS. The column exists instead of more parentheticals in
        // display_name because display_name is SELECTed as crop_name by lambda/facebook-share/index.js
        // and reaches the text of a public post. That constraint is about RENDERING, not about the byte
        // reaching the browser: this is a controlled-vocabulary list a client filters against, and no
        // share/post path reads it. The dashboard search guards (lambda/dashboard/crop-types-columns.test.js,
        // search.test.js) stay intact because a SEARCH RESULT ROW is a render surface; the client-side
        // counterpart is src/__tests__/cropTypeAliasClient.test.jsx, which asserts the alias text never
        // reaches the DOM.
        const rows = await sql`
          SELECT slug, display_name, default_lifecycle, category, sort_order, dtm_basis, search_aliases
          FROM public.crop_types
          WHERE deleted_at IS NULL
          ORDER BY sort_order ASC, display_name ASC
        `;
        return resp(200, rows);
      }

      // Mint a crop type inline while adding a planting. The vocabulary used to be read-only from the
      // app, so a plant with no matching type had to be saved with crop_type_slug = NULL and vanished
      // from every type-grouped view. Design: always-add-on-the-fly, guarding only the code-coupled
      // slugs. The slug is DERIVED server-side from display_name and never accepted from the caller: it
      // is this table's PRIMARY KEY and the FK target of plant_varieties + preservation_log.
      if (method === 'POST') {
        const body = JSON.parse(event.body ?? '{}');
        // The admin page brings a retired type back by slug, through the same restore arm the name
        // match below reaches. Admin only.
        if (body.restore_slug !== undefined) {
          const out = await restoreCropType(sql, body.restore_slug, userId, process.env);
          return resp(out.status, out.body);
        }
        const err = validateCropTypeBody(body);
        if (err) return resp(400, { error: err });

        const allowed = await checkRateLimit(sql, userId, 'crop_types.create', 20);
        if (!allowed) return withRetryAfter(resp(429, { error: 'Rate limit exceeded — 20/hour for crop_types.create' }));

        // The collision set includes SOFT-DELETED rows: slug is the PK, so a resurrect would violate it.
        const allSlugs = await sql`SELECT slug FROM public.crop_types`;
        const verdict = resolveCropTypeName(body.display_name, allSlugs.map(r => r.slug));

        if (!verdict.ok) {
          if (verdict.reason === 'invalid') {
            return resp(400, { error: 'display_name must contain at least one letter or number' });
          }
          const [row] = await sql`
            SELECT slug, display_name, default_lifecycle, category, sort_order, deleted_at
            FROM public.crop_types WHERE slug = ${verdict.existingSlug}
          `;
          // A previously soft-deleted type is RESTORED rather than refused (Soft-Delete-Only: the row
          // never left), but only for an admin. A type is retired on purpose, so anyone else typing its
          // name is told to ask (a distinct code the inline forms word). The write lives in ./crop-type-admin.js.
          if (row?.deleted_at) {
            const out = await restoreCropType(sql, verdict.existingSlug, userId, process.env, { inline: true });
            return resp(out.status, out.body);
          }
          // Otherwise steer to what already exists. `reason` lets the client word it: exists/plural is
          // benign ("just use it"); coupled_synonym names a second type for a crop the derive engine
          // special-cases, which would silently strip its facets, so that one is a real save.
          return resp(409, {
            error: verdict.reason === 'coupled_synonym'
              ? `"${body.display_name}" is another name for the existing "${row.display_name}" crop type`
              : `Crop type "${row.display_name}" already exists`,
            reason: verdict.reason,
            existing: row,
            hint: 'Use the existing crop type instead of creating a duplicate.',
          });
        }

        const [created] = await sql`
          INSERT INTO public.crop_types (slug, display_name, default_lifecycle, category, sort_order, created_by)
          VALUES (
            ${verdict.slug},
            ${body.display_name.trim()},
            ${body.default_lifecycle ?? null},
            ${body.category ?? null},
            0,
            ${userId}
          )
          RETURNING slug, display_name, default_lifecycle, category, sort_order
        `;
        return resp(201, created);
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // ── The provenance registry: WHO or WHERE a plant or packet came from ──────────────────────
    //
    // These routes hang off the varieties Lambda, like /voice-aliases below, because a new Lambda needs a
    // new Function URL, a new VITE_API_* variable, a repo variable AND a mapping into the build, and the
    // share feature once shipped its code with its endpoint never reaching the bundle. VITE_API_VARIETIES
    // is already wired and proven.
    //
    // CHECKED BEFORE idMatch, like /crop-types, /deleted and /voice-aliases: a single trailing segment is
    // otherwise parsed as a variety id and "sources" 404s as a cultivar.
    //
    // GLOBALLY READABLE, OWNER-STAMPED ON WRITE: the crop-types contract, deliberately NOT the household
    // one used for cultivar PUT/DELETE. A source is a shared reference row (a nursery, a seed company, a
    // person); scoping the LIST would show a second household member an empty picker for every vendor
    // already registered.
    if (rawPath === '/api/varieties/sources') {
      if (method === 'GET') {
        const rows = await sql`
          SELECT id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes
            FROM public.source
           WHERE deleted_at IS NULL
           ORDER BY name ASC
        `;
        return resp(200, rows);
      }

      if (method === 'POST') {
        const body = JSON.parse(event.body ?? '{}');
        const err = validateSourceBody(body);
        if (err) return resp(400, { error: err });

        const allowed = await checkRateLimit(sql, userId, 'source.create', 20);
        if (!allowed) return withRetryAfter(resp(429, { error: 'Rate limit exceeded — 20/hour for source.create' }));

        // kind is an FK into source_kind.slug, checked here as a LIVE slug rather than left to the
        // constraint: a soft-deleted kind still satisfies the FK, and a 23503 surfaces as a 500 the
        // client cannot tell from a transport failure.
        const kind = blankToNull(body.kind);
        if (kind != null) {
          const [liveKind] = await sql`
            SELECT slug FROM public.source_kind WHERE slug = ${kind} AND deleted_at IS NULL
          `;
          if (!liveKind) return resp(400, { error: `kind "${kind}" is not a live source kind` });
        }

        // Collision is on match_key (the generated column uq_source_match_key_live is unique on), folded
        // here in JS so a duplicate STEERS instead of arriving as an unreadable 23505. The set includes
        // soft-deleted rows, and the ordering lets one query serve both cases: that index is PARTIAL
        // (live rows only), so any number of deleted rows may share a key while at most one live row can.
        // NULLS FIRST puts the live one first.
        const matchKey = foldSourceKey(body.name);
        const [hit] = await sql`
          SELECT id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes, deleted_at
            FROM public.source
           WHERE match_key = ${matchKey}
           ORDER BY deleted_at DESC NULLS FIRST
           LIMIT 1
        `;

        if (hit) {
          const existing = {
            id: hit.id, name: hit.name, kind: hit.kind, locality: hit.locality,
            address: hit.address, website_url: hit.website_url, instagram_url: hit.instagram_url,
            facebook_url: hit.facebook_url, notes: hit.notes,
          };
          if (hit.deleted_at) {
            // Soft-Delete-Only: the row never left and the caller is asking for exactly it. Wrapped in the
            // actor transaction because public.source carries trg_audit_source_upd; without the bind the
            // audit snapshot of this restore records 'system'. (public.crop_types has no such trigger,
            // which is why the crop-types restore has no transaction.) The `AND deleted_at IS NOT NULL`
            // keeps a concurrent restore from writing a second, empty audit row.
            const [, restoredRows] = await withActor(sql, userId, () => [
              sql`
                UPDATE public.source
                   SET deleted_at = NULL
                 WHERE id = ${hit.id}
                   AND deleted_at IS NOT NULL
                RETURNING id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes
              `,
            ]);
            if (restoredRows.length) return resp(200, { ...restoredRows[0], restored: true });
            // Lost the race: another writer restored it between the read and the write. The row is live and
            // is the one the caller wants, so fall through and steer to it.
          }
          return resp(409, {
            error: `Source "${hit.name}" already exists`,
            reason: 'exists',
            existing,
            hint: 'Use the existing source instead of creating a duplicate.',
          });
        }

        const [created] = await sql`
          INSERT INTO public.source (name, kind, locality, address, website_url, instagram_url, facebook_url, notes, created_by)
          VALUES (
            ${body.name.trim()},
            ${kind},
            ${blankToNull(body.locality)},
            ${blankToNull(body.address)},
            ${blankToNull(body.website_url)},
            ${blankToNull(body.instagram_url)},
            ${blankToNull(body.facebook_url)},
            ${blankToNull(body.notes)},
            ${userId}
          )
          RETURNING id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes
        `;
        return resp(201, created);
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // ── One source: read it, and edit it ──────────────────────────────────────────────────────
    //
    // The POST above can only CREATE, so a source minted with a name alone could never gain its address
    // or links afterwards (website, Instagram, Facebook, physical address are optional fields).
    //
    // CHECKED BEFORE idMatch. idMatch is single-segment, so "sources/<uuid>" never reaches it today; this
    // sits up here so a later widening of idMatch cannot swallow it.
    //
    // No DELETE. Soft-deleting a source that plants and seed lots point at is a merge question, not an
    // edit, so the route answers 405 rather than a half-thought delete.
    const sourceIdMatch = rawPath.match(SOURCE_ID_RE);
    if (sourceIdMatch) {
      const sourceId = sourceIdMatch[1];
      // A non-uuid id would reach Postgres as 22P02 and come back a 500. It names no row, so 404.
      if (!UUID_RE.test(sourceId)) return resp(404, { error: 'Not found' });

      if (method === 'GET') {
        const [row] = await sql`
          SELECT id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes
            FROM public.source
           WHERE id = ${sourceId}
             AND deleted_at IS NULL
        `;
        if (!row) return resp(404, { error: 'Not found' });
        return resp(200, row);
      }

      if (method === 'PATCH') {
        let body;
        try { body = JSON.parse(event.body ?? '{}'); } catch { return resp(400, { error: 'body must be JSON' }); }
        const err = validateSourcePatch(body);
        if (err) return resp(400, { error: err });

        const allowed = await checkRateLimit(sql, userId, 'source.update', 60);
        if (!allowed) return withRetryAfter(resp(429, { error: 'Rate limit exceeded — 60/hour for source.update' }));

        // Soft-deleted reads as missing: this route edits live rows only; restoring one is the POST's job.
        const [current] = await sql`
          SELECT id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes, created_by
            FROM public.source
           WHERE id = ${sourceId}
             AND deleted_at IS NULL
        `;
        if (!current) return resp(404, { error: 'Not found' });
        // 403, not the cultivar routes' 404: public.source is globally readable, so there is no existence
        // to hide, and "you can't edit this" is the sentence the screen has to say.
        if (!canEditSource(household, userId, current.created_by)) {
          return resp(403, { error: 'You can only edit sources you added' });
        }

        const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
        const name = has('name') ? body.name.trim() : null;
        const kind = has('kind') ? blankToNull(body.kind) : null;
        if (kind != null) {
          const [liveKind] = await sql`
            SELECT slug FROM public.source_kind WHERE slug = ${kind} AND deleted_at IS NULL
          `;
          if (!liveKind) return resp(400, { error: `kind "${kind}" is not a live source kind` });
        }

        // A rename that folds onto ANOTHER live row would raise 23505 on uq_source_match_key_live. Steered
        // here in the POST's own 409 shape so the screen can name the row. Live rows only (the index is
        // partial). A rename that keeps the fold ("Fedco" -> "FEDCO") collides with nothing but itself and
        // skips the probe.
        const steer = (hit) => resp(409, {
          error: `Source "${hit.name}" already exists`,
          reason: 'exists',
          existing: {
            id: hit.id, name: hit.name, kind: hit.kind, locality: hit.locality, address: hit.address,
            website_url: hit.website_url, instagram_url: hit.instagram_url,
            facebook_url: hit.facebook_url, notes: hit.notes,
          },
          hint: 'That name is already another source. Keep this name, or edit the other one.',
        });
        const newKey = name != null ? foldSourceKey(name) : null;
        const probeRename = () => sql`
          SELECT id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes
            FROM public.source
           WHERE match_key = ${newKey}
             AND deleted_at IS NULL
             AND id <> ${sourceId}
           LIMIT 1
        `;
        if (newKey != null && newKey !== foldSourceKey(current.name)) {
          const [hit] = await probeRename();
          if (hit) return steer(hit);
        }

        // PARTIAL: each column is written only when its key is present (`has`), else it keeps its value.
        // Explicit casts on every bind: a NULL parameter carries no type and Postgres will not infer one
        // across CASE for every arm. Inside the actor transaction for the same reason as the restore arm of
        // POST above (trg_audit_source_upd): without the bind the audit row names 'system' instead of the
        // person who made the edit.
        let updatedRows;
        try {
          [, updatedRows] = await withActor(sql, userId, () => [
            sql`
              UPDATE public.source
                 SET name          = CASE WHEN ${has('name')}::boolean          THEN ${name}::text ELSE name END,
                     kind          = CASE WHEN ${has('kind')}::boolean          THEN ${kind}::text ELSE kind END,
                     locality      = CASE WHEN ${has('locality')}::boolean      THEN ${blankToNull(body.locality)}::text ELSE locality END,
                     address       = CASE WHEN ${has('address')}::boolean       THEN ${blankToNull(body.address)}::text ELSE address END,
                     website_url   = CASE WHEN ${has('website_url')}::boolean   THEN ${blankToNull(body.website_url)}::text ELSE website_url END,
                     instagram_url = CASE WHEN ${has('instagram_url')}::boolean THEN ${blankToNull(body.instagram_url)}::text ELSE instagram_url END,
                     facebook_url  = CASE WHEN ${has('facebook_url')}::boolean  THEN ${blankToNull(body.facebook_url)}::text ELSE facebook_url END,
                     notes         = CASE WHEN ${has('notes')}::boolean         THEN ${blankToNull(body.notes)}::text ELSE notes END
               WHERE id = ${sourceId}
                 AND deleted_at IS NULL
              RETURNING id, name, kind, locality, address, website_url, instagram_url, facebook_url, notes
            `,
          ]);
        } catch (e) {
          // Lost a race with another rename between the probe and the write.
          if (e?.code === '23505' && newKey != null) {
            const [hit] = await probeRename();
            if (hit) return steer(hit);
          }
          throw e;
        }
        // Soft-deleted between the read and the write.
        if (!updatedRows?.length) return resp(404, { error: 'Not found' });
        return resp(200, updatedRows[0]);
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // ── The vocabulary source.kind is typed against ───────────────────────────────────────────
    // Same mint contract as crop-types, for the same reason: read-only from the app meant a source with no
    // matching kind had to be saved with kind = NULL, which drops it out of every kind-grouped view. The
    // slug is DERIVED server-side and never accepted from the caller: it is this table's PRIMARY KEY and
    // the FK target of public.source.kind.
    if (rawPath === '/api/varieties/source-kinds') {
      if (method === 'GET') {
        const rows = await sql`
          SELECT slug, display_name, sort_order
            FROM public.source_kind
           WHERE deleted_at IS NULL
           ORDER BY sort_order ASC, display_name ASC
        `;
        return resp(200, rows);
      }

      if (method === 'POST') {
        const body = JSON.parse(event.body ?? '{}');
        const err = validateSourceKindBody(body);
        if (err) return resp(400, { error: err });

        const allowed = await checkRateLimit(sql, userId, 'source_kind.create', 20);
        if (!allowed) return withRetryAfter(resp(429, { error: 'Rate limit exceeded — 20/hour for source_kind.create' }));

        // One read, two collision sets, deliberately asymmetric: slugs come from EVERY row (slug is the PK,
        // so a soft-deleted row still occupies it), labels from the LIVE rows only
        // (uq_source_kind_display_live is PARTIAL, so a retired label blocks nothing).
        const allKinds = await sql`SELECT slug, display_name, sort_order, deleted_at FROM public.source_kind`;
        const liveKinds = allKinds.filter((k) => !k.deleted_at);
        const verdict = resolveSourceKindName(body.display_name, allKinds.map((k) => k.slug), liveKinds);

        if (!verdict.ok) {
          if (verdict.reason === 'invalid') {
            return resp(400, { error: 'display_name must contain at least two letters or numbers' });
          }
          const row = allKinds.find((k) => k.slug === verdict.existingSlug);
          const shape = (k) => ({ slug: k.slug, display_name: k.display_name, sort_order: k.sort_order });
          if (row.deleted_at) {
            // A restore is an INSERT as far as uq_source_kind_display_live is concerned (the row rejoins the
            // live set), so a live row already folding to the same label would make this UPDATE raise 23505.
            // Steer to that live row instead of restoring into a 500.
            const blocker = liveKinds.find(
              (k) => foldSourceKey(k.display_name) === foldSourceKey(row.display_name),
            );
            if (blocker) {
              return resp(409, {
                error: `Source kind "${blocker.display_name}" already exists`,
                reason: 'label',
                existing: shape(blocker),
                hint: 'Use the existing source kind instead of creating a duplicate.',
              });
            }
            const [restored] = await sql`
              UPDATE public.source_kind
                 SET deleted_at = NULL
               WHERE slug = ${verdict.existingSlug}
              RETURNING slug, display_name, sort_order
            `;
            return resp(200, { ...restored, restored: true });
          }
          // `reason` lets the client word it: exists/plural is benign (use that one), label means the
          // name typed folds onto a different-looking row and the DB would have refused it.
          return resp(409, {
            error: `Source kind "${row.display_name}" already exists`,
            reason: verdict.reason,
            existing: shape(row),
            hint: 'Use the existing source kind instead of creating a duplicate.',
          });
        }

        // sort_order is max + 10, NOT the column default of 0: the seeded kinds occupy 10..120 and the head of
        // the list is meant to be the common cases, so a minted kind taking the default would sort above them.
        const [created] = await sql`
          INSERT INTO public.source_kind (slug, display_name, sort_order, created_by)
          VALUES (
            ${verdict.slug},
            ${body.display_name.trim()},
            (SELECT coalesce(max(sort_order), 0) + 10 FROM public.source_kind),
            ${userId}
          )
          RETURNING slug, display_name, sort_order
        `;
        return resp(201, created);
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // ── The recovery path for cultivars (audit I9) ─────────────────────────────────────────────
    //
    // Same contract as lambda/locations and lambda/plants, but the ownership predicate is this Lambda's
    // own (`created_by` OR a managed principal pattern), NOT the household-only shape those use: a
    // cultivar can be owned by a managed importer principal, and scoping this list to `household` alone
    // would hide those rows from the person who can actually restore them.
    //
    // Checked BEFORE idMatch below, like `/api/varieties/crop-types`: a single trailing segment would
    // otherwise be parsed as a variety id.
    if (rawPath === '/api/varieties/deleted' && method === 'GET') {
      const rawLimit = Number(event?.queryStringParameters?.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
      const rows = await sql`
        SELECT id, display_name AS name, crop_type_slug, species, genus, created_at, deleted_at
          FROM public.cultivar
         WHERE deleted_at IS NOT NULL
           AND ( created_by = ANY(${household})
                 OR created_by LIKE ANY(${managedPatterns}::text[]) )
         ORDER BY deleted_at DESC, id DESC
         LIMIT ${limit}
      `;
      return resp(200, { varieties: rows });
    }

    const restoreMatch = rawPath.match(/^\/api\/varieties\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      const varietyId = restoreMatch[1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(varietyId))) {
        return resp(404, { error: 'Not found' });
      }
      const [existing] = await sql`
        SELECT id, deleted_at FROM public.cultivar
         WHERE id = ${varietyId}
           AND ( created_by = ANY(${household})
                 OR created_by LIKE ANY(${managedPatterns}::text[]) )
      `;
      if (!existing) return resp(404, { error: 'Not found or not owner' });
      if (!existing.deleted_at) {
        return resp(200, { id: existing.id, deleted_at: null, already_restored: true });
      }
      // Wrapped in the same set_config transaction the DELETE arm uses: plant_varieties carries
      // trg_audit_plant_varieties, which reads app.actor_clerk_sub, and a restore that skipped it would be
      // anonymous in the audit trail while the delete was attributable. Un-deleting can trip a unique
      // index: the name one (a live variety took the name meanwhile) or the per-creator mix key (the same
      // mix was made again). Either is a plain-English 409 here, never the generic arm's index name.
      let rows;
      try {
        [, rows] = await withActor(sql, userId, () => [
          sql`
            UPDATE public.cultivar
               SET deleted_at = NULL
             WHERE id = ${varietyId}
               AND ( created_by = ANY(${household})
                     OR created_by LIKE ANY(${managedPatterns}::text[]) )
               AND deleted_at IS NOT NULL
            -- Deliberately NOT a full client row. select-columns.test.js treats any RETURNING that
            -- aliases display_name to name as a full-row shape which must list every seed-inventory
            -- column; a restore answers identity + state, and the caller already has the name from
            -- the list it clicked. (No backticks in this comment: it lives inside a JS template
            -- literal, where one would terminate the string.)
            RETURNING id, deleted_at
          `,
        ]);
      } catch (err) {
        if (err?.code === '23505') return resp(409, { error: restoreConflictMessage(err) });
        throw err;
      }
      if (!rows.length) return resp(404, { error: 'Not found or not owner' });
      return resp(200, rows[0]);
    }

    // Learned speech-recognition mishearings for the /log/voice chooser (V5-VOICEALIAS-001).
    //
    // THESE ROUTES LIVE IN THE VARIETIES LAMBDA ON PURPOSE: a new Lambda needs a new Function URL, a new
    // VITE_API_* variable, a repo variable AND a mapping into the build, and a feature once shipped its
    // code with its endpoint never reaching the bundle because the last step was missing.
    // VITE_API_VARIETIES is already wired and proven. The data is variety-scoped anyway.
    //
    // CHECKED BEFORE idMatch, like /crop-types and /deleted: a single trailing segment is otherwise parsed
    // as a variety id and this would 404 as "variety voice-aliases".
    //
    // USER-SCOPED, NOT HOUSEHOLD-SCOPED: the one place this file departs from its neighbours. An alias
    // records how ONE person's speech is misheard, and the recogniser mishears different voices
    // differently, so a second household member inheriting the first's corrections would be steered by
    // evidence about someone else's audio. These read and write ${userId}.
    if (rawPath === '/api/varieties/voice-aliases') {
      if (method === 'GET') {
        // The whole set, unpaginated by design: it is bounded by the phrases one person has corrected, the
        // client needs all of them in memory to resolve an utterance offline-fast, and a partial page would
        // silently stop resolving the aliases it omitted.
        const rows = await sql`
          SELECT heard_key, heard_text, variety_id, hit_count, last_used_at
            FROM public.voice_alias
           WHERE user_id = ${userId}
           ORDER BY heard_key
        `;
        return resp(200, { aliases: rows });
      }

      if (method === 'POST') {
        const body = JSON.parse(event.body ?? '{}');
        const heardKey = String(body?.heard_key ?? '');
        const heardText = String(body?.heard_text ?? '');
        const varietyId = String(body?.variety_id ?? '');

        // VALIDATED HERE AND NOT ONLY BY THE CHECK CONSTRAINT: a constraint violation surfaces as a 500 the
        // client cannot tell from a transport failure, and the one outcome this feature must never have is
        // a correction the user believes was learned and was not.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(varietyId)) {
          return resp(400, { error: 'variety_id must be a uuid' });
        }
        // Mirrors voice_alias_heard_key_normalised_chk AND comboboxInput.looseKey's contract. An
        // un-normalised key inserts cleanly and then never matches a live utterance, which would present as
        // "the app refuses to learn" with nothing in any log.
        if (heardKey !== heardKey.toLowerCase() || /[\s\p{P}]/u.test(heardKey)) {
          return resp(400, { error: 'heard_key must be lowercase with no whitespace or punctuation' });
        }
        if (heardKey.length < 4 || heardKey.length > 120) {
          return resp(400, { error: 'heard_key must be 4-120 characters' });
        }
        if (!heardText.trim()) return resp(400, { error: 'heard_text is required' });

        // The variety must exist and not be deleted. DELIBERATELY THE READ POLICY, NOT THE WRITE ONE: this
        // does not carry the household/managed-principal arm that PUT, DELETE and the recovery reads use.
        // An alias is a PERSONAL ANNOTATION ON A READABLE THING, not an edit of the cultivar: it changes
        // nothing about the variety, is stored against ${userId}, and is invisible to everyone else. Gating
        // it on the write predicate would have the picker offer a cultivar and then refuse to remember
        // what the user calls it. Rule: if a surface can SELECT it, the user may teach a name for it.
        const [variety] = await sql`
          SELECT id FROM public.cultivar
           WHERE id = ${varietyId}
             AND deleted_at IS NULL
        `;
        if (!variety) return resp(404, { error: 'Variety not found' });

        // RETARGET, DO NOT ACCUMULATE. Re-teaching a phrase must move it: a second row would make resolution
        // order-dependent, so the correction would appear to work and then intermittently not. hit_count
        // resets only when the MEANING changes (BUG-VOICEALIASHITCOUNT-001): the voice page re-teaches a
        // known phrase whenever a learned alias offers several plantings and one is tapped, so an
        // unconditional reset zeroed the count on the most-used aliases. Same variety, same meaning: the
        // tally stands. Inside DO UPDATE, `voice_alias.` is the row as it was.
        const [row] = await sql`
          INSERT INTO public.voice_alias (user_id, heard_key, heard_text, variety_id)
               VALUES (${userId}, ${heardKey}, ${heardText}, ${varietyId})
          ON CONFLICT ON CONSTRAINT uq_voice_alias_user_phrase
            DO UPDATE SET variety_id = EXCLUDED.variety_id,
                          heard_text = EXCLUDED.heard_text,
                          hit_count  = CASE WHEN voice_alias.variety_id = EXCLUDED.variety_id
                                            THEN voice_alias.hit_count ELSE 0 END,
                          last_used_at = CASE WHEN voice_alias.variety_id = EXCLUDED.variety_id
                                              THEN voice_alias.last_used_at ELSE NULL END
            RETURNING heard_key, heard_text, variety_id, hit_count, last_used_at
        `;
        return resp(200, row);
      }

      // COUNT A USE (BUG-VOICEALIASHITCOUNT-001). hit_count and last_used_at were read by the GET and reset by
      // the teach but written by nothing, so no alias could be told from one-off noise. The client sends
      // this AFTER the write the alias led to has landed, fire-and-forget, so nothing here can block or
      // fail that write.
      //
      // ON THE EXISTING PATH, as a new METHOD, not a new route (see the header above). PATCH is already in
      // every Function URL's CORS AllowMethods (deploy-lambda.yml, deploy.yml, deploy-staging.yml).
      //
      // SCOPED THREE WAYS, each a guard rather than a filter of convenience:
      //   * user_id = the verified caller: another person's alias is never touched, and there is no
      //     household widening here.
      //   * variety_id must match: a phrase re-taught to another variety since the client loaded its list
      //     is not credited for the meaning that was actually used.
      //   * voice_alias has no soft delete, so a removed alias is a missing row, and an UPDATE cannot
      //     resurrect or count a row that is not there.
      // DISTINCT, so one request counts a phrase once however often it is repeated in the body.
      if (method === 'PATCH') {
        let body;
        try { body = JSON.parse(event.body ?? '{}'); } catch { return resp(400, { error: 'Body must be JSON' }); }
        const used = Array.isArray(body?.used) ? body.used : null;
        if (!used || used.length < 1 || used.length > 20) {
          return resp(400, { error: 'used must list 1-20 { heard_key, variety_id }' });
        }
        const keys = [];
        const varieties = [];
        for (const u of used) {
          const heardKey = String(u?.heard_key ?? '');
          const varietyId = String(u?.variety_id ?? '');
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(varietyId)) {
            return resp(400, { error: 'variety_id must be a uuid' });
          }
          if (heardKey !== heardKey.toLowerCase() || /[\s\p{P}]/u.test(heardKey)
              || heardKey.length < 4 || heardKey.length > 120) {
            return resp(400, { error: 'heard_key must be a normalised 4-120 character key' });
          }
          keys.push(heardKey);
          varieties.push(varietyId);
        }
        const rows = await sql`
          UPDATE public.voice_alias a
             SET hit_count = a.hit_count + 1,
                 last_used_at = now()
            FROM (SELECT DISTINCT k, v FROM unnest(${keys}::text[], ${varieties}::uuid[]) AS u(k, v)) u
           WHERE a.user_id = ${userId}
             AND a.heard_key = u.k
             AND a.variety_id = u.v
          RETURNING a.heard_key
        `;
        return resp(200, { counted: rows.length });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // The named mix. ABOVE idMatch, beside /deleted and /voice-aliases: the path is one trailing segment,
    // so below it "blend" would be read as a variety id (POST 405, and a GET would bind it as a uuid and
    // 500). POST only, the preview included, so a client ahead of its Lambda gets a clean 405.
    if (rawPath === '/api/varieties/blend') {
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      let body;
      try { body = JSON.parse(event.body ?? '{}'); } catch { return resp(400, { error: 'Request body must be JSON' }); }
      const out = await blendRoute(sql, {
        body,
        userId,
        household,
        spendCreate: () => checkRateLimit(sql, userId, 'plant_varieties.create', 60),
        newId: randomUUID,
      });
      // V4-TAGSUB-001: post-commit, fail-open derive of type:/lifecycle: tags, on a created mix only.
      if (out.derive) {
        try { await applyDerive(sql, out.derive); } catch (e) { console.error('TAGSUB derive (non-fatal) for cultivar', out.derive, e?.message ?? e); }
      }
      // blend.js answers 429 only when spendCreate refuses.
      if (out.status === 429) return withRetryAfter(resp(out.status, out.body));
      return resp(out.status, out.body);
    }

    const idMatch = rawPath.match(/^\/api\/varieties\/([^/]+)$/);

    // The /deleted exclusion rides on the USE, not the declaration: crop-type.test.js anchors the
    // route-ordering guard on the literal `const idMatch = rawPath.match`, so do not rewrite that line.
    if (idMatch && rawPath !== '/api/varieties/deleted') {
      const varietyId = idMatch[1];

      if (method === 'GET') {
        const rows = await sql`
          SELECT id, display_name AS name, species, genus,
                 days_to_maturity_min, days_to_maturity_max,
                 care_notes, soil_notes, sun_requirements,
                 common_diseases, expected_yield_notes,
                 photo_id, source_url,
                 crop_type_slug, lifecycle, scoville_min, scoville_max, growth_habit, produces_scape,
                 created_by, created_at, updated_at,
                 determinacy, day_length_response, grown_as,
                 start_method, start_indoor_weeks_min, start_indoor_weeks_max,
                 direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in,
                 days_to_germ_min, days_to_germ_max, sow_season, sow_notes,
                 -- V5-VARIETYFACTSEDIT-001. This read seeds VarietyEditor, which now edits these
                 -- five. Left off, every stored value renders as an empty box, and the form would
                 -- refuse a breeding edit for want of a source the row already has.
                 origin_country, origin_region, breeding_system, breeding_source, scoville_source,
                 -- V5-VARIETYBLEND-001: what tells a mix from a single variety, and its leaves.
                 variety_rank, blend_key
          FROM public.cultivar
          WHERE id = ${varietyId}
            AND deleted_at IS NULL
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        // can_edit: would the PUT/DELETE below take this row from THIS caller (BUG-VARIETYEDITHOUSEHOLDMIRROR-001).
        // VarietyEditor cannot see GARDEN_HOUSEHOLD_IDS, so it guessed from created_by alone and showed the
        // other household member's rows read-only although the PUT saves them. Computed, never stored and
        // never read back: no PUT/POST body carries it. It is the write predicate in JS over the SAME
        // `household` those statements bind (./authz.js canEditVariety), so the two change together or not
        // at all. The read itself stays global: a non-member still gets the row, with false unless they
        // created it. Only this read carries it: it seeds the edit form (src/pages/VarietyEdit.jsx); the
        // list feeds pickers and search.
        return resp(200, { ...rows[0], can_edit: canEditVariety(household, rows[0].created_by) });
      }

      if (method === 'PUT') {
        // Blank origin text becomes a `clear` before any validator runs.
        const body = normalizeOriginText(JSON.parse(event.body ?? '{}'));
        const verr = validateBody(body, { requireName: false });
        if (verr) return resp(400, { error: verr });

        const cerr = validateClear(body.clear, body);
        if (cerr) return resp(400, { error: cerr });

        const allowed = await checkRateLimit(sql, userId, 'plant_varieties.update', 120);
        if (!allowed) return withRetryAfter(resp(429, { error: 'Rate limit exceeded — 120/hour for plant_varieties.update' }));

        // AUTHZ (BUG-AUTHZFKENUM-001): photo_id -> photos(id) was written verbatim from the body on BOTH verbs
        // while the DB FK proved only existence. GET /api/varieties and GET /api/varieties/:id are GLOBALLY
        // readable and already SELECT photo_id, so the day a resolver ships this becomes a cross-household
        // read with no further code change. Scoped with `household` (this handler's local name); the
        // managed-principal widening in ./authz.js governs WHICH CULTIVAR may be edited, never which photo
        // may be attached, so a managed row is only attachable to household-owned photos.
        if (body.photo_id != null) {
          if (!await loadOwnedPhoto(sql, body.photo_id, household)) {
            warnRejectedFk(userId, 'plant_varieties', 'photo_id', body.photo_id);
            return resp(400, { error: 'photo_id does not match a photo you can use' });
          }
        }

        // PUT uses the COALESCE pattern: undefined/null in body = keep existing. That alone makes every
        // optional column WRITE-ONCE-SETTABLE, since null and absent are the same token on the wire, so a
        // second, EXPLICIT channel exists: `clear` is an array of column keys to set to NULL
        // (V4-EDITCOMPLETE-001). Absent/[] is identical to the COALESCE-only behaviour.
        //
        // Shaped as CASE WHEN ${clear} @> ARRAY['k'] rather than a dynamically-built SET list because the
        // neon tagged-template API takes no interpolated identifiers, and rather than a bare null param
        // because neon cannot type a standalone null (the NULL here is a SQL literal typed by the CASE's
        // ELSE branch).
        const cd = body.common_diseases;
        const clear = Array.isArray(body.clear) ? body.clear : [];

        // breeding_system is CHECK-paired with breeding_source and, for open_pollinated, with variety_rank.
        // Whether a patch satisfies them depends on the row it lands on, so read that row first, under the
        // UPDATE's own predicate (a row the caller may not edit answers the same generic 404). Only patches
        // that touch a breeding column pay for the read. fillRank: Open-pollinated on a row with no recorded
        // rank records it as a single named cultivar, via the UPDATE's variety_rank arm below, never the
        // clear channel.
        let fillRank = false;
        if (touchesBreeding(body, clear)) {
          const [current] = await sql`
            SELECT breeding_system, breeding_source, variety_rank
              FROM public.cultivar
             WHERE id = ${varietyId}
               AND ( created_by = ANY(${household})
                     OR created_by LIKE ANY(${managedPatterns}::text[]) )
               AND deleted_at IS NULL
          `;
          if (!current) return resp(404, { error: 'Not found or not owner' });
          const perr = breedingPairingError(body, clear, current);
          if (perr) return resp(400, { error: perr });
          fillRank = fillsCultivarRank(body, clear, current);
        }

        const [, updateRows] = await withActor(sql, userId, () => [
          sql`
            UPDATE public.cultivar SET
              display_name         = COALESCE(${body.name ?? null}, display_name),
              species              = CASE WHEN ${clear} @> ARRAY['species'] THEN NULL ELSE COALESCE(${body.species ?? null}, species) END,
              genus                = CASE WHEN ${clear} @> ARRAY['genus'] THEN NULL ELSE COALESCE(${body.genus ?? null}, genus) END,
              days_to_maturity_min = CASE WHEN ${clear} @> ARRAY['days_to_maturity_min'] THEN NULL ELSE COALESCE(${body.days_to_maturity_min ?? null}, days_to_maturity_min) END,
              days_to_maturity_max = CASE WHEN ${clear} @> ARRAY['days_to_maturity_max'] THEN NULL ELSE COALESCE(${body.days_to_maturity_max ?? null}, days_to_maturity_max) END,
              care_notes           = CASE WHEN ${clear} @> ARRAY['care_notes'] THEN NULL ELSE COALESCE(${body.care_notes ?? null}, care_notes) END,
              soil_notes           = CASE WHEN ${clear} @> ARRAY['soil_notes'] THEN NULL ELSE COALESCE(${body.soil_notes ?? null}, soil_notes) END,
              sun_requirements     = CASE WHEN ${clear} @> ARRAY['sun_requirements'] THEN NULL ELSE COALESCE(${body.sun_requirements ?? null}, sun_requirements) END,
              common_diseases      = CASE WHEN ${clear} @> ARRAY['common_diseases'] THEN NULL ELSE COALESCE(${Array.isArray(cd) ? cd : null}, common_diseases) END,
              expected_yield_notes = CASE WHEN ${clear} @> ARRAY['expected_yield_notes'] THEN NULL ELSE COALESCE(${body.expected_yield_notes ?? null}, expected_yield_notes) END,
              photo_id             = CASE WHEN ${clear} @> ARRAY['photo_id'] THEN NULL ELSE COALESCE(${body.photo_id ?? null}, photo_id) END,
              source_url           = CASE WHEN ${clear} @> ARRAY['source_url'] THEN NULL ELSE COALESCE(${body.source_url ?? null}, source_url) END,
              crop_type_slug       = CASE WHEN ${clear} @> ARRAY['crop_type_slug'] THEN NULL ELSE COALESCE(${body.crop_type_slug ?? null}, crop_type_slug) END,
              lifecycle            = CASE WHEN ${clear} @> ARRAY['lifecycle'] THEN NULL ELSE COALESCE(${body.lifecycle ?? null}, lifecycle) END,
              scoville_min         = CASE WHEN ${clear} @> ARRAY['scoville_min'] THEN NULL ELSE COALESCE(${body.scoville_min ?? null}, scoville_min) END,
              scoville_max         = CASE WHEN ${clear} @> ARRAY['scoville_max'] THEN NULL ELSE COALESCE(${body.scoville_max ?? null}, scoville_max) END,
              growth_habit         = CASE WHEN ${clear} @> ARRAY['growth_habit'] THEN NULL ELSE COALESCE(${body.growth_habit ?? null}, growth_habit) END,
              produces_scape       = CASE WHEN ${clear} @> ARRAY['produces_scape'] THEN NULL ELSE COALESCE(${body.produces_scape ?? null}, produces_scape) END,
              determinacy          = CASE WHEN ${clear} @> ARRAY['determinacy'] THEN NULL ELSE COALESCE(${body.determinacy ?? null}, determinacy) END,
              day_length_response  = CASE WHEN ${clear} @> ARRAY['day_length_response'] THEN NULL ELSE COALESCE(${body.day_length_response ?? null}, day_length_response) END,
              grown_as             = CASE WHEN ${clear} @> ARRAY['grown_as'] THEN NULL ELSE COALESCE(${body.grown_as ?? null}, grown_as) END,
              start_method         = CASE WHEN ${clear} @> ARRAY['start_method'] THEN NULL ELSE COALESCE(${body.start_method ?? null}, start_method) END,
              start_indoor_weeks_min = CASE WHEN ${clear} @> ARRAY['start_indoor_weeks_min'] THEN NULL ELSE COALESCE(${body.start_indoor_weeks_min ?? null}, start_indoor_weeks_min) END,
              start_indoor_weeks_max = CASE WHEN ${clear} @> ARRAY['start_indoor_weeks_max'] THEN NULL ELSE COALESCE(${body.start_indoor_weeks_max ?? null}, start_indoor_weeks_max) END,
              direct_sow_timing    = CASE WHEN ${clear} @> ARRAY['direct_sow_timing'] THEN NULL ELSE COALESCE(${body.direct_sow_timing ?? null}, direct_sow_timing) END,
              sow_depth_in         = CASE WHEN ${clear} @> ARRAY['sow_depth_in'] THEN NULL ELSE COALESCE(${body.sow_depth_in ?? null}, sow_depth_in) END,
              seed_spacing_in      = CASE WHEN ${clear} @> ARRAY['seed_spacing_in'] THEN NULL ELSE COALESCE(${body.seed_spacing_in ?? null}, seed_spacing_in) END,
              row_spacing_in       = CASE WHEN ${clear} @> ARRAY['row_spacing_in'] THEN NULL ELSE COALESCE(${body.row_spacing_in ?? null}, row_spacing_in) END,
              days_to_germ_min     = CASE WHEN ${clear} @> ARRAY['days_to_germ_min'] THEN NULL ELSE COALESCE(${body.days_to_germ_min ?? null}, days_to_germ_min) END,
              days_to_germ_max     = CASE WHEN ${clear} @> ARRAY['days_to_germ_max'] THEN NULL ELSE COALESCE(${body.days_to_germ_max ?? null}, days_to_germ_max) END,
              sow_season           = CASE WHEN ${clear} @> ARRAY['sow_season'] THEN NULL ELSE COALESCE(${body.sow_season ?? null}, sow_season) END,
              sow_notes            = CASE WHEN ${clear} @> ARRAY['sow_notes'] THEN NULL ELSE COALESCE(${body.sow_notes ?? null}, sow_notes) END,
              origin_country       = CASE WHEN ${clear} @> ARRAY['origin_country'] THEN NULL ELSE COALESCE(${body.origin_country ?? null}, origin_country) END,
              origin_region        = CASE WHEN ${clear} @> ARRAY['origin_region'] THEN NULL ELSE COALESCE(${body.origin_region ?? null}, origin_region) END,
              breeding_system      = CASE WHEN ${clear} @> ARRAY['breeding_system'] THEN NULL ELSE COALESCE(${body.breeding_system ?? null}, breeding_system) END,
              breeding_source      = CASE WHEN ${clear} @> ARRAY['breeding_source'] THEN NULL ELSE COALESCE(${body.breeding_source ?? null}, breeding_source) END,
              scoville_source      = CASE WHEN ${clear} @> ARRAY['scoville_source'] THEN NULL ELSE COALESCE(${body.scoville_source ?? null}, scoville_source) END,
              -- Fills only a rank that was never recorded; a recorded rank is never overwritten, so a
              -- concurrent rank write between the preflight and here still lands on the CHECK.
              variety_rank         = CASE WHEN ${fillRank}::boolean AND variety_rank IS NULL THEN 'cultivar' ELSE variety_rank END
            WHERE id = ${varietyId}
              AND ( created_by = ANY(${household})
                    OR created_by LIKE ANY(${managedPatterns}::text[]) )
              AND deleted_at IS NULL
            RETURNING id, display_name AS name, species, genus, days_to_maturity_min, days_to_maturity_max, care_notes, soil_notes, sun_requirements, common_diseases, expected_yield_notes, photo_id, source_url, crop_type_slug, lifecycle, scoville_min, scoville_max, growth_habit, produces_scape, created_by, created_at, updated_at, deleted_at, source_proj_rescope_project_id, origin_country, origin_region, model_version, determinacy, day_length_response, grown_as, start_method, start_indoor_weeks_min, start_indoor_weeks_max, direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in, days_to_germ_min, days_to_germ_max, sow_season, sow_notes, breeding_system, breeding_source, scoville_source, variety_rank, blend_key
          `,
        ]);
        if (!updateRows.length) return resp(404, { error: 'Not found or not owner' });
        // Post-commit, fail-open derive of type:/lifecycle: tags. Never 500s a variety write.
        try { await applyDerive(sql, varietyId); } catch (e) { console.error('TAGSUB derive (non-fatal) for cultivar', varietyId, e?.message ?? e); }
        return resp(200, updateRows[0]);
      }

      if (method === 'DELETE') {
        const [, deleteRows] = await withActor(sql, userId, () => [
          sql`
            UPDATE public.cultivar
            SET deleted_at = NOW()
            WHERE id = ${varietyId}
              AND ( created_by = ANY(${household})
                    OR created_by LIKE ANY(${managedPatterns}::text[]) )
              AND deleted_at IS NULL
            RETURNING id
          `,
        ]);
        if (!deleteRows.length) return resp(404, { error: 'Not found or not owner' });
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      // List + search. ?q= -> ILIKE on name, both capped at VARIETY_LIST_CAP. Globally readable: no created_by filter.
      const q = event.queryStringParameters?.q ?? null;
      const rows = q
        ? await sql`
            SELECT id, display_name AS name, species, genus,
                   days_to_maturity_min, days_to_maturity_max,
                   care_notes, soil_notes, sun_requirements,
                   common_diseases, expected_yield_notes,
                   photo_id, source_url,
                   crop_type_slug, lifecycle, scoville_min, scoville_max, growth_habit, produces_scape,
                   created_by, created_at, updated_at,
                   determinacy, day_length_response, grown_as,
                   start_method, start_indoor_weeks_min, start_indoor_weeks_max,
                   direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in,
                   days_to_germ_min, days_to_germ_max, sow_season, sow_notes,
                   -- V5-VARIETYHYBRIDFLAG-001. THE THIRD DOOR, and the least obvious one. Both
                   -- SaveSeedSheet entry points seed their variety state from the planting's
                   -- variety_ref, but the sheet also mounts a VarietyPicker, and picking there
                   -- replaces that state wholesale with a row from THIS list (VarietyPicker.jsx:291
                   -- hands the whole object to onChange). No backticks in these SQL comments: this
                   -- is inside a JS template literal and one would terminate it.
                   -- Omit the column here and the F1 warning goes silent precisely when
                   -- the user DELIBERATELY named the cultivar they are saving seed from - the worst
                   -- of the four silent cases, because that is the most considered save there is.
                   -- Both branches of this ternary carry it and must stay identical; the q/non-q
                   -- split is a WHERE difference, never a projection difference.
                   breeding_system,
                   -- V5-VARIETYBLEND-001: a picked mix must arrive knowing it is one. Same rule as
                   -- the line above - both branches carry both columns.
                   variety_rank, blend_key
            FROM public.cultivar
            WHERE deleted_at IS NULL
              AND LOWER(display_name) LIKE ${'%' + q.toLowerCase() + '%'}
            ORDER BY display_name ASC
            LIMIT ${VARIETY_LIST_CAP}::int
          `
        : await sql`
            SELECT id, display_name AS name, species, genus,
                   days_to_maturity_min, days_to_maturity_max,
                   care_notes, soil_notes, sun_requirements,
                   common_diseases, expected_yield_notes,
                   photo_id, source_url,
                   crop_type_slug, lifecycle, scoville_min, scoville_max, growth_habit, produces_scape,
                   created_by, created_at, updated_at,
                   determinacy, day_length_response, grown_as,
                   start_method, start_indoor_weeks_min, start_indoor_weeks_max,
                   direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in,
                   days_to_germ_min, days_to_germ_max, sow_season, sow_notes,
                   -- Identical to the q branch above by construction — see its comment. A
                   -- projection difference between these two would make the F1 warning depend on
                   -- whether the user typed in the search box.
                   breeding_system,
                   variety_rank, blend_key
            FROM public.cultivar
            WHERE deleted_at IS NULL
            ORDER BY display_name ASC
            LIMIT ${VARIETY_LIST_CAP}::int
          `;
      // A full page means rows may have been dropped: the unsearched list is what the variety picker
      // and header Search filter on the client, so a cultivar past the cap is simply missing there.
      if (rows.length >= VARIETY_LIST_CAP) console.error('varieties list hit VARIETY_LIST_CAP', VARIETY_LIST_CAP, q ? '(search)' : '(unsearched)');
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const verr = validateBody(body, { requireName: true });
      if (verr) return resp(400, { error: verr });

      // Admin classify inline-create: when the caller passes source_proj_rescope_project_id, POST is
      // idempotent on that key. If a variety already exists for this source project, return it (200) and
      // skip the name/species fuzzy-match check (admin is authoritative).
      //
      // THE IDEMPOTENCY SELECT BELOW IS HOUSEHOLD-SCOPED (BUG-AUTHZFKENUM-001). Unscoped, with no ORDER BY,
      // it was pre-squattable: an attacker POSTs a cultivar carrying a key they expect an admin to use
      // later, and the admin's inline-create returns the ATTACKER'S ROW instead of minting one. The owner
      // arms mirror the PUT/DELETE editable set exactly (household + managed principals), and ORDER BY
      // makes the LIMIT 1 deterministic.
      //
      // AUTHZ (BUG-AUTHZFKENUM-001): source_proj_rescope_project_id -> plant_projects was ungated, so a
      // caller could mint a cultivar keyed to another household's project. Gated with the canonical
      // project predicate.
      if (body.source_proj_rescope_project_id != null) {
        if (!await loadOwnedProject(sql, body.source_proj_rescope_project_id, household)) {
          warnRejectedFk(userId, 'plant_varieties', 'source_proj_rescope_project_id', body.source_proj_rescope_project_id);
          return resp(400, { error: 'source_proj_rescope_project_id does not match a project you can use' });
        }
      }
      const sourceProjId = body.source_proj_rescope_project_id ?? null;
      if (sourceProjId) {
        const existing = await sql`
          SELECT id, display_name AS name, species, genus,
                 days_to_maturity_min, days_to_maturity_max,
                 care_notes, soil_notes, sun_requirements,
                 common_diseases, expected_yield_notes,
                 photo_id, source_url,
                 crop_type_slug, lifecycle, scoville_min, scoville_max, growth_habit, produces_scape,
                 created_by, created_at, updated_at,
                 source_proj_rescope_project_id,
                 determinacy, day_length_response, grown_as,
                 start_method, start_indoor_weeks_min, start_indoor_weeks_max,
                 direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in,
                 days_to_germ_min, days_to_germ_max, sow_season, sow_notes,
                 variety_rank, blend_key
          FROM public.cultivar
          WHERE source_proj_rescope_project_id = ${sourceProjId}
            AND deleted_at IS NULL
            AND ( created_by = ANY(${household})
                  OR created_by LIKE ANY(${managedPatterns}::text[]) )
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `;
        if (existing.length) return resp(200, existing[0]);
      }

      const allowed = await checkRateLimit(sql, userId, 'plant_varieties.create', 60);
      if (!allowed) return withRetryAfter(resp(429, { error: 'Rate limit exceeded — 60/hour for plant_varieties.create' }));

      // AUTHZ (BUG-AUTHZFKENUM-001): the create half of the photo_id gate (see the PUT arm). Gating one verb is
      // the shape of the original bug, so both are gated or neither is.
      if (body.photo_id != null) {
        if (!await loadOwnedPhoto(sql, body.photo_id, household)) {
          warnRejectedFk(userId, 'plant_varieties', 'photo_id', body.photo_id);
          return resp(400, { error: 'photo_id does not match a photo you can use' });
        }
      }

      // Fuzzy-match warning (advisory): the frontend may re-POST with allow_duplicate=true and the backend
      // honors the override. Skipped when sourceProjId is present: admin idempotent-by-source-id is authoritative.
      if (!body.allow_duplicate && !sourceProjId) {
        const similar = await sql`
          SELECT id, display_name AS name, species, genus FROM public.cultivar
          WHERE deleted_at IS NULL
            AND LOWER(display_name) = LOWER(${body.name})
            AND COALESCE(species, '') = COALESCE(${body.species ?? null}, '')
          LIMIT 1
        `;
        if (similar.length) {
          return resp(409, {
            error: 'Variety with same name+species already exists',
            existing: similar[0],
            hint: 'POST with allow_duplicate: true to override (creates a new row).',
          });
        }
      }

      // The id is minted HERE, not by the column default, so the care_profile INSERT below can bind the same
      // value inside the SAME transaction (BUG-CULTIVARNOPROFILE-001). The neon HTTP driver's
      // sql.transaction() takes already-built statements and none can read another's RETURNING, so a
      // client-side uuid is the only way to make the two writes atomic without a data-modifying CTE. A
      // post-commit write (the applyDerive idiom below) fails OPEN, which for an existence invariant would
      // quietly re-create the gap this closes.
      const newVarietyId = randomUUID();
      const [, insertRows] = await withActor(sql, userId, () => [
        sql`
          INSERT INTO public.cultivar (
            id, display_name, species, genus,
            days_to_maturity_min, days_to_maturity_max,
            care_notes, soil_notes, sun_requirements,
            common_diseases, expected_yield_notes,
            photo_id, source_url, created_by,
            crop_type_slug, lifecycle, scoville_min, scoville_max, growth_habit, produces_scape,
            source_proj_rescope_project_id,
            determinacy, day_length_response, grown_as,
            start_method, start_indoor_weeks_min, start_indoor_weeks_max,
            direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in,
            days_to_germ_min, days_to_germ_max, sow_season, sow_notes
          ) VALUES (
            ${newVarietyId}::uuid,
            ${body.name.trim()},
            ${body.species ?? null},
            ${body.genus ?? null},
            ${body.days_to_maturity_min ?? null},
            ${body.days_to_maturity_max ?? null},
            ${body.care_notes ?? null},
            ${body.soil_notes ?? null},
            ${body.sun_requirements ?? null},
            ${Array.isArray(body.common_diseases) ? body.common_diseases : null},
            ${body.expected_yield_notes ?? null},
            ${body.photo_id ?? null},
            ${body.source_url ?? null},
            ${userId},
            ${body.crop_type_slug ?? null},
            ${body.lifecycle ?? null},
            ${body.scoville_min ?? null},
            ${body.scoville_max ?? null},
            ${body.growth_habit ?? null},
            ${body.produces_scape ?? null},
            ${sourceProjId},
            ${body.determinacy ?? null},
            ${body.day_length_response ?? null},
            ${body.grown_as ?? null},
            ${body.start_method ?? null},
            ${body.start_indoor_weeks_min ?? null},
            ${body.start_indoor_weeks_max ?? null},
            ${body.direct_sow_timing ?? null},
            ${body.sow_depth_in ?? null},
            ${body.seed_spacing_in ?? null},
            ${body.row_spacing_in ?? null},
            ${body.days_to_germ_min ?? null},
            ${body.days_to_germ_max ?? null},
            ${body.sow_season ?? null},
            ${body.sow_notes ?? null}
          ) RETURNING id, display_name AS name, species, genus, days_to_maturity_min, days_to_maturity_max, care_notes, soil_notes, sun_requirements, common_diseases, expected_yield_notes, photo_id, source_url, crop_type_slug, lifecycle, scoville_min, scoville_max, growth_habit, produces_scape, created_by, created_at, updated_at, deleted_at, source_proj_rescope_project_id, origin_country, origin_region, model_version, determinacy, day_length_response, grown_as, start_method, start_indoor_weeks_min, start_indoor_weeks_max, direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in, days_to_germ_min, days_to_germ_max, sow_season, sow_notes, breeding_system, breeding_source, scoville_source, variety_rank, blend_key
        `,
        // The cadence-profile row, in the same transaction as the cultivar it describes. Shape follows
        // lambda/plants/overwinterAttr.js: scope_id needs the explicit ::uuid (the parameter arrives as text
        // and Postgres cannot infer it across the ON CONFLICT arm), and workspace_id is left to the column
        // DEFAULT sentinel. ON CONFLICT DO NOTHING is unreachable on a freshly minted uuid; it is there so
        // that if this INSERT is ever re-pointed at an existing cultivar (a backfill), it can never CLOBBER
        // a researched profile back to 'unresearched'.
        sql`
          INSERT INTO public.care_profile (scope, scope_id, profile, model_version)
          VALUES ('cultivar'::care_scope, ${newVarietyId}::uuid, ${JSON.stringify(NEW_CULTIVAR_PROFILE)}::jsonb, 1)
          ON CONFLICT (scope, scope_id) WHERE scope <> 'system' DO NOTHING
        `,
      ]);
      // Post-commit, fail-open derive of type:/lifecycle: tags. Never 500s a variety write.
      try { await applyDerive(sql, insertRows[0].id); } catch (e) { console.error('TAGSUB derive (non-fatal) for cultivar', insertRows[0].id, e?.message ?? e); }
      return resp(201, insertRows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    logCaughtError('varieties lambda error', err);
    // Named constraints first (the PUT's breeding race path, see CONSTRAINT_MESSAGES in ./validate.js), then the table.
    if (err.code === '23514' && Object.hasOwn(CONSTRAINT_MESSAGES, err.constraint)) {
      return resp(400, { error: CONSTRAINT_MESSAGES[err.constraint] });
    }
    const db = dbErrorReply(err, ['23514', '23502', '23503', '23505']);
    if (db) return resp(db.status, db.body);
    return resp(500, { error: 'Internal server error' });
  }
};
