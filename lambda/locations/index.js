import { neon } from '@neondatabase/serverless';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope, loadOwnedLocation, warnRejectedFk } from './household.js';
import { requestContext } from './request-context.js';
import { dbErrorReply, logCaughtError } from './db-error.js';
import { resolvePhotoViewUrl } from './photo-access.js';
import { validateClear } from './validate.js';
import { resolveLocationRow, loadLocationRef, AMBIGUOUS_REF_STATUS, AMBIGUOUS_REF_BODY } from './ref.js';
import { validateHeatedType, heatedCoverError, nextFlagsForPut, nextFlagsForPost } from './heated.js';

// photo-access.js reads the CloudFront signing key through this client; the kit holds its own for garden-app/secrets.
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
  // The kit answers OPTIONS and every sign-in refusal (401, the household gate's 403) before any statement.
  // householdIds stays a line of its own, after the kit's empty-sub 401: household-mode.test.js pins it here.
  const ctx = await requestContext(event, { resp, neon });
  if (ctx.response) return ctx.response;
  const { userId, sql } = ctx;
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/locations';
  const householdIds = householdScope(userId);

  // Plural entity-tags debris route REMOVED: the frontend routes all /api/entity-tags traffic to the tags
  // Lambda (src/lib/api.js -> VITE_API_TAGS, locked by src/__tests__/api.test.js). Explicit 404 tombstone:
  // without it the trailing unguarded GET list route would answer this path with the locations list.
  if (rawPath === '/api/entity-tags') return resp(404, { error: 'Not found' });

  const idMatch = rawPath !== '/api/locations/with-path'
    && rawPath !== '/api/locations/deleted'
    && rawPath.match(/^\/api\/locations\/([^/]+)$/);

  try {
    // ── Recovery path for locations (V4-RESTORESURFACE-001, audit I9) ──
    // "A destructive control must not ship ahead of the recovery path it advertises" (lambda/photos is the
    // reference). The DELETE arm below shipped with no way to see or undo it.
    //
    // ORDERING IS LOAD-BEARING. `/api/locations/deleted` is a single trailing segment, so idMatch below
    // would capture it as a location id and answer 404 from the by-id GET. Declared here, and excluded from
    // idMatch like /with-path, mirroring how photos declares its own /deleted above the bare-:id arm.
    if (rawPath === '/api/locations/deleted' && method === 'GET') {
      // Clamped like listDeletedPhotos: the surface is for recent deletions, not an archive trawl.
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

    // POST /api/locations/:id/restore has two segments, so idMatch cannot capture it; matched here to keep
    // the whole recovery path in one place.
    const restoreMatch = rawPath.match(/^\/api\/locations\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      const locId = restoreMatch[1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(locId))) {
        return resp(404, { error: 'Not found' });
      }
      // IDEMPOTENT, matching restorePhoto: restoring a live row is a 200 with already_restored, not a 404.
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
        // idx_locations_root_slug is UNIQUE over live root-level slugs and a deleted location sits OUTSIDE
        // it, so coming back collides if the slug was reused meanwhile. A typed 409 is actionable (rename
        // one); a 500 says the app is broken.
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
        // BUG-LOCDELSLUG-001. GET can apply the ref.js rule for free: it already fetched every match, so the
        // tiebreak is arithmetic on rows in hand (an id match wins, a lone slug match resolves, several 409).
        const picked = resolveLocationRow(rows, locId);
        if (picked.ambiguous) return resp(AMBIGUOUS_REF_STATUS, AMBIGUOUS_REF_BODY);
        if (!picked.row) return resp(404, { error: 'Not found' });
        const row = picked.row;
        const featured_photo_view_url = await resolvePhotoViewUrl(row.featured_photo_storage_path, { presign: getFeaturedPhotoViewUrl, sm });
        const { featured_photo_storage_path: _ignore, ...rest } = row;
        return resp(200, { ...rest, featured_photo_view_url });
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');

        // V2-PHOTO-F1: strict validation for featured_photo_id (linkage = photos.location_id).
        // The ref is resolved UNCONDITIONALLY (BUG-LOCDELSLUG-001): the UPDATE would otherwise run against
        // the ambiguous slug-or-uuid predicate and write SIX columns to EVERY match. Everything below keys
        // on actualLocationId, never on locId.
        const picked = await loadLocationRef(sql, locId, householdIds);
        if (picked.ambiguous) return resp(AMBIGUOUS_REF_STATUS, AMBIGUOUS_REF_BODY);
        if (!picked.row) return resp(404, { error: 'Not found' });
        const actualLocationId = picked.row.id;
        if (Object.prototype.hasOwnProperty.call(body, 'featured_photo_id')) {
          if (body.featured_photo_id != null) {
            // Anchor on created_by, not uploaded_by (V4-AUTHZSWEEP-001): photos carries BOTH columns and
            // every other featured-photo validator (inventory-items, projects, plants) uses created_by.
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

        // BUG-BLANKNAME-001. `name` is NOT NULL but COALESCE only guards NULL, and Locations.jsx sends
        // `editForm.name.trim()`: an emptied box sends '', which sails past both and blanks the name.
        // The guard stays even though coverage no longer reads l.name (V4-COVEREDNOTMODELLED-001): a blank
        // name is never legitimate, and varieties/validate.js refuses the same shape.
        // Deliberately NOT `!body.name` and NOT hasOwnProperty-alone: `name: null` and an absent key are the
        // EXISTING no-op grammar of this COALESCE PUT. The defect is a present, non-null, whitespace-only
        // string, so that is exactly what this refuses.
        if (body.name != null && (typeof body.name !== 'string' || !body.name.trim())) {
          return resp(400, { error: 'name cannot be blank' });
        }

        // BUG-COALESCECLEAR-001. Absent/[] is byte-identical to the prior behaviour. Exactly one of the 5 arms
        // is clearable; validate.js says why the other four are not (type_label is a care-engine input).
        const _cerr = validateClear(body.clear, body);
        if (_cerr) return resp(400, { error: _cerr });
        const clear = Array.isArray(body.clear) ? body.clear : [];

        // heated.js carries both rules and why (V5-LOCHEATEDUI-001). Heated-implies-covered is judged on the
        // row as it will be WRITTEN, so the row's current pair is read on every PUT: a body carrying only
        // covered=false breaks it on an already-heated location. Reading always also means an already
        // inconsistent row (hand-written SQL; the standing gate reports it) answers with this plain 400
        // rather than the guard's zero-row 404 below.
        const _herr = validateHeatedType(body);
        if (_herr) return resp(400, { error: _herr });
        const [flags] = await sql`
          SELECT covered, heated FROM locations
           WHERE id = ${actualLocationId}
             AND deleted_at IS NULL
             AND created_by = ANY(${householdIds})
        `;
        if (!flags) return resp(404, { error: 'Not found' });
        const _coverErr = heatedCoverError(nextFlagsForPut(body, flags));
        if (_coverErr) return resp(400, { error: _coverErr });

        const rows = await sql`
          UPDATE locations
          SET
            name        = COALESCE(${body.name ?? null}, name),
            type_label  = COALESCE(${body.type_label ?? null}, type_label),
            sort_order  = COALESCE(${body.sort_order ?? null}, sort_order),
            description = CASE WHEN ${clear} @> ARRAY['description'] THEN NULL ELSE COALESCE(${body.description ?? null}, description) END,
            is_active   = COALESCE(${body.is_active ?? null}, is_active),
            -- V4-COVEREDNOTMODELLED-001. COALESCE handles a false correctly (it skips NULL, not
            -- falsiness), so both directions are settable and an absent key stays a no-op — the same
            -- grammar is_active has relied on since this PUT was written.
            -- DELIBERATELY NOT in CLEARABLE_FIELDS: covered is a care-engine input on the nightly
            -- critical path, and clearing it back to NULL would hand a bed Dave has already
            -- classified back to the type_label heuristic. Setting it wrong is one more tap to fix;
            -- there is no operation "I no longer know whether this bed is under cover".
            covered     = COALESCE(${body.covered ?? null}, covered),
            -- V5-LOCHEATEDUI-001. Same grammar as covered: an absent key leaves the column alone.
            -- NOT NULL, so there is no clear arm and never can be.
            heated      = COALESCE(${body.heated ?? null}, heated),
            featured_photo_id = CASE
              WHEN ${hasFeatured} THEN ${body.featured_photo_id ?? null}
              ELSE featured_photo_id
            END
          WHERE id = ${actualLocationId}
            AND deleted_at IS NULL
            AND created_by = ANY(${householdIds})
            -- V5-LOCHEATEDUI-001. heated implies covered, re-checked on the row being written. The
            -- read above answers the ordinary case with a 400; this closes the gap between that read
            -- and this write (two PUTs interleaving, one ticking heated, one clearing covered). A
            -- write refused here matches no row and takes the 404 below. State stays consistent.
            AND (COALESCE(${body.heated ?? null}, heated) IS NOT TRUE
                 OR COALESCE(${body.covered ?? null}, covered) IS TRUE)
          RETURNING *
        `;
        // Still RETURNING-gated: resolve and write are separate statements (neon runs each in its own
        // transaction), so a concurrent DELETE in between is a real zero-row case.
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        // BUG-DELNOOPOK-001: RETURNING-gated, so a not-found / already-deleted / not-owned DELETE is a 404
        // like the GET and PUT, not a success. The ref accepts slug OR uuid like the other two verbs
        // (a raw slug against the uuid column raised 22P02 and 500'd).
        //
        // BUG-LOCDELSLUG-001: that slug arm is not single-valued (ref.js has the index evidence), so a
        // duplicated child slug soft-deleted EVERY match and answered 200 {ok:true}. Resolve to a single id
        // FIRST, then key on it. Soft-Delete-Only makes the extra rows recoverable but not harmless: each is
        // a separate POST /:id/restore nobody knows to make, because the response said ok.
        const picked = await loadLocationRef(sql, locId, householdIds);
        if (picked.ambiguous) return resp(AMBIGUOUS_REF_STATUS, AMBIGUOUS_REF_BODY);
        if (!picked.row) return resp(404, { error: 'Not found' });
        const rows = await sql`
          UPDATE locations
          SET deleted_at = NOW()
          WHERE id = ${picked.row.id}
            AND deleted_at IS NULL
            AND created_by = ANY(${householdIds})
          RETURNING id
        `;
        // Kept: a concurrent delete between resolve and write is a genuine zero-row outcome and must 404.
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      const [locRows, pathRows] = await Promise.all([
        sql`
          SELECT id, name, slug, level, type_label, parent_id, sort_order,
                 description, is_active, covered, heated, created_at
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
      // BUG-LAMBDAVALIDATION-001 (I41): `!body.name` let '   ' through and 500'd on a number at the slug
      // derivation below. Same rule as the PUT's blank guard; the POST keeps its own message.
      if (typeof body.name !== 'string' || !body.name.trim()) return resp(400, { error: 'name is required' });

      // heated.js (V5-LOCHEATEDUI-001): a new row has only this body, so both rules are decided here with no
      // read: heated:true without covered:true in the same request is refused.
      const _herr = validateHeatedType(body);
      if (_herr) return resp(400, { error: _herr });
      const _coverErr = heatedCoverError(nextFlagsForPost(body));
      if (_coverErr) return resp(400, { error: _coverErr });

      // AUTHZ (BUG-AUTHZFKENUM-001): parent_id must be a location the caller owns. The household-scoped
      // SELECT below only reads the parent's `level`, so a foreign or absent parent would be stored VERBATIM
      // and `locations_with_path` (a recursive view with NO created_by filter) would return the victim's
      // ancestor names in the caller's own row's `full_path`. Generic 400, no existence oracle.
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
      // I41: keyed on the COMPUTED slug, not whether one was sent: a blank sent slug falls through to the
      // derived one, and a name with no A-Z letter or digit ('!!!', an emoji) derives ''.
      if (slug === '') return resp(400, { error: 'name needs at least one A–Z letter or digit, or send a slug' });

      const rows = await sql`
        INSERT INTO locations
          (name, slug, level, type_label, parent_id, sort_order, description, covered, created_by, heated)
        VALUES (
          ${body.name},
          ${slug},
          ${level},
          ${body.type_label ?? null},
          ${body.parent_id ?? null},
          ${body.sort_order ?? 0},
          ${body.description ?? null},
          -- V4-COVEREDNOTMODELLED-001. Defaults to NULL = "not stated", NOT to false. A new location
          -- is genuinely unclassified, and the reader resolves NULL through the type_label heuristic
          -- rather than asserting the bed is open to the sky. Writing false here would be a claim
          -- nobody made.
          ${body.covered ?? null},
          ${userId},
          -- V5-LOCHEATEDUI-001. Not sent means the column default, false; never NULL.
          ${body.heated ?? false}
        )
        RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    logCaughtError('locations lambda error', err);
    if (err.code === '23505') return resp(409, { error: 'Slug already exists', code: 'location_slug_conflict' });
    // This catch also maps 23503 and 23514 like every sibling handler (plants, projects, events) - parity
    // and defence-in-depth (BUG-COALESCECLEAR-001 audit finding; the POST's parent_id hole that made 23503
    // reachable is closed by BUG-AUTHZFKENUM-001). Nothing on the clear allowlist can reach either code
    // (`description` has no CHECK or FK; the table's CHECKs reference no PUT arm). The two codes stay spelled
    // out: lambda/locations/clear-fields.test.js pins them.
    if (err.code === '23503' || err.code === '23514') {
      const db = dbErrorReply(err, ['23503', '23514']);
      return resp(db.status, db.body);
    }
    return resp(500, { error: 'Internal server error' });
  }
};
