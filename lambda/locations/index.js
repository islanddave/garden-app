import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope, loadOwnedLocation, warnRejectedFk } from './household.js';
import { resolvePhotoViewUrl } from './photo-access.js';
import { validateClear } from './validate.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET = process.env.S3_PHOTOS_BUCKET;

async function getFeaturedPhotoViewUrl(storagePath) {
  if (!storagePath || !BUCKET) return null;
  try {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: storagePath });
    return await getSignedUrl(s3, cmd, { expiresIn: 900 });
  } catch (err) {
    console.error('getFeaturedPhotoViewUrl failed', err?.message ?? err);
    return null;
  }
}

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

function buildHierarchy(rows) {
  const byId = Object.fromEntries(rows.map(r => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const row of rows) {
    if (row.parent_id && byId[row.parent_id]) {
      byId[row.parent_id].children.push(byId[row.id]);
    } else {
      roots.push(byId[row.id]);
    }
  }
  return roots;
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
  const rawPath = event.rawPath ?? '/api/locations';
  const householdIds = householdScope(userId);

  // Plural entity-tags debris route REMOVED 2026-07-28 (data-audit P1-code, evidence W0.6-r1:
  // CONFIRMED-DEAD — this block was the sole consumer of the plural debris table; the frontend
  // routes all /api/entity-tags traffic to the tags Lambda (src/lib/api.js -> VITE_API_TAGS,
  // locked by src/__tests__/api.test.js), which uses singular entity_tag exclusively).
  // Explicit 404 tombstone: without it the trailing unguarded GET list route would answer this
  // path with the locations list (200), silently resurrecting a route contract.
  if (rawPath === '/api/entity-tags') return resp(404, { error: 'Not found' });

  const idMatch = rawPath !== '/api/locations/with-path'
    && rawPath !== '/api/locations/deleted'
    && rawPath.match(/^\/api\/locations\/([^/]+)$/);

  try {
    // ── V4-RESTORESURFACE-001 — the recovery path for locations (audit I9) ───────────────────────
    //
    // lambda/photos is the reference standard and states the governing principle: "A destructive
    // control must not ship ahead of the recovery path it advertises." For locations the destructive
    // control shipped long ago (the DELETE arm below) with no way to see or undo it, so this closes
    // an existing gap rather than adding a new surface. 10 locations are soft-deleted in prod today
    // with no affordance to bring any of them back.
    //
    // ORDERING IS LOAD-BEARING. `/api/locations/deleted` is a single trailing segment, so idMatch
    // below would otherwise capture it as a location id and answer with a 404 from the by-id GET.
    // Declared here, and excluded from idMatch, for the same reason /with-path already is — mirroring
    // how photos declares its own /deleted above the bare-:id arm.
    if (rawPath === '/api/locations/deleted' && method === 'GET') {
      // Clamped exactly like listDeletedPhotos: an unbounded limit on a recovery list is a foot-gun,
      // and the surface is meant for recent deletions, not an archive trawl.
      const rawLimit = Number(event?.queryStringParameters?.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
      const rows = await sql`
        SELECT l.id, l.name, l.slug, l.level, l.type_label, l.parent_id, l.created_at, l.deleted_at
          FROM locations l
         WHERE l.created_by = ANY(${householdIds})
           AND l.deleted_at IS NOT NULL
         ORDER BY l.deleted_at DESC, l.id DESC
         LIMIT ${limit}
      `;
      return resp(200, { locations: rows });
    }

    // POST /api/locations/:id/restore — two segments, so idMatch cannot capture it; matched here to
    // keep the whole recovery path in one place.
    const restoreMatch = rawPath.match(/^\/api\/locations\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      const locId = restoreMatch[1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(locId))) {
        return resp(404, { error: 'Not found' });
      }
      // IDEMPOTENT, matching restorePhoto: restoring a live row is a 200 with already_restored rather
      // than a 404, so a double-tap or a replayed request is not an error the user has to interpret.
      const [existing] = await sql`
        SELECT id, deleted_at FROM locations
         WHERE id = ${locId} AND created_by = ANY(${householdIds})
      `;
      if (!existing) return resp(404, { error: 'Not found' });
      if (!existing.deleted_at) return resp(200, { id: existing.id, deleted_at: null, already_restored: true });

      try {
        const rows = await sql`
          UPDATE locations
             SET deleted_at = NULL
           WHERE id = ${locId}
             AND created_by = ANY(${householdIds})
             AND deleted_at IS NOT NULL
          RETURNING id, name, slug, deleted_at
        `;
        return resp(200, rows[0] ?? { id: locId, deleted_at: null, already_restored: true });
      } catch (err) {
        // NOT inert here, unlike the photos equivalent. idx_locations_root_slug is UNIQUE over live
        // root-level slugs, and a deleted location sits OUTSIDE it — so coming back collides if the
        // slug was reused while it was gone. A typed 409 says something the user can act on (rename
        // the current one, or the restored one); a 500 says the app is broken.
        if (err?.code === '23505') {
          return resp(409, { error: 'A location with that slug already exists', code: 'location_slug_conflict' });
        }
        throw err;
      }
    }


    if (idMatch) {
      const locId = idMatch[1];

      if (method === 'GET') {
        const rows = await sql`
          SELECT l.id, l.name, l.slug, l.level, l.type_label, l.parent_id, l.sort_order,
                 l.description, l.is_active, l.created_at,
                 COALESCE(fp.id, fb.id) AS featured_photo_id,
                 (fp.id IS NOT NULL) AS featured_is_explicit,
                 COALESCE(fp.storage_path, fb.storage_path) AS featured_photo_storage_path
          FROM locations l
          -- BUG-PHOTOHEROMOVE-001 / INV-HERO — the hero is DERIVED here, never trusted from the
          -- stored pointer. Same shape as fetchSpaceHero (lambda/photos/index.js:~314); read its
          -- long-form rationale before touching this. Two predicates: the photo must be ALIVE, and
          -- it must STILL be a member of this zone's gallery.
          --
          -- The membership arm is the one that bites today. Reassign ships (PhotoLibrary's tag
          -- modal, full-replace PUT): moving photo P from zone A to B re-parents the row and leaves
          -- A.featured_photo_id = P. NOTHING IS DELETED, so no deleted_at filter can ever catch it
          -- — only re-checking membership can.
          --
          -- The predicate fp.location_id = l.id is exactly the linkage the set-featured WRITE validator
          -- enforces (~:150 below). Read half and write half of ONE invariant: diverging them
          -- manufactures the silent-revert bug fetchSpaceHero documents (the user re-picks the
          -- photo, the write accepts, the read demotes it again). Change one, change both.
          -- EXACT match, deliberately NOT the recursive loc_subtree walk the ?location_id gallery
          -- uses: the write validator is exact, so a subtree-wide read arm would accept a hero the
          -- write refuses — the same divergence from the opposite direction.
          LEFT JOIN photos fp
                 ON fp.id = l.featured_photo_id
                AND fp.deleted_at IS NULL
                AND fp.created_by = ANY(${householdIds})
                AND fp.location_id = l.id
          LEFT JOIN LATERAL (
                 SELECT ph.id, ph.storage_path
                   FROM photos ph
                  WHERE ph.location_id = l.id
                    AND ph.deleted_at IS NULL
                    AND ph.created_by = ANY(${householdIds})
                  ORDER BY ph.created_at DESC, ph.id DESC
                  LIMIT 1
               ) fb ON TRUE
          WHERE (l.slug = ${locId} OR l.id::text = ${locId}) AND l.deleted_at IS NULL AND l.created_by = ANY(${householdIds})
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        const row = rows[0];
        const featured_photo_view_url = await resolvePhotoViewUrl(row.featured_photo_storage_path, { presign: getFeaturedPhotoViewUrl, sm });
        const { featured_photo_storage_path: _ignore, ...rest } = row;
        return resp(200, { ...rest, featured_photo_view_url });
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');

        // V2-PHOTO-F1: strict validation for featured_photo_id (linkage = photos.location_id).
        // Resolve UUID first (route accepts slug OR uuid).
        let actualLocationId = locId;
        if (Object.prototype.hasOwnProperty.call(body, 'featured_photo_id')) {
          const idRows = await sql`
            SELECT id::text AS id FROM locations
             WHERE (slug = ${locId} OR id::text = ${locId}) AND deleted_at IS NULL AND created_by = ANY(${householdIds})
          `;
          if (!idRows.length) return resp(404, { error: 'Not found' });
          actualLocationId = idRows[0].id;
          if (body.featured_photo_id != null) {
            // V4-AUTHZSWEEP-001: anchor on created_by, not uploaded_by. photos carries BOTH columns
            // and every other featured-photo validator (inventory-items, projects, plants) uses
            // created_by; this one was the odd surface out. They agree on all 977 live photo rows
            // today, so this is consistency hardening rather than a live bug — but a divergence would
            // have made this the one surface that accepted a photo the others rejected.
            const linkRows = await sql`
              SELECT 1 FROM photos
               WHERE id = ${body.featured_photo_id}
                 AND location_id = ${actualLocationId}
                 AND created_by = ANY(${householdIds})
                 AND deleted_at IS NULL
            `;
            if (!linkRows.length) {
              return resp(400, { error: 'featured_photo_id must be a photo linked to this location' });
            }
          }
        }
        const hasFeatured = Object.prototype.hasOwnProperty.call(body, 'featured_photo_id');

        // BUG-BLANKNAME-001 (2026-08-07). `name` is NOT NULL, so it looks protected — but the
        // COALESCE only guards against NULL, and Locations.jsx:102 sends `editForm.name.trim()`.
        // An emptied box therefore sends '', which is not NULL, sails past both the COALESCE and
        // the NOT NULL constraint, and overwrites the name with an empty string.
        //
        // On THIS table that is a care regression, not just cosmetics: daily-plan/handler.js
        // derives `covered` partly from `l.name in ('Stable','House')`. Stable carries 20 live
        // plantings and House 6, so blanking (or renaming) either one silently reclassifies 26
        // plantings as OUTDOOR — they start taking rain credit under a roof and drop out of the
        // frost pass's covered exclusion. Reachable from the edit form today; 0 blank rows on prod.
        //
        // Renaming remains possible and is not guarded here — a rename is a legitimate edit whose
        // care consequence is the name-matching predicate's fault, tracked separately. Blanking is
        // never legitimate. varieties/validate.js:54 already refuses exactly this shape.
        //
        // Deliberately NOT `!body.name` and NOT hasOwnProperty-alone: `name: null` and an absent
        // key are the EXISTING no-op grammar of this COALESCE PUT, and every current caller relies
        // on it. Rejecting those would convert a working request into a 400. The defect is
        // specifically a present, non-null, whitespace-only string, so that is exactly what this
        // refuses — the narrowest predicate that still closes it.
        if (body.name != null && (typeof body.name !== 'string' || !body.name.trim())) {
          return resp(400, { error: 'name cannot be blank' });
        }

        // BUG-COALESCECLEAR-001. Absent/[] is byte-identical to the prior behaviour, so this ships
        // inert until a client opts in. Exactly one of the 5 arms is clearable — see validate.js
        // for why the other four are not, in particular type_label, which is a care-engine input.
        const _cerr = validateClear(body.clear, body);
        if (_cerr) return resp(400, { error: _cerr });
        const clear = Array.isArray(body.clear) ? body.clear : [];

        const rows = await sql`
          UPDATE locations
          SET
            name        = COALESCE(${body.name ?? null}, name),
            type_label  = COALESCE(${body.type_label ?? null}, type_label),
            sort_order  = COALESCE(${body.sort_order ?? null}, sort_order),
            description = CASE WHEN ${clear} @> ARRAY['description'] THEN NULL ELSE COALESCE(${body.description ?? null}, description) END,
            is_active   = COALESCE(${body.is_active ?? null}, is_active),
            featured_photo_id = CASE
              WHEN ${hasFeatured} THEN ${body.featured_photo_id ?? null}
              ELSE featured_photo_id
            END
          WHERE (slug = ${locId} OR id::text = ${locId})
            AND deleted_at IS NULL
            AND created_by = ANY(${householdIds})
          RETURNING *
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        // BUG-DELNOOPOK-001: RETURNING-gated. Was an unconditional {ok:true}, so a not-found /
        // already-deleted / not-owned DELETE reported success; now 404, matching the GET (:220)
        // and the PUT (:308) on this same path.
        //
        // The predicate also gains the slug-or-uuid arm the other two verbs have always had. This
        // route matcher is `/^\/api\/locations\/([^/]+)$/` and GET/PUT both resolve
        // `(slug = ${locId} OR id::text = ${locId})`, but DELETE compared a raw text path segment
        // against the `uuid` column. MEASURED against live Neon rather than assumed: a prepared
        // `WHERE id = $1` bound with 'raised-bed' raises
        // `22P02 invalid input syntax for type uuid`, which this file's catch (:415) turns into a
        // 500 — so a DELETE by slug was never a silent no-op, it was an unhandled error. Nothing
        // ships a slug here today (Locations.jsx:132 passes loc.id), so this is a latent trap
        // being closed, not a live bug — but leaving one verb of three on a different key while
        // that verb also starts returning 404 would make the asymmetry read as a real 404.
        const rows = await sql`
          UPDATE locations
          SET deleted_at = NOW()
          WHERE (slug = ${locId} OR id::text = ${locId})
            AND deleted_at IS NULL
            AND created_by = ANY(${householdIds})
          RETURNING id
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      const [locRows, pathRows] = await Promise.all([
        sql`
          SELECT id, name, slug, level, type_label, parent_id, sort_order,
                 description, is_active, created_at
          FROM locations
          WHERE deleted_at IS NULL AND created_by = ANY(${householdIds})
          ORDER BY level, sort_order, name
        `,
        sql`
          SELECT id, full_path, level, is_active
          FROM locations_with_path
          WHERE deleted_at IS NULL
            AND id IN (SELECT id FROM locations WHERE deleted_at IS NULL AND created_by = ANY(${householdIds}))
          ORDER BY full_path
        `,
      ]);
      return resp(200, rawPath === "/api/locations/with-path" ? pathRows : { locations: locRows, locations_with_path: pathRows });
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.name) return resp(400, { error: 'name is required' });

      // AUTHZ (BUG-AUTHZFKENUM-001): parent_id was NOT gated here, despite the household-scoped
      // SELECT below looking like a gate. It only ever read the parent's `level`; a foreign or
      // non-existent parent simply left `level = 0` and the INSERT then stored body.parent_id
      // VERBATIM. That is a live cross-household READ, not merely a bad FK: `locations_with_path`
      // is a recursive CTE view with NO created_by filter, so the attacker's own row's `full_path`
      // comes back with the victim's ancestor names concatenated into it — and the GET above
      // returns locations_with_path rows for every location the caller owns.
      // Generic 400, no existence oracle. Measured on live prod: all 21 parented locations are
      // single-owner, so this gate costs zero legitimate writes.
      if (body.parent_id != null) {
        if (!await loadOwnedLocation(sql, body.parent_id, householdIds)) {
          warnRejectedFk(userId, 'locations', 'parent_id', body.parent_id);
          return resp(400, { error: 'parent_id does not match a location you can use' });
        }
      }

      let level = 0;
      if (body.parent_id) {
        const parentRows = await sql`
          SELECT level FROM locations WHERE id = ${body.parent_id} AND deleted_at IS NULL AND created_by = ANY(${householdIds})
        `;
        if (parentRows.length) level = Math.min(parentRows[0].level + 1, 3);
      }

      const slug = body.slug?.trim() ||
        body.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      const rows = await sql`
        INSERT INTO locations
          (name, slug, level, type_label, parent_id, sort_order, description, created_by)
        VALUES (
          ${body.name},
          ${slug},
          ${level},
          ${body.type_label ?? null},
          ${body.parent_id ?? null},
          ${body.sort_order ?? 0},
          ${body.description ?? null},
          ${userId}
        )
        RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('locations lambda error', err);
    if (err.code === '23505') return resp(409, { error: 'Slug already exists' });
    // BUG-COALESCECLEAR-001 audit finding: this catch mapped ONLY 23505. Every sibling handler
    // (plants, projects, events) maps 23503 and 23514 too; locations was the one surface that never
    // adopted it, so a caller-provokable constraint violation surfaced as "Internal server error"
    // with no message. It USED to be reachable via the POST, which accepted a parent_id it could not
    // verify ownership of and inserted it anyway, so a non-existent uuid raised 23503 here. That
    // ownership hole is CLOSED as of BUG-AUTHZFKENUM-001 (the loadOwnedLocation gate in the POST
    // above answers a foreign OR absent parent with a generic 400 before the INSERT), so this arm is
    // now parity/defence-in-depth rather than the live path.
    //
    // Nothing on the clear allowlist can reach either code — `description` carries no CHECK and no
    // FK, and the three CHECKs on this table (chk_lat_lng_co_null, locations_level_check,
    // locations_zone_level_check) reference no PUT arm. Added for parity, not because the channel
    // needs it.
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
