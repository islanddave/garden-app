// /api/varieties — VARIETY-REF Session 2 Lambda
// Layer 1 canonical reference table for plant varieties.
// Pattern: mirrors lambda/plants/index.js + lambda/inventory-items/index.js
// Spec: varieties-schema-design-V001-20260508.md
//
// Auth: Clerk JWT verified per request → userId = JWT.sub
// RLS: enforced in WHERE clauses, not Postgres (vestigial under Neon).
//   - GET (list/by-id): globally readable (any authenticated user, any non-deleted row)
//   - POST: owner-stamped (created_by = JWT.sub)
//   - PUT/DELETE: HOUSEHOLD-scoped + managed-principal arm (V4-VARIETYHOUSEHOLD-001, see ./authz.js).
//     Was owner-only, which left the 25 cultivars created by offline intake/repair scripts
//     uneditable by every human. A foreign household still reaches nothing. NOT a general widening.
//   - GET /api/varieties/crop-types: globally readable controlled vocabulary (V4-PLANTTYPE-001)
//   - GET/POST /api/varieties/{sources,source-kinds}: the provenance registry, same contract as
//     crop-types — globally readable, owner-stamped on write (V4-SOURCEREG-001 / V5-SOURCEKIND-001)
//
// Audit: trigger trg_audit_plant_varieties writes to audit_events. Lambda sets
// SET LOCAL app.actor_clerk_sub = $userId after BEGIN so trigger reads the actor. The bind goes
// through auditActor() (./validate.js) — a NULL bind would silently set the GUC to '' rather than
// leave it unset, which the trigger's COALESCE cannot catch. BUG-VARIETYACTOREMPTY-001.
//
// Rate limits (per design doc C-S1-C):
//   plant_varieties.create — 60/hour per actor
//   plant_varieties.update — 120/hour per actor
//
// PLANTTYPE (V4-PLANTTYPE-001): crop_type_slug (FK → crop_types.slug), lifecycle, and the
//   typed care facts scoville_min/scoville_max/growth_habit/produces_scape are read & written
//   through public.cultivar (the auto-updatable view; 0d-cultivar-view.sql exposes the columns
//   the base plant_varieties table gained in 0a). All optional/nullable — a body that omits them
//   is a no-op on PUT (COALESCE) and inserts NULL on POST. Bad crop_type_slug → FK 23503 → 400.
//
// SEEDINV (V4-SEEDINV-001): 14 more optional columns flow through public.cultivar —
//   3 classify (determinacy, day_length_response, grown_as) + 11 sow profile
//   (start_method, start_indoor_weeks_min/max, direct_sow_timing, sow_depth_in,
//   seed_spacing_in, row_spacing_in, days_to_germ_min/max, sow_season, sow_notes).
//   Same contract as PLANTTYPE: omitted = COALESCE no-op on PUT, NULL on POST.
//   Guarded by select-columns.test.js (static-source, plants-pattern).
//
// CORS: handler owns CORS — Lambda URL CORS config must be empty (handler sets headers).

import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  validateBody, validateCropTypeBody, resolveCropTypeName, validateClear, auditActor,
  validateSourceBody, validateSourceKindBody, resolveSourceKindName, foldSourceKey, blankToNull,
} from './validate.js';
import { applyDerive } from './crop-derive.js';
import { householdScope, loadOwnedPhoto, warnRejectedFk } from './household.js';
import { loadOwnedProject } from './authz-parents.js';
import { managedPrincipalPatterns } from './authz.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config owns CORS — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

// Validators live in ./validate.js (pure, unit-testable without runtime deps).

// Atomic conditional INSERT/UPDATE for rate limiting (per design doc C-S1-C).
// Returns true if request is allowed; false if limit exceeded.
async function checkRateLimit(sql, actor, bucketKey, limit) {
  const rows = await sql`
    INSERT INTO public.rate_limit_buckets (actor_clerk_sub, bucket_key, window_start, count)
    VALUES (${actor}, ${bucketKey}, date_trunc('hour', NOW()), 1)
    ON CONFLICT (actor_clerk_sub, bucket_key, window_start)
    DO UPDATE SET count = public.rate_limit_buckets.count + 1
    WHERE public.rate_limit_buckets.count < ${limit}
    RETURNING count
  `;
  return rows.length > 0;
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const secrets = await getSecrets();

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let userId;
  try {
    const payload = await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: [
        'https://garden.futureishere.net',
        'https://dg6mmjhepoyt9.cloudfront.net',
      ],
    });
    userId = payload.sub;
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }

  // V4-AUTHZRESIDUE-001 (mirrors lambda/plants + lambda/photos): householdScope('') returns [''] and
  // `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty/absent JWT subject would be a live
  // ownership value rather than a no-match. verifyToken rejects such a token first, so this is
  // defence-in-depth; the point is that the invariant is ENFORCED here rather than relied upon.
  if (!userId) return resp(401, { error: 'Unauthorized' });

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/varieties';

  // V4-VARIETYHOUSEHOLD-001 — write scope for PUT/DELETE. `household` is the caller's own id for a
  // non-member (and whenever GARDEN_HOUSEHOLD_IDS is unset), so the widened predicate degrades to the
  // exact owner-only behaviour it replaced. `managedPatterns` is [] for anyone who is not a proven
  // household member. Rationale + the membership subtlety live in ./authz.js.
  //
  // The audit actor below is deliberately still ${userId}, never a household id: widening WHO MAY
  // EDIT must not blur WHO DID EDIT. Every write keeps recording the human that made it.
  const household = householdScope(userId);
  const managedPatterns = managedPrincipalPatterns(household);

  try {
    // PLANTTYPE: controlled crop-type vocabulary. Globally readable; checked BEFORE the
    // /api/varieties/:id route so "crop-types" is not mis-parsed as a variety id.
    if (rawPath === '/api/varieties/crop-types') {
      if (method === 'GET') {
        // OPS-CROPTYPEALIASCLIENT-001 — search_aliases joins the projection, and this is the ONE
        // response shape in the repo that carries it. Dave's acceptance sentence is "I know it is a
        // cantaloupe": no crop type is NAMED cantaloupe, the word lives only in this column on the
        // 'melon' row, and until now only the dashboard's server-side search could see it — so every
        // client filter answered nothing for it (V4-SEARCHCROPTYPE-001 shipped its client leg with
        // that residual pinned as a red-when-fixed test).
        //
        // THE NEVER-RENDER RULE STILL HOLDS AND IS NOT RELAXED BY THIS. The reason the column exists
        // at all instead of more parentheticals in display_name is that display_name is SELECTed as
        // crop_name by lambda/facebook-share/index.js:319 and reaches the text of a public post.
        // That constraint is about RENDERING, not about the byte reaching the browser: this is a
        // controlled-vocabulary list a client filters against, and no share/post path reads it —
        // facebook-share runs its own SQL and never calls this route. The dashboard search guards
        // (lambda/dashboard/crop-types-columns.test.js, search.test.js) are deliberately left intact,
        // because a SEARCH RESULT ROW is a render surface and this list is not; the client-side
        // counterpart is pinned in src/__tests__/cropTypeAliasClient.test.jsx, which asserts the
        // alias text never reaches the DOM on any of the four surfaces that now match on it.
        const rows = await sql`
          SELECT slug, display_name, default_lifecycle, category, sort_order, dtm_basis, search_aliases
          FROM public.crop_types
          WHERE deleted_at IS NULL
          ORDER BY sort_order ASC, display_name ASC
        `;
        return resp(200, rows);
      }

      // V4-CROPTYPE-001 — mint a crop type inline while adding a planting.
      // Until now the vocabulary was read-only from the app: new types could only be born from an
      // intake script or raw SQL, so a plant with no matching type had to be saved with
      // crop_type_slug = NULL and then vanished from every type-grouped/faceted view.
      //
      // Dave's accepted design is "always-add-on-the-fly, guard only the 8 code-coupled slugs".
      // The slug is DERIVED server-side from display_name and never accepted from the caller — it
      // is this table's PRIMARY KEY and the FK target of plant_varieties + preservation_log.
      if (method === 'POST') {
        const body = JSON.parse(event.body ?? '{}');
        const err = validateCropTypeBody(body);
        if (err) return resp(400, { error: err });

        const allowed = await checkRateLimit(sql, userId, 'crop_types.create', 20);
        if (!allowed) return resp(429, { error: 'Rate limit exceeded — 20/hour for crop_types.create' });

        // Collision set deliberately includes SOFT-DELETED rows: slug is the PK, so a resurrect
        // would violate it rather than politely conflict.
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
          // A previously soft-deleted type is RESTORED rather than refused — the user is asking
          // for exactly this type and Soft-Delete-Only means the row never actually left.
          if (row?.deleted_at) {
            const [restored] = await sql`
              UPDATE public.crop_types
                 SET deleted_at = NULL, updated_at = now()
               WHERE slug = ${verdict.existingSlug}
              RETURNING slug, display_name, default_lifecycle, category, sort_order
            `;
            return resp(200, { ...restored, restored: true });
          }
          // Otherwise steer to what already exists. `reason` lets the client word it correctly:
          //   exists/plural      -> "Hibiscus already exists" (benign, just use it)
          //   coupled_synonym    -> naming a second type for a crop the derive engine special-cases
          //                         would silently strip its facets, so this one is a real save.
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

    // ── V4-SOURCEREG-001 — the provenance registry: WHO or WHERE a plant or packet came from ───
    //
    // WHY THESE ROUTES HANG OFF THE VARIETIES LAMBDA, for the same reason /voice-aliases below
    // does: a new Lambda needs a new Function URL, a new VITE_API_* variable, a repo variable AND a
    // mapping into the build, and on 2026-08-30 the share feature shipped its code twice while its
    // endpoint never reached the bundle because the last of those four steps was missing.
    // VITE_API_VARIETIES is already wired, deployed and proven.
    //
    // CHECKED BEFORE idMatch for the same reason /crop-types, /deleted and /voice-aliases are: a
    // single trailing segment is otherwise parsed as a variety id and "sources" 404s as a cultivar.
    //
    // GLOBALLY READABLE, OWNER-STAMPED ON WRITE — the crop-types contract, deliberately NOT the
    // household one this file uses for cultivar PUT/DELETE. A source is a shared reference row (a
    // nursery, a seed company, a person); scoping the LIST would show Jen an empty picker for every
    // vendor Dave has already registered, and the two of them buy from the same places.
    if (rawPath === '/api/varieties/sources') {
      if (method === 'GET') {
        const rows = await sql`
          SELECT id, name, kind, locality, address, website_url, notes
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
        if (!allowed) return resp(429, { error: 'Rate limit exceeded — 20/hour for source.create' });

        // kind is an FK into source_kind.slug, checked here as a LIVE slug rather than left to the
        // constraint: a soft-deleted kind still satisfies the FK, and a 23503 surfaces as a 500 the
        // client cannot tell apart from a transport failure.
        const kind = blankToNull(body.kind);
        if (kind != null) {
          const [liveKind] = await sql`
            SELECT slug FROM public.source_kind WHERE slug = ${kind} AND deleted_at IS NULL
          `;
          if (!liveKind) return resp(400, { error: `kind "${kind}" is not a live source kind` });
        }

        // Collision is on match_key — the generated column uq_source_match_key_live is unique on —
        // folded here in JS so a duplicate STEERS instead of arriving as an unreadable 23505.
        // The set deliberately includes soft-deleted rows, and the ordering is what lets one query
        // serve both cases: that index is PARTIAL (live rows only), so any number of deleted rows
        // may share a key while at most one live row can. NULLS FIRST puts the live one first.
        const matchKey = foldSourceKey(body.name);
        const [hit] = await sql`
          SELECT id, name, kind, locality, address, website_url, notes, deleted_at
            FROM public.source
           WHERE match_key = ${matchKey}
           ORDER BY deleted_at DESC NULLS FIRST
           LIMIT 1
        `;

        if (hit) {
          const existing = {
            id: hit.id, name: hit.name, kind: hit.kind, locality: hit.locality,
            address: hit.address, website_url: hit.website_url, notes: hit.notes,
          };
          if (hit.deleted_at) {
            // Soft-Delete-Only: the row never actually left and the caller is asking for exactly
            // it. Wrapped in the actor transaction because public.source carries
            // trg_audit_source_upd — without the bind the audit snapshot of this restore records
            // 'system' and the one person who can explain the change is the one it does not name.
            // (public.crop_types has no such trigger, which is why the template above has no
            // transaction here.) The `AND deleted_at IS NOT NULL` keeps a concurrent restore from
            // writing a second, empty audit row.
            const [, restoredRows] = await sql.transaction([
              sql`SELECT set_config('app.actor_clerk_sub', ${auditActor(userId)}, true)`,
              sql`
                UPDATE public.source
                   SET deleted_at = NULL
                 WHERE id = ${hit.id}
                   AND deleted_at IS NOT NULL
                RETURNING id, name, kind, locality, address, website_url, notes
              `,
            ]);
            if (restoredRows.length) return resp(200, { ...restoredRows[0], restored: true });
            // Lost the race — another writer restored it between the read and the write. The row is
            // live and it is the one the caller wants, so fall through and steer to it rather than
            // reporting a failure for an outcome that is exactly what was asked for.
          }
          return resp(409, {
            error: `Source "${hit.name}" already exists`,
            reason: 'exists',
            existing,
            hint: 'Use the existing source instead of creating a duplicate.',
          });
        }

        const [created] = await sql`
          INSERT INTO public.source (name, kind, locality, address, website_url, notes, created_by)
          VALUES (
            ${body.name.trim()},
            ${kind},
            ${blankToNull(body.locality)},
            ${blankToNull(body.address)},
            ${blankToNull(body.website_url)},
            ${blankToNull(body.notes)},
            ${userId}
          )
          RETURNING id, name, kind, locality, address, website_url, notes
        `;
        return resp(201, created);
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // ── V5-SOURCEKIND-001 — the vocabulary source.kind is typed against ────────────────────────
    // Same mint contract as crop-types, and for the same reason: read-only from the app meant a
    // source with no matching kind had to be saved with kind = NULL, which drops it out of every
    // kind-grouped view. The slug is DERIVED server-side and never accepted from the caller — it is
    // this table's PRIMARY KEY and the FK target of public.source.kind.
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
        if (!allowed) return resp(429, { error: 'Rate limit exceeded — 20/hour for source_kind.create' });

        // One read, two collision sets, and the asymmetry is deliberate: slugs come from EVERY row
        // (slug is the PK, so a soft-deleted row still occupies it and a resurrect would violate it
        // rather than politely conflict), labels from the LIVE rows only (uq_source_kind_display_live
        // is PARTIAL, so a retired label blocks nothing).
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
            // A restore is an INSERT as far as uq_source_kind_display_live is concerned — the row
            // rejoins the live set — so a live row already folding to the same label would make
            // this UPDATE raise 23505. Steer to that live row instead of restoring into a 500.
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
          // `reason` lets the client word it correctly: exists/plural is benign (just use that one),
          // label means the name they typed folds onto a different-looking row and the DB would have
          // refused it.
          return resp(409, {
            error: `Source kind "${row.display_name}" already exists`,
            reason: verdict.reason,
            existing: shape(row),
            hint: 'Use the existing source kind instead of creating a duplicate.',
          });
        }

        // sort_order is max + 10, NOT the column default of 0. The twelve seeded kinds occupy
        // 10..120 and the head of this list is meant to be the common cases; a minted kind taking
        // the default would sort ABOVE every one of them.
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

    // ── V4-RESTORESURFACE-001 — the recovery path for cultivars (audit I9) ─────────────────────
    //
    // 13 cultivars are soft-deleted in prod with no way back. Same contract as lambda/locations and
    // lambda/plants; the ownership predicate is this Lambda's own (`created_by` OR a managed
    // principal pattern), NOT the household-only shape the other two use — a cultivar can be owned
    // by a managed importer principal, and scoping this list to `household` alone would hide those
    // rows from the person who can actually restore them.
    //
    // Checked BEFORE idMatch below for the same reason `/api/varieties/crop-types` already is: a
    // single trailing segment would otherwise be parsed as a variety id.
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
      // trg_audit_plant_varieties, which reads app.actor_clerk_sub. A restore that skipped this
      // would land in the audit trail with no actor — the one asymmetry that would make the delete
      // attributable and its undo anonymous.
      const [, rows] = await sql.transaction([
        sql`SELECT set_config('app.actor_clerk_sub', ${auditActor(userId)}, true)`,
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
      if (!rows.length) return resp(404, { error: 'Not found or not owner' });
      return resp(200, rows[0]);
    }

    // V5-VOICEALIAS-001 — learned speech-recognition mishearings for the /log/voice chooser.
    //
    // THESE ROUTES LIVE IN THE VARIETIES LAMBDA ON PURPOSE, and the reason is a failure watched live
    // rather than a preference. A new Lambda needs a new Function URL, a new VITE_API_* variable, a
    // repo variable, AND a mapping into the build — and on 2026-08-30 the share feature shipped its
    // code twice while its endpoint never reached the bundle, because the last of those four steps
    // was missing. VITE_API_VARIETIES is already wired, already deployed and already proven, so
    // hanging these off it removes that entire class of failure. The data is variety-scoped anyway.
    //
    // CHECKED BEFORE idMatch, for the same reason /crop-types and /deleted are: a single trailing
    // segment is otherwise parsed as a variety id and this would 404 as "variety voice-aliases".
    //
    // USER-SCOPED, NOT HOUSEHOLD-SCOPED, and this is the one place this file deliberately departs
    // from its neighbours. Every other route here widens to `household` so Dave and Jen can edit each
    // other's cultivars. An alias must NOT widen: it records how ONE person's speech is misheard, and
    // the recogniser mishears different voices differently. Jen inheriting Dave's corrections would
    // silently steer her chooser using evidence about his audio. So these read and write ${userId}.
    if (rawPath === '/api/varieties/voice-aliases') {
      if (method === 'GET') {
        // The whole set, unpaginated by design: it is bounded by the phrases one person has actually
        // corrected (tens per season), the client needs all of them in memory to resolve an utterance
        // offline-fast, and a partial page would silently stop resolving the aliases it omitted.
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

        // VALIDATED HERE AND NOT ONLY BY THE CHECK CONSTRAINT. A constraint violation surfaces as a
        // 500, which the client cannot distinguish from a transport failure — and the one outcome
        // this feature must never have is a correction the user believes was learned and was not.
        // These return 400 with a reason instead.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(varietyId)) {
          return resp(400, { error: 'variety_id must be a uuid' });
        }
        // Mirrors voice_alias_heard_key_normalised_chk AND comboboxInput.looseKey's contract. An
        // un-normalised key inserts cleanly and then never matches a live utterance, so the failure
        // would present as "the app refuses to learn" with nothing in any log.
        if (heardKey !== heardKey.toLowerCase() || /[\s\p{P}]/u.test(heardKey)) {
          return resp(400, { error: 'heard_key must be lowercase with no whitespace or punctuation' });
        }
        if (heardKey.length < 4 || heardKey.length > 120) {
          return resp(400, { error: 'heard_key must be 4-120 characters' });
        }
        if (!heardText.trim()) return resp(400, { error: 'heard_text is required' });

        // The variety must exist and not be deleted. DELIBERATELY THE READ POLICY, NOT THE WRITE ONE
        // — this does not carry the household/managed-principal arm that PUT, DELETE and the recovery
        // reads use, and that is a correctness decision rather than an omission.
        //
        // This file's contract is "GET (list/by-id): globally readable (any authenticated user, any
        // non-deleted row)" while PUT/DELETE are household-scoped. An alias is a PERSONAL ANNOTATION
        // ON A READABLE THING, not an edit of the cultivar: it changes nothing about the variety, is
        // stored against ${userId}, and is invisible to everyone else. Gating it on the write
        // predicate would refuse to learn a name for a variety the chooser itself will happily list
        // and select — the user would watch the picker offer a cultivar and then watch the app refuse
        // to remember what they call it, with no explanation that made sense.
        //
        // The rule this follows: if a surface can SELECT it, the user may teach a name for it.
        // (Keeping the write arm out also leaves authz-household.test.js's count of exactly six
        // scoped predicates intact, which is the correct outcome and not the reason for it.)
        const [variety] = await sql`
          SELECT id FROM public.cultivar
           WHERE id = ${varietyId}
             AND deleted_at IS NULL
        `;
        if (!variety) return resp(404, { error: 'Variety not found' });

        // RETARGET, DO NOT ACCUMULATE. Re-teaching a phrase must move it, because the moment a user
        // teaches a phrase they already believe is wrong is exactly when a second row would make
        // resolution order-dependent — the correction would appear to work and then intermittently
        // not. hit_count resets: it counts uses of THIS meaning, and the old meaning's tally is not
        // evidence for the new one.
        const [row] = await sql`
          INSERT INTO public.voice_alias (user_id, heard_key, heard_text, variety_id)
               VALUES (${userId}, ${heardKey}, ${heardText}, ${varietyId})
          ON CONFLICT ON CONSTRAINT uq_voice_alias_user_phrase
            DO UPDATE SET variety_id = EXCLUDED.variety_id,
                          heard_text = EXCLUDED.heard_text,
                          hit_count  = 0,
                          last_used_at = NULL
            RETURNING heard_key, heard_text, variety_id, hit_count, last_used_at
        `;
        return resp(200, row);
      }

      return resp(405, { error: 'Method not allowed' });
    }

    const idMatch = rawPath.match(/^\/api\/varieties\/([^/]+)$/);

    // The /deleted exclusion rides on the USE, not the declaration: crop-type.test.js anchors the
    // route-ordering guard on the literal `const idMatch = rawPath.match`, and rewriting that line
    // would blind a guard that has nothing to do with this change.
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
                 days_to_germ_min, days_to_germ_max, sow_season, sow_notes
          FROM public.cultivar
          WHERE id = ${varietyId}
            AND deleted_at IS NULL
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');
        const verr = validateBody(body, { requireName: false });
        if (verr) return resp(400, { error: verr });

        const cerr = validateClear(body.clear, body);
        if (cerr) return resp(400, { error: cerr });

        const allowed = await checkRateLimit(sql, userId, 'plant_varieties.update', 120);
        if (!allowed) return resp(429, { error: 'Rate limit exceeded — 120/hour for plant_varieties.update' });

        // AUTHZ (BUG-AUTHZFKENUM-001): photo_id -> photos(id) was written verbatim from the body on
        // BOTH verbs while the DB FK proved only existence. NOT a read leak TODAY — live prod has
        // 0 of 408 cultivars with photo_id set and no frontend picker exists — but GET /api/varieties
        // and GET /api/varieties/:id are GLOBALLY readable and already SELECT photo_id, so the day a
        // resolver ships (the same shape as resolvePhotoViewUrl elsewhere) this becomes a
        // cross-household read with no further code change. Gated now, at zero measured cost.
        // Scoped with `household` (not householdIds) to match this handler's local naming; the
        // managed-principal widening in ./authz.js governs WHICH CULTIVAR may be edited, never which
        // photo may be attached — a managed row is still only attachable to household-owned photos.
        if (body.photo_id != null) {
          if (!await loadOwnedPhoto(sql, body.photo_id, household)) {
            warnRejectedFk(userId, 'plant_varieties', 'photo_id', body.photo_id);
            return resp(400, { error: 'photo_id does not match a photo you can use' });
          }
        }

        // PUT uses COALESCE pattern: undefined/null in body = keep existing.
        //
        // V4-EDITCOMPLETE-001 — that pattern alone makes every optional column WRITE-ONCE-SETTABLE:
        // once care_notes holds a value there is no body that returns it to NULL, because null and
        // absent are the same token on the wire. An edit form rendering such a field either omits it
        // (incomplete) or renders a box the user can empty and save with no effect (worse). So a
        // second, EXPLICIT channel: `clear` is an array of column keys to set to NULL. Absent/[] is
        // byte-identical to the prior behaviour, so every existing caller is unaffected.
        //
        // Shaped as CASE WHEN ${clear} @> ARRAY['k'] rather than a dynamically-built SET list because
        // the neon tagged-template API takes no interpolated identifiers, and rather than a bare null
        // param because neon cannot type a standalone null (the NULL here is a SQL literal typed by
        // the CASE's ELSE branch). Three-way behaviour verified against live Postgres.
        const cd = body.common_diseases;
        const clear = Array.isArray(body.clear) ? body.clear : [];
        const [, updateRows] = await sql.transaction([
          sql`SELECT set_config('app.actor_clerk_sub', ${auditActor(userId)}, true)`,
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
              sow_notes            = CASE WHEN ${clear} @> ARRAY['sow_notes'] THEN NULL ELSE COALESCE(${body.sow_notes ?? null}, sow_notes) END
            WHERE id = ${varietyId}
              AND ( created_by = ANY(${household})
                    OR created_by LIKE ANY(${managedPatterns}::text[]) )
              AND deleted_at IS NULL
            RETURNING id, display_name AS name, species, genus, days_to_maturity_min, days_to_maturity_max, care_notes, soil_notes, sun_requirements, common_diseases, expected_yield_notes, photo_id, source_url, crop_type_slug, lifecycle, scoville_min, scoville_max, growth_habit, produces_scape, created_by, created_at, updated_at, deleted_at, source_proj_rescope_project_id, origin_country, origin_region, model_version, determinacy, day_length_response, grown_as, start_method, start_indoor_weeks_min, start_indoor_weeks_max, direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in, days_to_germ_min, days_to_germ_max, sow_season, sow_notes
          `,
        ]);
        if (!updateRows.length) return resp(404, { error: 'Not found or not owner' });
        // V4-TAGSUB-001: post-commit, fail-open derive of type:/lifecycle: tags. Never 500s a variety write.
        try { await applyDerive(sql, varietyId); } catch (e) { console.error('TAGSUB derive (non-fatal) for cultivar', varietyId, e?.message ?? e); }
        return resp(200, updateRows[0]);
      }

      if (method === 'DELETE') {
        const [, deleteRows] = await sql.transaction([
          sql`SELECT set_config('app.actor_clerk_sub', ${auditActor(userId)}, true)`,
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
      // List + search. ?q= → ILIKE on name. Max 50 results.
      // Globally readable — no created_by filter.
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
                   breeding_system
            FROM public.cultivar
            WHERE deleted_at IS NULL
              AND LOWER(display_name) LIKE ${'%' + q.toLowerCase() + '%'}
            ORDER BY display_name ASC
            LIMIT 500
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
                   breeding_system
            FROM public.cultivar
            WHERE deleted_at IS NULL
            ORDER BY display_name ASC
            LIMIT 500
          `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const verr = validateBody(body, { requireName: true });
      if (verr) return resp(400, { error: verr });

      // V1.2a-4 S6 admin classify inline-create: when caller passes
      // source_proj_rescope_project_id, treat POST as idempotent on that key.
      // If a variety already exists for this source project, return it (200);
      // skip the name/species fuzzy-match check (admin is authoritative).
      // Per design proj-rescope-s6-design-V001-20260519.1625.md §4 Q3 + §5.3 #6.
      //
      // THE IDEMPOTENCY SELECT BELOW IS HOUSEHOLD-SCOPED, and that is a SECOND fix, not decoration
      // (BUG-AUTHZFKENUM-001). It used to read `WHERE source_proj_rescope_project_id = $1 AND
      // deleted_at IS NULL LIMIT 1` with no owner predicate and no ORDER BY, which made it
      // pre-squattable: an attacker POSTs a cultivar carrying a key they expect an admin to use
      // later, and the admin's inline-create returns the ATTACKER'S ROW (200) instead of minting
      // one — the attacker chooses the cultivar the admin's project gets classified as. The owner
      // arms mirror the PUT/DELETE editable set exactly (household + managed principals), so the
      // 4 live rows on this key still resolve. ORDER BY makes the LIMIT 1 deterministic rather than
      // whatever the planner returns first.
      //
      // AUTHZ (BUG-AUTHZFKENUM-001): source_proj_rescope_project_id -> plant_projects was ungated,
      // so a caller could mint a cultivar keyed to another household's project. Gated with the
      // canonical project predicate. Measured on live prod: all 5 rows carrying this key are
      // single-owner, so this costs zero legitimate writes.
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
                 days_to_germ_min, days_to_germ_max, sow_season, sow_notes
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
      if (!allowed) return resp(429, { error: 'Rate limit exceeded — 60/hour for plant_varieties.create' });

      // AUTHZ (BUG-AUTHZFKENUM-001): the create half of the photo_id gate — see the PUT arm above
      // for why an unset-in-prod column still has to be gated. Gating one verb is the shape of the
      // original bug, so both are gated or neither is.
      if (body.photo_id != null) {
        if (!await loadOwnedPhoto(sql, body.photo_id, household)) {
          warnRejectedFk(userId, 'plant_varieties', 'photo_id', body.photo_id);
          return resp(400, { error: 'photo_id does not match a photo you can use' });
        }
      }

      // Fuzzy-match warning (advisory). Frontend may show "similar exists, override?"
      // by re-POSTing with allow_duplicate=true. Backend honors the override.
      // Skipped when sourceProjId is present — admin idempotent-by-source-id is authoritative.
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

      const [, insertRows] = await sql.transaction([
        sql`SELECT set_config('app.actor_clerk_sub', ${auditActor(userId)}, true)`,
        sql`
          INSERT INTO public.cultivar (
            display_name, species, genus,
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
          ) RETURNING id, display_name AS name, species, genus, days_to_maturity_min, days_to_maturity_max, care_notes, soil_notes, sun_requirements, common_diseases, expected_yield_notes, photo_id, source_url, crop_type_slug, lifecycle, scoville_min, scoville_max, growth_habit, produces_scape, created_by, created_at, updated_at, deleted_at, source_proj_rescope_project_id, origin_country, origin_region, model_version, determinacy, day_length_response, grown_as, start_method, start_indoor_weeks_min, start_indoor_weeks_max, direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in, days_to_germ_min, days_to_germ_max, sow_season, sow_notes
        `,
      ]);
      // V4-TAGSUB-001: post-commit, fail-open derive of type:/lifecycle: tags. Never 500s a variety write.
      try { await applyDerive(sql, insertRows[0].id); } catch (e) { console.error('TAGSUB derive (non-fatal) for cultivar', insertRows[0].id, e?.message ?? e); }
      return resp(201, insertRows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('varieties lambda error', err);
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    if (err.code === '23502') return resp(400, { error: `Required field missing: ${err.column ?? err.message}` });
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    if (err.code === '23505') return resp(409, { error: `Unique violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
