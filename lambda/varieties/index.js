// /api/varieties — VARIETY-REF Session 2 Lambda
// Layer 1 canonical reference table for plant varieties.
// Pattern: mirrors lambda/plants/index.js + lambda/inventory-items/index.js
// Spec: varieties-schema-design-V001-20260508.md
//
// Auth: Clerk JWT verified per request → userId = JWT.sub
// RLS: enforced in WHERE clauses, not Postgres (vestigial under Neon).
//   - GET (list/by-id): globally readable (any authenticated user, any non-deleted row)
//   - POST/PUT/DELETE: owner-only (created_by = JWT.sub)
//   - GET /api/varieties/crop-types: globally readable controlled vocabulary (V4-PLANTTYPE-001)
//
// Audit: trigger trg_audit_plant_varieties writes to audit_events. Lambda sets
// SET LOCAL app.actor_clerk_sub = $userId after BEGIN so trigger reads the actor.
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
import { validateBody, validateCropTypeBody, resolveCropTypeName } from './validate.js';
import { applyDerive } from './crop-derive.js';

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

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/varieties';

  try {
    // PLANTTYPE: controlled crop-type vocabulary. Globally readable; checked BEFORE the
    // /api/varieties/:id route so "crop-types" is not mis-parsed as a variety id.
    if (rawPath === '/api/varieties/crop-types') {
      if (method === 'GET') {
        const rows = await sql`
          SELECT slug, display_name, default_lifecycle, category, sort_order
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

    const idMatch = rawPath.match(/^\/api\/varieties\/([^/]+)$/);

    if (idMatch) {
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

        const allowed = await checkRateLimit(sql, userId, 'plant_varieties.update', 120);
        if (!allowed) return resp(429, { error: 'Rate limit exceeded — 120/hour for plant_varieties.update' });

        // PUT uses COALESCE pattern: undefined/null in body = keep existing.
        // Wrap set_config + UPDATE in sql.transaction so SET LOCAL is visible to
        // the audit trigger (true = LOCAL scope, valid in transaction).
        const cd = body.common_diseases;
        const [, updateRows] = await sql.transaction([
          sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
          sql`
            UPDATE public.cultivar SET
              display_name         = COALESCE(${body.name ?? null}, display_name),
              species              = COALESCE(${body.species ?? null}, species),
              genus                = COALESCE(${body.genus ?? null}, genus),
              days_to_maturity_min = COALESCE(${body.days_to_maturity_min ?? null}, days_to_maturity_min),
              days_to_maturity_max = COALESCE(${body.days_to_maturity_max ?? null}, days_to_maturity_max),
              care_notes           = COALESCE(${body.care_notes ?? null}, care_notes),
              soil_notes           = COALESCE(${body.soil_notes ?? null}, soil_notes),
              sun_requirements     = COALESCE(${body.sun_requirements ?? null}, sun_requirements),
              common_diseases      = COALESCE(${Array.isArray(cd) ? cd : null}, common_diseases),
              expected_yield_notes = COALESCE(${body.expected_yield_notes ?? null}, expected_yield_notes),
              photo_id             = COALESCE(${body.photo_id ?? null}, photo_id),
              source_url           = COALESCE(${body.source_url ?? null}, source_url),
              crop_type_slug       = COALESCE(${body.crop_type_slug ?? null}, crop_type_slug),
              lifecycle            = COALESCE(${body.lifecycle ?? null}, lifecycle),
              scoville_min         = COALESCE(${body.scoville_min ?? null}, scoville_min),
              scoville_max         = COALESCE(${body.scoville_max ?? null}, scoville_max),
              growth_habit         = COALESCE(${body.growth_habit ?? null}, growth_habit),
              produces_scape       = COALESCE(${body.produces_scape ?? null}, produces_scape),
              determinacy          = COALESCE(${body.determinacy ?? null}, determinacy),
              day_length_response  = COALESCE(${body.day_length_response ?? null}, day_length_response),
              grown_as             = COALESCE(${body.grown_as ?? null}, grown_as),
              start_method         = COALESCE(${body.start_method ?? null}, start_method),
              start_indoor_weeks_min = COALESCE(${body.start_indoor_weeks_min ?? null}, start_indoor_weeks_min),
              start_indoor_weeks_max = COALESCE(${body.start_indoor_weeks_max ?? null}, start_indoor_weeks_max),
              direct_sow_timing    = COALESCE(${body.direct_sow_timing ?? null}, direct_sow_timing),
              sow_depth_in         = COALESCE(${body.sow_depth_in ?? null}, sow_depth_in),
              seed_spacing_in      = COALESCE(${body.seed_spacing_in ?? null}, seed_spacing_in),
              row_spacing_in       = COALESCE(${body.row_spacing_in ?? null}, row_spacing_in),
              days_to_germ_min     = COALESCE(${body.days_to_germ_min ?? null}, days_to_germ_min),
              days_to_germ_max     = COALESCE(${body.days_to_germ_max ?? null}, days_to_germ_max),
              sow_season           = COALESCE(${body.sow_season ?? null}, sow_season),
              sow_notes            = COALESCE(${body.sow_notes ?? null}, sow_notes)
            WHERE id = ${varietyId}
              AND created_by = ${userId}
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
          sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
          sql`
            UPDATE public.cultivar
            SET deleted_at = NOW()
            WHERE id = ${varietyId}
              AND created_by = ${userId}
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
                   days_to_germ_min, days_to_germ_max, sow_season, sow_notes
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
                   days_to_germ_min, days_to_germ_max, sow_season, sow_notes
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
          LIMIT 1
        `;
        if (existing.length) return resp(200, existing[0]);
      }

      const allowed = await checkRateLimit(sql, userId, 'plant_varieties.create', 60);
      if (!allowed) return resp(429, { error: 'Rate limit exceeded — 60/hour for plant_varieties.create' });

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
        sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
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
