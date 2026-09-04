import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope, loadOwnedLocation, loadOwnedPhoto, warnRejectedFk } from './household.js';
import { resolvePhotoViewUrl } from './photo-access.js';
import { validateExtractRequest, buildAnthropicRequest, parseExtractResponse } from './extract.js';
// V4-SEEDORIGIN-001. A per-directory copy of the vocabulary canonically defined in
// lambda/preservation/provenance.js — each Lambda is zipped from its own directory, so a
// `../preservation/` import 502s the deployed handler (caught 2026-05-20).
//
// NARROW copy, not the byte-identical whole-file copy the household.js precedent would suggest:
// copying provenance.js whole put preservation_log's plant_id and harvest_log_id into this Lambda's
// FK surface, and lambda/authz-write-fk.test.js correctly failed on two body-settable FKs with no
// ownership decision. See source-kinds.js for why silencing that was the wrong fix.
// lambda/provenance-copies-sync.test.js guards the values, and also checks the migration's DB CHECK
// membership against them.
import { VALID_SOURCE_KINDS } from './source-kinds.js';

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

const CORS = {}; // Lambda URL config owns CORS — handler must not duplicate (matches lambda/plants pattern)

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

// V4-SEEDLINK-001. The /source-plant gate does its ownership check INLINE (see the route for why),
// so it needs the same malformed-id short-circuit every shared loader carries (V4-AUTHZRESIDUE-001):
// a non-uuid reaching Postgres raises 22P02, which falls through the catch as an opaque 500 — both a
// worse client contract and a weak side channel (500 = "not even a uuid", 400 = "valid, not yours").
// household.js keeps its own copy module-private and that file is held byte-identical across 19
// Lambda dirs by household-copies-sync.test.js, so widening its export surface for one consumer is
// not a local change. Same regex, declared where it is used.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TYPES = ['consumable', 'durable'];
const VALID_CATEGORIES = ['seeds','growing_media','lighting','shelving','tools','pest_control','containers','climate_control','nutrients_and_amendments','fertilizer','amendment','other'];
const VALID_UNITS = ['each','packet','oz','fl oz','lb','gal','qt','bag','roll','sheet','other'];
const VALID_CONDITIONS = ['excellent','good','fair','poor'];
const VALID_STATUSES = ['active','depleted','retired','missing'];

// How far ahead of server time a seed-lot stage entry may be dated. Not zero, and the reason is not
// leniency — see the /seed-stage route, where the tolerance is derived from the local-noon shape the
// client actually sends.
const FUTURE_ENTERED_AT_TOLERANCE_MS = 48 * 60 * 60 * 1000;

// BUG-INVMETADROP-001. Mirrors chk_inventory_metadata_size on inventory_items
// (metadata IS NULL OR octet_length(metadata::text) < 8192) and packetToInventoryPayload's
// METADATA_MAX_BYTES, so an oversized payload 400s with a field name instead of surfacing as
// the generic 23514 "Constraint violation" string the catch block emits.
export const METADATA_MAX_BYTES = 8192;

// BUG-INVUPDATESEEDGUARD-001 — human sentences for the seed CHECKs that a user can actually reach.
//
// The catch block's generic arm answers a 23514 with the constraint's own name, which is a fact
// about the schema and tells the person holding the phone nothing about what to do. These four are
// the seed-provenance constraints armed by v4-seedorigin-001, and every one of them is reachable
// from the Category <select> on /inventory/:id the moment a lot carries provenance — which is any
// lot created by "Save seed".
//
// Each sentence names the rule and the way out, and none of them names a column: `source_plant_id`
// is not a thing the user has ever seen, "the plant it was saved from" is.
//
// Exported so the test can check the KEYS against something other than this literal — every other
// assertion in put-seed-provenance-guard.test.js supplies the constraint name itself, so all of them
// would stay green against a table keyed on names that do not exist. That check reads the
// `ADD CONSTRAINT` statements in `migrations/`, NOT `pg_constraint`: unit tests open no database.
// The residual gap is therefore a constraint renamed in the live schema but not in the migration
// files, which would leave this map silently dead with the suite green. All four names were
// verified against live prod `pg_constraint` on 2026-09-02 (pre-promote pass MIN-2); re-verify there
// rather than trusting the unit test if this map ever stops firing.
export const SEED_CONSTRAINT_MESSAGES = {
  chk_inventory_source_plant_seeds_only:
    'This lot records the plant it was saved from, so it has to stay in Seeds. Clear "Saved from" first if you want to move it to another category.',
  chk_inventory_source_kind_seeds_only:
    'This lot records where the seed came from, so it has to stay in Seeds. Clear "Source" first if you want to move it to another category.',
  // MUTUAL EXCLUSION, not a both-required rule. The live expression is
  // `source_kind IS NULL OR source_kind = 'own_garden' OR source_plant_id IS NULL`, read from
  // migrations/v4-seedorigin-001/0a-additive-ddl.sql. Worth stating, because the pre-promote report
  // paraphrased this one as "requires source_kind non-NULL" and a message written from that summary
  // told the user to supply the very field they need to clear.
  chk_inventory_seed_source_plant:
    'This lot names the plant it was saved from, so it cannot also say it came from a shop, a gift or a farm stand. Clear one of the two.',
  chk_inventory_seed_requires_variety:
    'A seed lot has to name a variety. Pick one before saving.',
  // V4-SOURCEREG-001. NOT a seed constraint, and it sits in this map anyway because the catch block
  // that reads it is keyed on constraint name for the WHOLE handler, not on the seed routes — the
  // name of the const is the only thing here that says "seed".
  //
  // The body-only compare in the PUT/POST paths answers the case where one payload carries both
  // ids. It CANNOT answer the partial write — a body that sends only `source_id` colliding with the
  // row's stored `acquired_from_source_id` — because this handler's validators never read the stored
  // row. That case reaches the CHECK, and this is what it says when it gets there. Same two-mechanism
  // split, for the same reason, as chk_inventory_source_plant_seeds_only above.
  chk_inventory_source_distinct:
    'The originator and the place you got it from have to be two different sources. Clear one of them, or pick a different one.',
};

// A plain JSON object, not an array and not a scalar. jsonb would happily store `"abc"` or `[1]`,
// and every reader here (AddSeeds' provenance, packetToInventoryPayload) does key lookups — a
// scalar would be stored without error and then read as undefined at every call site.
export function validateMetadata(metadata) {
  if (metadata == null) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 'metadata must be a JSON object or null';
  }
  let serialized;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    return 'metadata must be JSON-serializable';
  }
  // Byte length, not string length: the CHECK counts octets, so a notes field full of accented
  // characters or emoji passes a .length test and still violates the constraint.
  if (Buffer.byteLength(serialized, 'utf8') >= METADATA_MAX_BYTES) {
    return `metadata must serialize to fewer than ${METADATA_MAX_BYTES} bytes`;
  }
  return null;
}

// V4-SOURCEREG-001 — the two `public.source` FKs, checked for LIVENESS and not for ownership.
//
// Deliberately not an ownership gate, and this is the one decision here worth stating: `source` is a
// shared catalogue with RLS off and no created_by-based scoping, the same shape as
// public.plant_varieties (the migration's own blast-radius note names that precedent). Household-
// gating it would break the picker every household reads, which is why the pair belongs with
// `inventory-items::variety_id` in authz-write-fk.test.js's shared-vocabulary group rather than in
// SITES. What IS checked is the strictness the varieties handler applies to variety_id: the row has
// to exist and not be soft-deleted, so a stale id from a picker whose list was fetched before a
// delete answers with a named field instead of landing a dangling-looking reference. The DB FK
// proves existence but is blind to deleted_at.
//
// UUID_RE first, mirroring the sourcePlantId gate in the POST path: a malformed id reaching Postgres
// raises 22P02, which nothing maps, so it falls through the catch as an opaque 500 rather than the
// 400 the V4-AUTHZRESIDUE-001 contract promises everywhere else.
//
// One statement per id rather than one `= ANY(...)`: the caller needs to know WHICH of the two is
// bad, and a set-returning query that comes back one row short cannot say. Both are optional and
// almost always absent, so the common case issues no query at all.
async function findDeadSourceRef(sql, refs) {
  for (const [field, id] of refs) {
    if (id == null) continue;
    if (!UUID_RE.test(String(id))) return field;
    const rows = await sql`
      SELECT 1 FROM public.source WHERE id = ${id} AND deleted_at IS NULL
    `;
    if (!rows.length) return field;
  }
  return null;
}

// The pair names two DIFFERENT places: source_id is who grew/bred/packed it, acquired_from_source_id
// is the shop where it changed hands, set only when it DIFFERS. NULL is "not recorded", never "same
// as the other one" — so equality is meaningless rather than merely redundant, and
// chk_inventory_source_distinct rejects it.
//
// Body-only, matching every other validator in this file: it fires when one payload carries both
// ids, and stays silent otherwise. The partial-write collision is answered by the constraint message
// map instead — see chk_inventory_source_distinct there for why both halves are needed.
function sourceRefsCollide(body) {
  return body.source_id != null && body.source_id === body.acquired_from_source_id;
}

const SOURCE_DISTINCT_ERROR =
  'source_id and acquired_from_source_id must name different sources';
const deadSourceRefError = (field) => `${field} does not match a source you can use`;

export function validateCreate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  if (!body.type || !VALID_TYPES.includes(body.type)) return 'type must be consumable or durable';
  if (!body.category || !VALID_CATEGORIES.includes(body.category)) return `category must be one of: ${VALID_CATEGORIES.join(', ')}`;
  if (body.type === 'consumable') {
    if (body.quantity_on_hand == null) return 'quantity_on_hand is required for consumable';
    if (!body.unit || !VALID_UNITS.includes(body.unit)) return `unit is required for consumable; must be one of: ${VALID_UNITS.join(', ')}`;
  }
  if (body.type === 'durable') {
    if (body.quantity == null) return 'quantity is required for durable';
  }
  if (body.condition != null && !VALID_CONDITIONS.includes(body.condition)) return `condition must be one of: ${VALID_CONDITIONS.join(', ')}`;
  if (body.status != null && !VALID_STATUSES.includes(body.status)) return `status must be one of: ${VALID_STATUSES.join(', ')}`;
  if (body.unit != null && !VALID_UNITS.includes(body.unit)) return `unit must be one of: ${VALID_UNITS.join(', ')}`;
  if (body.variety_id != null && body.category !== 'seeds') return 'variety_id is only allowed when category is seeds';
  if (body.category === 'seeds' && body.variety_id == null) return 'variety_id is required for seeds';
  // BUG-SEEDPOSTDROPSPARENT-001 — same shape, same reason as the variety_id line above. The
  // /source-plant route's UPDATE carries `category = 'seeds'` in its WHERE, so without this the
  // create path would be the one hole the edit path closes: a shovel could be born with a parent
  // plant that no route could ever have attached to it afterwards.
  if (body.source_plant_id != null && body.category !== 'seeds') return 'source_plant_id is only allowed when category is seeds';
  if (body.source_kind != null && body.category !== 'seeds') return 'source_kind is only allowed when category is seeds';
  const merr = validateMetadata(body.metadata);
  if (merr) return merr;
  return null;
}

export function validateUpdate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  // PUT is "replace editable fields" pattern — frontend sends complete payload.
  // Same field validation as create EXCEPT we accept body even without all required
  // fields (DB CHECK constraints catch any inconsistency). But if type/category/unit/etc.
  // are present, they must be valid.
  if (body.type != null && !VALID_TYPES.includes(body.type)) return 'type must be consumable or durable';
  if (body.category != null && !VALID_CATEGORIES.includes(body.category)) return `category must be one of: ${VALID_CATEGORIES.join(', ')}`;
  if (body.unit != null && !VALID_UNITS.includes(body.unit)) return `unit must be one of: ${VALID_UNITS.join(', ')}`;
  if (body.condition != null && !VALID_CONDITIONS.includes(body.condition)) return `condition must be one of: ${VALID_CONDITIONS.join(', ')}`;
  if (body.status != null && !VALID_STATUSES.includes(body.status)) return `status must be one of: ${VALID_STATUSES.join(', ')}`;
  if (body.variety_id != null && body.category != null && body.category !== 'seeds') return 'variety_id is only allowed when category is seeds';
  // BUG-INVSEEDPUT400-001. PRESENCE, not value — the same hasOwnProperty idiom the PUT's SET list
  // already uses for featured_photo_id / seed_process / seed_stage, and here for the same reason.
  // This ran on the RAW body with no merge against the stored row, so `category === 'seeds' &&
  // variety_id == null` was true of any payload that named the category and left the variety alone.
  // InventoryDetail's buildChanges() emits exactly that: it sends `category` and has never sent
  // `variety_id` (the form neither renders the variety nor can change it), so the handler rejected
  // the whole category='seeds' half of the table before a single statement ran.
  //
  // NOT DELETED, because the guard is real: chk_inventory_seed_requires_variety is
  // `category <> 'seeds' OR variety_id IS NOT NULL`, and a client that deliberately sends a null
  // variety for a seeds row deserves a named field back rather than a 23514 round trip. That is now
  // exactly when it fires. Promoting a non-seed row TO seeds without supplying a variety is still
  // caught, but by the CHECK rather than here — answering it in the handler would need a read of the
  // stored row, and this validator is deliberately body-only.
  if (body.category === 'seeds'
      && Object.prototype.hasOwnProperty.call(body, 'variety_id')
      && body.variety_id == null) {
    return 'variety_id is required for seeds';
  }
  // BUG-INVUPDATESEEDGUARD-001. validateCreate refuses both of these on a non-seeds category and
  // validateUpdate never gained the pair, so the PUT path had no answer for them at all. The wide
  // PUT assigns `category` unconditionally and Category is a user-editable <select>
  // (src/pages/InventoryDetail.jsx), while both wide-PUT body builders are DENYLISTS — so a
  // round-tripped edit carries source_plant_id / source_kind straight through. Changing a saved-seed
  // lot's category away from `seeds` therefore reached the database and came back as
  // `400 Constraint violation: chk_inventory_source_plant_seeds_only` (index.js:1024 maps 23514),
  // naming a constraint rather than a field.
  //
  // The row was never at risk — the write is REJECTED, not mangled — so this is legibility, not
  // integrity. It was unreachable when v4.94.0 shipped (live prod: 0 rows with either column) and
  // becomes reachable with the first lot Dave saves, which is why it is worth fixing before the
  // population exists rather than after.
  //
  // `body.category != null` is what makes these body-only, matching the variety_id line above: this
  // validator never reads the stored row, so a payload that omits `category` says nothing about
  // whether the lot is seeds and must not be second-guessed. Promoting a row TO a non-seeds category
  // while it still holds provenance is caught here; the reverse (a payload that names neither) still
  // falls to the CHECK, deliberately.
  if (body.source_plant_id != null && body.category != null && body.category !== 'seeds') {
    return 'source_plant_id is only allowed when category is seeds';
  }
  if (body.source_kind != null && body.category != null && body.category !== 'seeds') {
    return 'source_kind is only allowed when category is seeds';
  }
  return null;
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
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/inventory-items';

  try {
    // SEEDINV: literal sub-routes, checked BEFORE /api/inventory-items/:id so
    // 'sow-candidates' is not mis-parsed as an item id (mirrors the
    // lambda/varieties/index.js crop-types precedent).
    if (rawPath === '/api/inventory-items/sow-candidates') {
      if (method !== 'GET') return resp(405, { error: 'Method not allowed' });
      // Raw v_sow_candidates rows only — all date math happens client-side (sowEngine).
      const rows = await sql`
        SELECT * FROM v_sow_candidates
        WHERE created_by = ANY(${householdIds})
      `;
      return resp(200, { items: rows });
    }

    // SEEDINV: seed-packet extractor. Also checked BEFORE /api/inventory-items/:id so
    // 'extract-seeds' is not mis-parsed as an item id (crop-types precedent).
    if (rawPath === '/api/inventory-items/extract-seeds') {
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');
      const v = validateExtractRequest(body);
      if (!v.ok) return resp(v.status, { error: v.error });
      // ~4.5MB binary image => ~6M base64 chars; anything bigger risks the Lambda
      // payload/memory ceiling — reject before touching the upstream API.
      if (body.mode === 'image' && body.image_base64.length > 6_000_000) {
        return resp(413, { error: 'image_too_large' });
      }
      let apiKey = secrets.ANTHROPIC_API_KEY;
      if (!apiKey) {
        // Key may have been added to the secret bundle after this container warmed —
        // re-fetch ONCE bypassing the module cache before declaring not-configured.
        _secrets = null;
        const fresh = await getSecrets();
        apiKey = fresh.ANTHROPIC_API_KEY;
      }
      if (!apiKey) return resp(501, { error: 'extractor_not_configured' });

      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildAnthropicRequest(body)),
      });
      if (!upstream.ok) {
        console.error('extract-seeds upstream error', upstream.status);
        return resp(502, { error: 'extractor_upstream', status: upstream.status });
      }
      const data = await upstream.json();
      const modelText = (data.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const parsed = parseExtractResponse(modelText);
      if (!parsed.ok) return resp(422, { error: parsed.error });
      return resp(200, { packets: parsed.packets });
    }

    // V4-SOWARCHIVE-001: archive a seed packet out of the ACTIVE Sow Now buckets for a season.
    // Checked before idMatch, mirroring the lambda/plants /archive precedent — idMatch's
    // /([^/]+)$/ cannot match the /sow-archive suffix, but the ordering is kept explicit so a
    // future loosening of that regex can't silently swallow this route.
    const sowArchiveMatch = rawPath.match(/^\/api\/inventory-items\/([^/]+)\/sow-archive$/);
    if (sowArchiveMatch) {
      const itemId = sowArchiveMatch[1];
      if (method !== 'PATCH') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');
      const archived = body.archived !== false; // default true; {archived:false} un-archives

      // The SEASON comes from the client, because sowEngine derives its year from a LOCAL calendar
      // date (sowEngine.js, getUTCFullYear of localTodayISO). Stamping EXTRACT(YEAR FROM now())
      // here would write the NEXT year for an archive made late on 31 Dec Eastern, hiding the
      // packet for all of it. Falling back to the server year only when the client sends none.
      let season = null;
      if (archived) {
        season = Number.isInteger(body.season) ? body.season : new Date().getUTCFullYear();
        // Range-check rather than trust: this is the user's own data, but an out-of-range stamp
        // would archive a packet into a season that never arrives, i.e. hide it forever.
        if (season < 2000 || season > 2100) return resp(400, { error: 'invalid_season' });
      }

      // Household-scoped like every other read of this table. category='seeds' is asserted so this
      // route cannot stamp a non-seed inventory row with a Sow-Now-only field. deleted_at filter
      // retained: a deleted packet can't be (un)archived.
      // Both columns move together — chk_sow_archive_pair rejects a half-write at the DB.
      const rows = await sql`
        UPDATE public.inventory_items
           SET sow_archived_season = ${season},
               sow_archived_at = CASE WHEN ${archived} THEN NOW() ELSE NULL END,
               updated_at = NOW()
         WHERE id = ${itemId}
           AND created_by = ANY(${householdIds})
           AND deleted_at IS NULL
           AND category = 'seeds'
        RETURNING id, sow_archived_season, sow_archived_at
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      return resp(200, rows[0]);
    }

    // ── V4-SEEDSAVEFLOW-001 — seed-lot stage history ────────────────────────────────────────────
    // GET  returns the lot's stage entries, newest first.
    // POST advances the lot to a stage AND records the entry, in ONE statement.
    const seedStageMatch = rawPath.match(/^\/api\/inventory-items\/([^/]+)\/seed-stage$/);
    if (seedStageMatch) {
      const itemId = seedStageMatch[1];
      const STAGES = ['fermenting', 'drying', 'stored'];

      if (method === 'GET') {
        // Household-scoped through the PARENT rather than on the log row: seed_lot_stage_log carries
        // created_by but joining the parent is what stops one household reading another's history
        // via a guessed id, and it is the same predicate the write path enforces.
        const rows = await sql`
          SELECT l.id, l.stage, l.entered_at, l.note, l.created_by, l.created_at
            FROM public.seed_lot_stage_log l
            JOIN public.inventory_items i ON i.id = l.inventory_item_id
           WHERE l.inventory_item_id = ${itemId}
             AND i.created_by = ANY(${householdIds})
             AND i.deleted_at IS NULL
           ORDER BY l.entered_at DESC, l.created_at DESC
        `;
        return resp(200, rows);
      }

      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });

      const body = JSON.parse(event.body ?? '{}');
      if (!STAGES.includes(body.stage)) {
        return resp(400, { error: `stage must be one of ${STAGES.join(', ')}` });
      }
      // BACKDATABLE ON PURPOSE. The founding use case is retroactive — the 1884 tomato lot went
      // through its ferment and out to dry before any of this existed, and a stage history that can
      // only be written in the present tense cannot record what actually happened. Absent -> now().
      const enteredAt = body.entered_at ?? null;
      // BACKDATABLE, NOT FORWARD-DATABLE (WAVE-2 S3d). The column is seed_lot_stage_log.entered_at,
      // verified live — nothing on inventory_items — and it is the value /seeds/saved derives its
      // whole queue from: the card's elapsed() reads stage_entered_at, so a lot entered with a
      // mistyped year reads "0 days in drying" forever and quietly leaves the list of things that
      // need checking, on the one page whose entire job is to produce that list.
      //
      // THE TOLERANCE IS LOAD-BEARING, NOT SLOP. SavedSeeds sends `${when}T12:00:00` — a local date
      // pinned to noon with no zone, deliberately, so a date typed on a phone in Eastern does not
      // land on the previous UTC day. Node parses a zoneless ISO string in the runtime's zone (UTC
      // on Lambda), so a genuine "today" arrives AHEAD of server now for any user west of UTC — a
      // strict `> Date.now()` would refuse Dave's own entry every morning before 08:00 Eastern.
      // 48h clears the worst genuine lead (~26h, a UTC+14 midnight) and still refuses what this
      // exists to refuse, which is wrong by months or years and never by hours.
      if (enteredAt != null) {
        const t = Date.parse(enteredAt);
        // NaN is the malformed case, which today reaches Postgres, raises 22007 and falls through
        // the catch as an opaque 500. A named 400 is the better answer and it is free here.
        if (Number.isNaN(t)) return resp(400, { error: 'entered_at must be a valid date' });
        if (t > Date.now() + FUTURE_ENTERED_AT_TOLERANCE_MS) {
          return resp(400, { error: 'entered_at cannot be in the future' });
        }
      }
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

      // BUG-SEEDPROCFORCED-001 — the lot's PROCESS travels with the stage that opens it, because
      // the two facts are decided in the same breath and by the same evidence. /seeds/saved offered
      // exactly one way to start tracking a lot and it hard-coded `fermenting`, so a dry-cleaned lot
      // — Dave's founding melon case, and every bean, pea, lettuce and brassica — could only be
      // recorded by writing a permanent, false `fermenting` row into seed_lot_stage_log. The stage
      // is now chosen by the caller; this carries the matching process so the lot says WHY it
      // started where it did instead of leaving that to be inferred.
      //
      // Presence, not truthiness, for the reason the PUT arm documents at length: `null` is a
      // meaningful value (a process deliberately unrecorded), and an advance that simply does not
      // mention the key must leave a process already set alone. Vocabulary mirrors
      // inventory_items_seed_process_check, read from live prod: wet | dry, or NULL.
      const SEED_PROCESSES = ['wet', 'dry', 'fresh'];
      const hasSeedProcess = Object.prototype.hasOwnProperty.call(body, 'seed_process');
      if (hasSeedProcess && body.seed_process != null && !SEED_PROCESSES.includes(body.seed_process)) {
        return resp(400, { error: `seed_process must be one of ${SEED_PROCESSES.join(', ')}` });
      }

      // ONE STATEMENT, so the two writes cannot separate. A stage log entry without the matching
      // seed_stage on the lot would show history the list view contradicts; the reverse would move
      // the lot with no record of when or why. A CTE gives atomicity without reaching for the
      // driver's transaction API, and it inherits the guard for free: if the UPDATE matches nothing
      // — wrong household, deleted row, or a non-seed item — `upd` is empty, the INSERT selects from
      // it and writes nothing, and the route 404s having changed exactly zero rows.
      const rows = await sql`
        WITH upd AS (
          UPDATE public.inventory_items
             SET seed_stage = ${body.stage},
                 seed_process = CASE
                   WHEN ${hasSeedProcess} THEN ${body.seed_process ?? null}
                   ELSE seed_process
                 END,
                 updated_at = NOW()
           WHERE id = ${itemId}
             AND created_by = ANY(${householdIds})
             AND deleted_at IS NULL
             AND category = 'seeds'
          RETURNING id
        )
        INSERT INTO public.seed_lot_stage_log (inventory_item_id, stage, entered_at, note, created_by)
        SELECT upd.id, ${body.stage}, COALESCE(${enteredAt}::timestamptz, NOW()), ${note}, ${userId}
          FROM upd
        RETURNING id, inventory_item_id, stage, entered_at, note
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      return resp(201, rows[0]);
    }

    // ── V4-SEEDLINK-001 — seed-lot provenance: which PLANT did this lot come from? ───────────────
    // A DEDICATED SUB-ROUTE, NOT A COLUMN ON THE WIDE PUT, and that is structural rather than
    // stylistic. Every assignment in the PUT's SET list is unconditional (`= ${body.x ?? null}`) and
    // InventoryDetail's buildChanges() sends nothing seed-related, so a bare `source_plant_id =`
    // there would silently NULL the provenance on every unrelated inventory edit and return 200 —
    // the exact trap the seed_process/seed_stage CASE guards below document at length. Same shape as
    // /sow-archive above: narrow, single-concern, method-checked, seeds-only.
    const sourcePlantMatch = rawPath.match(/^\/api\/inventory-items\/([^/]+)\/source-plant$/);
    if (sourcePlantMatch) {
      const itemId = sourcePlantMatch[1];
      if (method !== 'PATCH') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');

      // PRESENCE, not truthiness — the hasOwnProperty idiom the PUT already uses for seed_stage.
      // `null` is a MEANINGFUL value here (a parent being cleared, or one Dave never knew), so a
      // `body.source_plant_id != null` test would make "not recorded" unreachable rather than
      // first-class. The 400 is for a body that never mentions the key at all.
      if (!Object.prototype.hasOwnProperty.call(body, 'source_plant_id')) {
        return resp(400, { error: 'source_plant_id is required (send null to clear)' });
      }
      const sourcePlantId = body.source_plant_id ?? null;

      // AUTHZ (BUG-AUTHZFKENUM-001 / V4-AUTHZSWEEP-001). The plant id comes from the client and the
      // DB FK proves only that the row EXISTS. Ungated, a caller could pin their own lot to another
      // household's planting — a cross-household FK write AND a read leak through every surface that
      // later joins the parent for its name. Generic 400 with no existence oracle, matching the
      // featured_image_id / location_id gates in the PUT arm.
      //
      // INLINE, against public.garden_node, rather than importing loadOwnedPlantingRef: this
      // directory has no authz-parents.js copy, and adding one would drag public.plants and
      // public.plant_projects into its L-081 Phase-4 relation set and push the joined-relation
      // ratchet (scripts/schema-audit-join-baseline.json, "may FALL, never RISE") past 48, failing
      // schema-audit.yml on push to dev. garden_node is already in this dir's touched set and
      // already contracted by garden-node-columns.test.js.
      //
      // The predicate is the OWN-created_by arm only, which is strictly NARROWER than the canonical
      // two-arm one in authz-parents.js — it can refuse a planting a household member created inside
      // a container owned elsewhere, it can never admit a foreign one. That is the safe direction to
      // differ in, and it is also why the loose `gn.created_by OR pp.created_by` dialect is not
      // reproduced here.
      //
      // NO archived_at / status predicate, deliberately. A seed saver works from a FINISHED plant by
      // definition — the founding case is a `harvested` melon — so filtering on liveness would
      // refuse the exact provenance this route exists to record.
      //
      // NOT parity with /api/plants?view=picker, and the difference is intentional rather than an
      // oversight: the picker agrees on status (it does not filter it) but DOES exclude archived
      // rows, so this route is deliberately the wider of the two. Archiving is how a finished
      // planting is put away, which makes an archived plant a MORE likely seed parent than a live
      // one, not a less likely one. The practical consequence is that the picker will not offer an
      // archived planting for a NEW attachment — reachable via the API, or via the control's
      // retainOutOfScopeValue once set — and if that gap ever bites, widen the picker rather than
      // narrowing this predicate. Deleted stays excluded on both.
      if (sourcePlantId != null) {
        const owned = UUID_RE.test(String(sourcePlantId))
          ? await sql`
              SELECT p.id
                FROM public.garden_node p
               WHERE p.id = ${sourcePlantId}
                 AND p.created_by = ANY(${householdIds})
                 AND p.deleted_at IS NULL
            `
          : [];
        if (!owned.length) {
          warnRejectedFk(userId, 'inventory_items', 'source_plant_id', sourcePlantId);
          return resp(400, { error: 'source_plant_id does not match a planting you can use' });
        }
      }

      // Same predicate set as /sow-archive: household-scoped, live rows only, and category='seeds'
      // asserted so this route cannot stamp a seed-only field onto a shovel. 404 on no match, so a
      // foreign or non-seed item answers exactly as a missing one does.
      const rows = await sql`
        UPDATE public.inventory_items
           SET source_plant_id = ${sourcePlantId},
               updated_at = NOW()
         WHERE id = ${itemId}
           AND created_by = ANY(${householdIds})
           AND deleted_at IS NULL
           AND category = 'seeds'
        RETURNING id, source_plant_id
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      return resp(200, rows[0]);
    }

    // ── V4-SEEDORIGIN-001 — the OTHER half of provenance: where did this lot come from when it did
    // NOT come from one of my plantings? Store-bought Reaper, gift packet, u-pick fruit.
    //
    // A DEDICATED SUB-ROUTE, for the same structural reason /source-plant is one and documented
    // there at length: every assignment in the wide PUT's SET list is unconditional, so a bare
    // `source_kind =` there would silently NULL the provenance on every unrelated inventory edit and
    // return 200.
    const sourceKindMatch = rawPath.match(/^\/api\/inventory-items\/([^/]+)\/source-kind$/);
    if (sourceKindMatch) {
      const itemId = sourceKindMatch[1];
      if (method !== 'PATCH') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');

      // PRESENCE, not truthiness — same idiom as /source-plant. `null` is MEANINGFUL here: it is
      // "not recorded", which is the honest state of all 260 existing seed rows and must stay
      // reachable rather than being a value you can never get back to.
      if (!Object.prototype.hasOwnProperty.call(body, 'source_kind')) {
        return resp(400, { error: 'source_kind is required (send null to clear)' });
      }
      const sourceKind = body.source_kind ?? null;

      if (sourceKind != null && !VALID_SOURCE_KINDS.includes(sourceKind)) {
        return resp(400, { error: `source_kind must be one of ${VALID_SOURCE_KINDS.join(', ')}` });
      }

      // THE MUTUAL-EXCLUSION RULE, ENFORCED IN JS AS WELL AS IN THE DB CHECK — and that duplication
      // is deliberate, not redundancy. chk_inventory_seed_source_plant would catch this too, but as
      // an opaque 23514 mapped to "Constraint violation: chk_…", which tells a user nothing about
      // what they did. provenance.js:92-95 makes exactly the same choice for preservation_log.
      // A lot cannot claim it came from a shop AND from one of my plants.
      if (sourceKind != null && sourceKind !== 'own_garden') {
        const [existing] = await sql`
          SELECT source_plant_id FROM public.inventory_items
           WHERE id = ${itemId} AND created_by = ANY(${householdIds}) AND deleted_at IS NULL
        `;
        // Absent row -> fall through to the UPDATE, which 404s. Do not answer differently here, or
        // this branch becomes an existence oracle the sibling route deliberately avoids.
        if (existing && existing.source_plant_id != null) {
          return resp(400, {
            error: 'source_kind must be own_garden while a source plant is set (clear the source plant first)',
          });
        }
      }

      // Same predicate set as /source-plant: household-scoped, live rows only, seeds only.
      const rows = await sql`
        UPDATE public.inventory_items
           SET source_kind = ${sourceKind},
               updated_at = NOW()
         WHERE id = ${itemId}
           AND created_by = ANY(${householdIds})
           AND deleted_at IS NULL
           AND category = 'seeds'
        RETURNING id, source_kind
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      return resp(200, rows[0]);
    }

    const idMatch = rawPath.match(/^\/api\/inventory-items\/([^/]+)$/);

    if (idMatch) {
      const itemId = idMatch[1];

      if (method === 'GET') {
        const rows = await sql`
          SELECT i.*,
                 COALESCE(fp.id, fb.id) AS effective_featured_photo_id,
                 (fp.id IS NOT NULL) AS featured_is_explicit,
                 COALESCE(fp.storage_path, fb.storage_path) AS featured_photo_storage_path,
                 pv.display_name AS variety_name
          FROM inventory_items i
          -- BUG-PHOTOHEROMOVE-001 / INV-HERO — the hero is DERIVED here, never trusted from the
          -- stored pointer. Same shape as fetchSpaceHero (lambda/photos/index.js:~314); read its
          -- long-form rationale before touching this. Two predicates: the photo must be ALIVE, and
          -- it must STILL be a member of this item's gallery.
          --
          -- The membership arm is the one that bites today. Reassign ships (PhotoLibrary's tag
          -- modal, full-replace PUT) and re-parents a photo without clearing the old parent's
          -- featured_photo_id. NOTHING IS DELETED, so no deleted_at filter can ever catch it —
          -- only re-checking membership can.
          --
          -- The predicate fp.inventory_item_id = i.id is exactly the linkage the set-featured WRITE validator
          -- already enforces (~:275 below). Read half and write half of ONE invariant: diverging
          -- them manufactures the silent-revert bug fetchSpaceHero documents (the user re-picks the
          -- photo, the write accepts, the read demotes it again). Change one, change both.
          --
          -- ALIASED to effective_featured_photo_id, NOT featured_photo_id, because the i.* wildcard above
          -- already emits the raw column: two same-named columns in one SELECT and the driver's
          -- last-one-wins is undefined behavior to depend on. The JS below does the override
          -- explicitly. featured_image_id is untouched here — it is the deprecated V1-era twin
          -- (0 rows populated) and is not a hero surface.
          LEFT JOIN photos fp
                 ON fp.id = i.featured_photo_id
                AND fp.deleted_at IS NULL
                AND fp.created_by = ANY(${householdIds})
                AND fp.inventory_item_id = i.id
          LEFT JOIN LATERAL (
                 SELECT ph.id, ph.storage_path
                   FROM photos ph
                  WHERE ph.inventory_item_id = i.id
                    AND ph.deleted_at IS NULL
                    AND ph.created_by = ANY(${householdIds})
                  ORDER BY ph.created_at DESC, ph.id DESC
                  LIMIT 1
               ) fb ON TRUE
          LEFT JOIN public.cultivar pv ON pv.id = i.variety_id
          WHERE i.id = ${itemId}
            AND i.created_by = ANY(${householdIds})
            AND i.deleted_at IS NULL
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        const row = rows[0];
        const featured_photo_view_url = await resolvePhotoViewUrl(row.featured_photo_storage_path, { presign: getFeaturedPhotoViewUrl, sm });
        // INV-HERO: `i.*` carried the RAW pointer; replace it with the derived effective hero so
        // the id and the url can never disagree (the incoherence DD3 names — a LEFT JOIN that nulls
        // the storage_path while the raw id stays non-null, which the client then feeds to PhotoImg
        // and to featuredInSet badge comparisons). Strip the join-only columns.
        const {
          featured_photo_storage_path: _ignore,
          effective_featured_photo_id: _effective,
          ...rest
        } = row;
        // ── V4-SEEDGERMRATE-001 (BD-057) — the packet's germination record ─────────────────────
        // Dave's Q2 answer was "combine them, keep the history", and this is the whole of what
        // that costs: each sowing from this packet is already its own planting row carrying
        // source_inventory_item_id, so the combined rate is a SUM over them and the history IS
        // those rows. No new table, no per-packet counters to keep in step with the plantings.
        //
        // Served from the PACKET's own endpoint rather than by filtering /api/plants, for two
        // reasons: the plants list has no source_inventory_item_id filter (adding one would widen
        // a payload V4-PICKERPAYLOAD-001 just spent a release narrowing), and the packet page
        // already fetches this item — so the summary arrives with it instead of costing a second
        // cold round trip on a page Dave opens to answer one question.
        //
        // Only rows that HAVE a sown count take part. A planting from this packet that Dave never
        // counted must not drag the rate toward zero — `seeds_sown IS NOT NULL` is the difference
        // between "70% of what I measured" and "70% if you assume the unmeasured ones all failed".
        // germinated COALESCEs to 0 only INSIDE a row that has a sown count, where a null means he
        // recorded the sowing and nothing came up yet.
        let germination = null;
        if (row.category === 'seeds') {
          const g = await sql`
            SELECT p.id, p.display_name AS name, p.sown_at, p.seeds_sown, p.seeds_germinated
              FROM public.garden_node p
             WHERE p.source_inventory_item_id = ${itemId}
               AND p.deleted_at IS NULL
               AND p.seeds_sown IS NOT NULL
             ORDER BY p.sown_at DESC NULLS LAST, p.id
          `;
          const sown = g.reduce((n, r) => n + Number(r.seeds_sown ?? 0), 0);
          const up = g.reduce((n, r) => n + Number(r.seeds_germinated ?? 0), 0);
          germination = {
            sowings: g,
            seeds_sown: sown,
            seeds_germinated: up,
            // null rather than 0 when nothing is measured yet: a packet with no counts has no rate,
            // and 0 would render as a total failure on every unused packet in the drawer.
            rate: sown > 0 ? Math.round((up / sown) * 1000) / 10 : null,
          };
        }
        return resp(200, { ...rest, featured_photo_id: row.effective_featured_photo_id, featured_photo_view_url, germination });
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');
        const verr = validateUpdate(body);
        if (verr) return resp(400, { error: verr });

        // V2-PHOTO-F1: strict validation for featured_photo_id (linkage = photos.inventory_item_id).
        const hasFeatured = Object.prototype.hasOwnProperty.call(body, 'featured_photo_id');
        // V4-SEEDSAVEFLOW-001 — presence, not truthiness. `seed_stage: null` is a MEANINGFUL value
        // (a lot deliberately cleared back to "no stage"), so the test has to be "did the client
        // mention this key" rather than "did it send something". hasOwnProperty answers that; a
        // `body.seed_stage != null` check would make clearing a stage impossible.
        const hasSeedProcess = Object.prototype.hasOwnProperty.call(body, 'seed_process');
        const hasSeedStage   = Object.prototype.hasOwnProperty.call(body, 'seed_stage');
        // BUG-INVSEEDPUT400-001 — the second half of that fix, and the half that would have been
        // easy to skip. Relaxing validateUpdate alone would have converted a wrong 400 into SILENT
        // DATA LOSS: `variety_id` was a bare assignment below, so the first edit from a caller that
        // does not round-trip it would have NULLed the cultivar link on a seeds row. The 400 was
        // masking that. Same guard, same reason as the two lines above.
        const hasVariety     = Object.prototype.hasOwnProperty.call(body, 'variety_id');
        // V4-SOURCEREG-001 — the same guard as the four above, and the one where it is least
        // optional. Nothing in the app writes these two columns yet, so EVERY screen that PUTs an
        // inventory item today omits both keys: a bare assignment would null the provenance of any
        // row on its next edit, from any form, with a 200. See the SET list below.
        const hasSourceId    = Object.prototype.hasOwnProperty.call(body, 'source_id');
        const hasAcqSource   = Object.prototype.hasOwnProperty.call(body, 'acquired_from_source_id');
        // BUG-SEEDYEARNOOP-001 — the guard that makes V5-SEEDYEARHARVESTED-001 actually write.
        // SavedSeeds.jsx:393-398 has been putting `year_harvested` in this PUT's body since that
        // item shipped, and the SET list below never named the column: the key was discarded and
        // the route answered 200, so the user set a harvest year, saw success, and stored nothing.
        // Presence, not truthiness — an explicit null is a MEANINGFUL clear (a year entered by
        // mistake being taken back out), so a not-null test would make clearing impossible.
        const hasYearHarvested = Object.prototype.hasOwnProperty.call(body, 'year_harvested');
        // Vocabulary is enforced by a DB CHECK, but a 400 here is a better answer than a 500 from a
        // constraint violation — and it names the legal values, which the constraint error does not.
        const SEED_PROCESSES = ['wet', 'dry', 'fresh'];
        const SEED_STAGES    = ['fermenting', 'drying', 'stored'];
        if (hasSeedProcess && body.seed_process != null && !SEED_PROCESSES.includes(body.seed_process)) {
          return resp(400, { error: `seed_process must be one of ${SEED_PROCESSES.join(', ')}` });
        }
        if (hasSeedStage && body.seed_stage != null && !SEED_STAGES.includes(body.seed_stage)) {
          return resp(400, { error: `seed_stage must be one of ${SEED_STAGES.join(', ')}` });
        }
        if (hasFeatured && body.featured_photo_id != null) {
          const linkRows = await sql`
            SELECT 1 FROM photos
             WHERE id = ${body.featured_photo_id}
               AND inventory_item_id = ${itemId}
               AND created_by = ANY(${householdIds})
               AND deleted_at IS NULL
          `;
          if (!linkRows.length) {
            return resp(400, { error: 'featured_photo_id must be a photo linked to this inventory item' });
          }
        }

        // AUTHZ (BUG-AUTHZFKENUM-001): featured_image_id -> photos(id) is the UNGATED TWIN of
        // featured_photo_id three lines above. Both are body-settable photo references on the same
        // row; only one was checked. featured_image_id has no per-item linkage requirement (it is
        // not constrained to photos.inventory_item_id = this item), so ownership is the whole of the
        // check — hence the shared loadOwnedPhoto rather than a second inline linkage query.
        // Measured on live prod: zero rows would lose a write.
        if (body.featured_image_id != null) {
          if (!await loadOwnedPhoto(sql, body.featured_image_id, householdIds)) {
            warnRejectedFk(userId, 'inventory_items', 'featured_image_id', body.featured_image_id);
            return resp(400, { error: 'featured_image_id does not match a photo you can use' });
          }
        }

        // AUTHZ (V4-AUTHZSWEEP-001): location_id is a cross-entity FK set straight from the body.
        // The DB FK proves existence, not ownership — gate it before the write. Generic 400, no
        // existence oracle. NOTE the PUT below assigns location_id unconditionally (not COALESCE),
        // so a null clears it; only a non-null value needs validating.
        if (body.location_id != null) {
          if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
            warnRejectedFk(userId, 'inventory_items', 'location_id', body.location_id);
            return resp(400, { error: 'location_id does not match a location you can use' });
          }
        }

        // V4-SOURCEREG-001. Distinctness first: it needs no round trip, and rejecting a payload that
        // names one place twice before looking either up is one fewer query on the failing path.
        if (sourceRefsCollide(body)) return resp(400, { error: SOURCE_DISTINCT_ERROR });
        const deadRef = await findDeadSourceRef(sql, [
          ['source_id', body.source_id ?? null],
          ['acquired_from_source_id', body.acquired_from_source_id ?? null],
        ]);
        if (deadRef) return resp(400, { error: deadSourceRefError(deadRef) });

        const isConsumable = body.type === 'consumable';
        const isDurable = body.type === 'durable';
        const tags = Array.isArray(body.tags) ? body.tags : [];

        // PUT replaces all editable fields. Frontend sends complete payload.
        // type-discrimination enforced by nullifying off-type fields server-side.
        //
        // `metadata` IS DELIBERATELY ABSENT FROM THIS SET LIST — do not "finish the job" by adding
        // it the way BUG-INVMETADROP-001 added it to the INSERT. The two verbs are not symmetric.
        // Every assignment below is unconditional (`= ${body.x ?? null}`, no COALESCE), so a field
        // the client omits is NULLED, not preserved. Adding `metadata = ${body.metadata ?? null}`
        // would therefore erase provenance on every edit made through a form that does not round-
        // trip it — and the richest metadata in the table belongs to the bulk-loaded seed rows,
        // which no UI renders and so no UI would send back. Omission is what protects them.
        // If metadata ever needs to be editable here, it needs the explicit-presence guard used by
        // featured_photo_id above (hasOwnProperty -> CASE WHEN ... ELSE metadata END), never a bare
        // assignment.
        // HOUSEHOLD-MODE TODO: concurrent quantity edits have a lost-update window — PUT writes an
        // absolute quantity (client read-modify-write; no optimistic updated_at/expected guard).
        // Backend-safe today; revisit as a fast-follow if both members adjust counts concurrently.
        const rows = await sql`
          UPDATE inventory_items SET
            name              = ${body.name ?? null},
            type              = ${body.type ?? null},
            category          = ${body.category ?? null},
            location_id       = ${body.location_id ?? null},
            location_text     = ${body.location_text ?? null},
            source            = ${body.source ?? null},
            source_url        = ${body.source_url ?? null},
            purchase_date     = ${body.purchase_date ?? null},
            unit_cost         = ${body.unit_cost ?? null},
            unit              = ${isConsumable ? (body.unit ?? null) : null},
            quantity_purchased= ${body.quantity_purchased ?? null},
            notes             = ${body.notes ?? null},
            tags              = ${tags},
            status            = ${body.status ?? 'active'},
            quantity_on_hand  = ${isConsumable ? (body.quantity_on_hand ?? null) : null},
            reorder_threshold = ${isConsumable ? (body.reorder_threshold ?? null) : null},
            reorder_quantity  = ${isConsumable ? (body.reorder_quantity ?? null) : null},
            quantity          = ${isDurable ? (body.quantity ?? null) : null},
            condition         = ${isDurable ? (body.condition ?? null) : null},
            brand             = ${body.brand ?? null},
            model             = ${body.model ?? null},
            image_url         = ${body.image_url ?? null},
            featured_image_id = ${body.featured_image_id ?? null},
            featured_photo_id = CASE
              WHEN ${hasFeatured} THEN ${body.featured_photo_id ?? null}
              ELSE featured_photo_id
            END,
            -- BUG-INVSEEDPUT400-001. Moved out of the bare-assignment block above for the reason
            -- that block's own note gives: those are safe ONLY because the edit form renders and
            -- returns every one of them, and it does not render the variety. A seeds row whose
            -- variety_id is nulled also violates chk_inventory_seed_requires_variety, so the loss
            -- would surface as a constraint 400 on an unrelated edit rather than as a bad value.
            variety_id = CASE
              WHEN ${hasVariety} THEN ${body.variety_id ?? null}
              ELSE variety_id
            END,
            -- V4-SEEDSAVEFLOW-001. EXPLICIT-PRESENCE GUARDS, NOT BARE ASSIGNMENTS, and this is the
            -- difference between working and destroying data. Every other column above is a bare
            -- assignment, which is safe only because the edit form renders and returns all of them
            -- (see the note at the top of this block). It does NOT render these two:
            -- InventoryDetail's buildChanges() sends name/category/status/notes/source/source_url/
            -- purchase_date/unit_cost/location_text/quantity_purchased plus the consumable-or-durable
            -- set, and nothing seed-related. A bare assignment here would therefore NULL the seed
            -- stage every time Dave edited an inventory item for any unrelated reason — silently,
            -- with a 200, losing the process history the whole feature exists to hold.
            seed_process = CASE
              WHEN ${hasSeedProcess} THEN ${body.seed_process ?? null}
              ELSE seed_process
            END,
            seed_stage = CASE
              WHEN ${hasSeedStage} THEN ${body.seed_stage ?? null}
              ELSE seed_stage
            END,
            -- V4-SOURCEREG-001. EXPLICIT-PRESENCE GUARDS for the same reason as the two above, and
            -- with a wider blast radius than any of them. The four columns already guarded here are
            -- each invisible to ONE form; these two are invisible to EVERY form — nothing in src/
            -- sends either key today — so a bare assignment would not merely risk losing provenance,
            -- it would null both columns on the first edit of every row that has them, from any
            -- screen, and answer 200. The sentinel is what makes the columns writable by a future
            -- picker without making them erasable by every caller that predates it.
            --
            -- Presence, not truthiness: an explicit null source_id is a MEANINGFUL value (a source
            -- cleared back to unrecorded), so a not-null test would make clearing impossible.
            source_id = CASE
              WHEN ${hasSourceId} THEN ${body.source_id ?? null}
              ELSE source_id
            END,
            acquired_from_source_id = CASE
              WHEN ${hasAcqSource} THEN ${body.acquired_from_source_id ?? null}
              ELSE acquired_from_source_id
            END,
            -- BUG-SEEDYEARNOOP-001. The presence guard is not a stylistic choice here, it is the
            -- difference between fixing a no-op and destroying four irreplaceable values.
            --
            -- Only 4 of 510 rows carry a year_harvested, and they are the ones that cannot be
            -- reconstructed: Hopi Black Dye Sunflower 2025 (whose year exists structurally in THIS
            -- COLUMN ONLY — its metadata carries no year key at all, the rest is prose), Jen's
            -- Edelweiss 1986 from Austria, Red Mustard 2026, Common Milkweed 2022.
            --
            -- A BARE assignment here would read as working, because
            -- useInventory.js:121-122 merges the cached list row into the body and that row came
            -- from SELECT i.*, so on normal navigation the value round-trips. It is the DEEP-LINK
            -- path — list never loaded, body is buildChanges() alone, which does not send this key —
            -- that nulls all four, silently, with a 200. Same latent shape InventoryDetail.jsx:164
            -- documents for the type column: masked by the merge, bites only when the list has
            -- not loaded.
            year_harvested = CASE
              WHEN ${hasYearHarvested} THEN ${body.year_harvested ?? null}
              ELSE year_harvested
            END
            -- lot_number is DELIBERATELY ABSENT and must stay absent: NULL on all 510 rows with no
            -- reader, writer, migration, index, constraint, view or RLS reference. Parked, not
            -- forgotten — it needs a lot-numbering scheme that does not exist. See the guard in
            -- put-year-harvested.test.js, which pins this omission the way metadata-write.test.js
            -- pins the metadata omission.
          WHERE id = ${itemId}
            AND created_by = ANY(${householdIds})
            AND deleted_at IS NULL
          RETURNING *
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        const rows = await sql`
          UPDATE inventory_items
          SET deleted_at = NOW()
          WHERE id = ${itemId}
            AND created_by = ANY(${householdIds})
            AND deleted_at IS NULL
          RETURNING id
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      // V4-TREATLOG-001: optional ?category=a,b,c filter (comma-list). Absent → all items.
      const catParam = event.queryStringParameters?.category;
      const cats = catParam ? catParam.split(',').map(c => c.trim()).filter(Boolean) : null;
      // BUG-SEEDELAPSEDUPDATED-001 — `stage_entered_at`, and why it is not `updated_at`.
      //
      // /seeds/saved leads every card with elapsed time ("4 days in drying") because that is the
      // number that decides whether to go and check the jar. It read `inventory_items.updated_at`,
      // and `set_updated_at` is a BEFORE UPDATE ROW trigger that fires on EVERY write to the row —
      // so attaching a parent plant, or any later edit, reset a lot to "today" with no stage change
      // at all. That column measures "last touched", which is a different question.
      //
      // The honest source is when the lot ENTERED its current stage, and seed_lot_stage_log already
      // records it exactly (the /seed-stage CTE writes the log entry and the seed_stage in one
      // statement, so they cannot drift). LATERAL rather than a second round trip from the client:
      // the page fetches this list once and the index idx_seed_lot_stage_log_item
      // (inventory_item_id, entered_at DESC) is built for this probe.
      //
      // NULLABLE ON PURPOSE — do NOT COALESCE it to updated_at. A lot whose stage was set some other
      // way has no entry, and a fallback would silently restore the bug it is here to fix while
      // looking correct. The client renders the stage without a duration instead.
      //
      // seed_lot_stage_log is already in this directory's L-081 Phase-4 relation set (the /seed-stage
      // GET and POST both name it) and every column read here is already contracted in
      // seed-stage-columns.test.js, so this adds no relation and needs no contract edit.
      //
      // V5-SEEDSAVEDFILTER-001 — `crop_type_slug` is projected as `crop_slug` so the Saved Seeds
      // packet picker can filter by crop. It is the ONLY fully-populated axis on that page
      // (263/263 on prod) and the only one a gardener names the thing by; every other candidate was
      // measured and rejected. Aliased rather than passed through bare because `i.*` already floods
      // this row shape and a name that says which side it came from is worth the four characters.
      //
      // `cultivar` is ALREADY joined immediately below, so this adds no relation and does not trip
      // the L-081 join ratchet — but it DOES add a column to a contracted table, so
      // AUDIT_COLUMNS.cultivar in cultivar-columns.test.js moves in this same commit or CI reds in
      // both directions. Verified on live prod before writing this: `crop_type_slug` IS projected by
      // the `cultivar` VIEW, not merely present on the `plant_varieties` base table — the distinction
      // that made unit_weights/weight_confidence a runtime 500 (BUG-SEEDDETAIL500-001) with nothing
      // failing at deploy time.
      const rows = cats && cats.length
        ? await sql`
            SELECT i.*, pv.display_name AS variety_name, pv.crop_type_slug AS crop_slug,
                   se.entered_at AS stage_entered_at
            FROM inventory_items i
            LEFT JOIN public.cultivar pv ON pv.id = i.variety_id
            LEFT JOIN LATERAL (
                   SELECT sl.entered_at
                     FROM public.seed_lot_stage_log sl
                    WHERE i.seed_stage IS NOT NULL
                      AND sl.inventory_item_id = i.id
                      AND sl.stage = i.seed_stage
                    ORDER BY sl.entered_at DESC, sl.created_at DESC
                    LIMIT 1
                 ) se ON TRUE
            WHERE i.created_by = ANY(${householdIds})
              AND i.deleted_at IS NULL
              AND i.category = ANY(${cats})
            ORDER BY i.created_at DESC
          `
        : await sql`
            SELECT i.*, pv.display_name AS variety_name, pv.crop_type_slug AS crop_slug,
                   se.entered_at AS stage_entered_at
            FROM inventory_items i
            LEFT JOIN public.cultivar pv ON pv.id = i.variety_id
            LEFT JOIN LATERAL (
                   SELECT sl.entered_at
                     FROM public.seed_lot_stage_log sl
                    WHERE i.seed_stage IS NOT NULL
                      AND sl.inventory_item_id = i.id
                      AND sl.stage = i.seed_stage
                    ORDER BY sl.entered_at DESC, sl.created_at DESC
                    LIMIT 1
                 ) se ON TRUE
            WHERE i.created_by = ANY(${householdIds})
              AND i.deleted_at IS NULL
            ORDER BY i.created_at DESC
          `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const verr = validateCreate(body);
      if (verr) return resp(400, { error: verr });

      // AUTHZ (BUG-AUTHZFKENUM-001): create half of the featured_image_id gate — see the PUT arm.
      if (body.featured_image_id != null) {
        if (!await loadOwnedPhoto(sql, body.featured_image_id, householdIds)) {
          warnRejectedFk(userId, 'inventory_items', 'featured_image_id', body.featured_image_id);
          return resp(400, { error: 'featured_image_id does not match a photo you can use' });
        }
      }

      // AUTHZ (V4-AUTHZSWEEP-001): same gate as the PUT path — the create path must not be the
      // hole the edit path closes.
      if (body.location_id != null) {
        if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
          warnRejectedFk(userId, 'inventory_items', 'location_id', body.location_id);
          return resp(400, { error: 'location_id does not match a location you can use' });
        }
      }

      // BUG-SEEDPOSTDROPSPARENT-001 — source_plant_id was named in NEITHER the INSERT column list
      // NOR its VALUES, so a client that sent one got 201 Created with the field dropped and
      // `RETURNING *` echoing null. That is strictly worse than a 400: a rejection tells the caller
      // to retry, a 201 tells it the write landed. Identical failure to BUG-INVMETADROP-001 below,
      // on the "save seed from this plant" path.
      //
      // The gate is the /source-plant route's, MIRRORED rather than re-derived — same garden_node
      // predicate, same OWN-created_by arm, same UUID_RE short-circuit, same generic 400 with no
      // existence oracle, same warnRejectedFk. Search `sourcePlantMatch` for why it is inline
      // against the view instead of importing a loader (the L-081 join ratchet), why there is no
      // liveness filter, and why the narrow ownership arm is the safe direction to differ in. Both
      // copies must move together; sow-routes.test.js executes each one separately.
      //
      // ABSENCE IS NULL HERE, not the 400 the PATCH gives it. That route exists only to set this
      // column, so a body that never mentions the key is malformed; POST creates every category of
      // inventory and almost no row has a parent plant to name. Absent and explicit-null are the
      // same write on a create — there is no prior value to distinguish them.
      const sourcePlantId = body.source_plant_id ?? null;
      if (sourcePlantId != null) {
        const owned = UUID_RE.test(String(sourcePlantId))
          ? await sql`
              SELECT p.id
                FROM public.garden_node p
               WHERE p.id = ${sourcePlantId}
                 AND p.created_by = ANY(${householdIds})
                 AND p.deleted_at IS NULL
            `
          : [];
        if (!owned.length) {
          warnRejectedFk(userId, 'inventory_items', 'source_plant_id', sourcePlantId);
          return resp(400, { error: 'source_plant_id does not match a planting you can use' });
        }
      }

      // V4-SEEDORIGIN-001, same shape and same reasoning as the parent above: NAMED in the INSERT
      // rather than left to default, because Postgres does not complain about a key the INSERT never
      // mentions and the write would return 201 having silently dropped it. That is the defect this
      // handler already carries a comment about for `metadata`, and the one source_plant_id shipped
      // with until this morning.
      //
      // The mutual-exclusion rule needs no stored-row read here the way the PATCH does: on a create
      // both values arrive in this one body, so they can simply be compared.
      const sourceKind = body.source_kind ?? null;
      if (sourceKind != null && !VALID_SOURCE_KINDS.includes(sourceKind)) {
        return resp(400, { error: `source_kind must be one of ${VALID_SOURCE_KINDS.join(', ')}` });
      }
      if (sourceKind != null && sourceKind !== 'own_garden' && sourcePlantId != null) {
        return resp(400, { error: 'source_kind must be own_garden when a source plant is set' });
      }

      // V4-SOURCEREG-001 — same two checks as the PUT arm, in the same order, so the two verbs
      // cannot answer the same bad payload differently. No presence sentinel is needed here: on a
      // create there is no prior value for an absent key to preserve, so absent and explicit-null are
      // the same write (the reasoning the source_plant_id note above records for this verb).
      if (sourceRefsCollide(body)) return resp(400, { error: SOURCE_DISTINCT_ERROR });
      const deadRef = await findDeadSourceRef(sql, [
        ['source_id', body.source_id ?? null],
        ['acquired_from_source_id', body.acquired_from_source_id ?? null],
      ]);
      if (deadRef) return resp(400, { error: deadSourceRefError(deadRef) });

      const isConsumable = body.type === 'consumable';
      const isDurable = body.type === 'durable';
      const tags = Array.isArray(body.tags) ? body.tags : [];

      // INSERT writes BOTH user_id and created_by with the Clerk JWT.sub.
      // Both are NOT NULL TEXT in the deployed schema (twin-column reality —
      // legacy from the original DB migration, not yet collapsed). prevent_ownership_transfer
      // trigger enforces created_by immutability post-INSERT.
      //
      // BUG-INVMETADROP-001: `metadata` was absent from this column list while every caller was
      // already sending it — AddSeeds' buildRowPayload composes {sku, vendor, origin} for every
      // seed row and packetToInventoryPayload builds the same shape for the loader. Postgres does
      // not complain about a key the INSERT never mentions, so the write returned 201 and the
      // provenance vanished. It looked like it worked, which is why it survived: the existing seed
      // rows that DO carry metadata were bulk-loaded outside this route.
      // Stringify + explicit ::jsonb cast is the house pattern (lambda/events/index.js:485) — an
      // uncast bound object cannot be typed by the driver, and a bare null needs the cast too.
      const metadataJson = body.metadata != null ? JSON.stringify(body.metadata) : null;
      // V4-SEEDSAVEFLOW-001 — seed_process / seed_stage are NAMED in the INSERT below rather than
      // left to default, for exactly the reason the metadata note above records: Postgres does not
      // complain about a key the INSERT never mentions, so an omitted column returns 201 and
      // silently drops what the client sent. Both are nullable, so a non-seed item writes NULL.
      //
      // THIS COMMENT LIVES OUT HERE, NOT INSIDE THE COLUMN LIST, AND THAT IS NOT STYLE. The L-081
      // auditor's Phase 2 parses the parenthesised column list literally and does NOT strip `--`
      // comments inside it, so every English word of a comment placed there is read as a column
      // name and reported missing from prod. Writing it inside produced 53 bogus misses ("the",
      // "Postgres", "rather") on one run of scripts/dev-main-schema-audit.py.
      // V4-SOURCEREG-001 — source_id / acquired_from_source_id are NAMED below for the third time
      // in this handler's history for the same reason: an omitted column is not an error, so a
      // create that dropped them would return 201 with the provenance gone. The two free-text
      // `source` / `source_url` columns beside them stay exactly as they are — this pair is the
      // structured registry reference, not a replacement for the string a caller already sends.
      const rows = await sql`
        INSERT INTO inventory_items (
          user_id, created_by, type, name, category,
          location_id, location_text, source, source_url, purchase_date,
          unit_cost, unit, quantity_purchased, notes, tags, status,
          quantity_on_hand, reorder_threshold, reorder_quantity,
          quantity, condition, brand, model,
          image_url, featured_image_id, variety_id, metadata,
          seed_process, seed_stage, source_plant_id, source_kind,
          source_id, acquired_from_source_id
        ) VALUES (
          ${userId}, ${userId}, ${body.type}, ${body.name.trim()}, ${body.category},
          ${body.location_id ?? null}, ${body.location_text ?? null}, ${body.source ?? null}, ${body.source_url ?? null}, ${body.purchase_date ?? null},
          ${body.unit_cost ?? null},
          ${isConsumable ? body.unit : null},
          ${body.quantity_purchased ?? null}, ${body.notes ?? null}, ${tags}, ${body.status ?? 'active'},
          ${isConsumable ? body.quantity_on_hand : null},
          ${isConsumable ? (body.reorder_threshold ?? null) : null},
          ${isConsumable ? (body.reorder_quantity ?? null) : null},
          ${isDurable ? body.quantity : null},
          ${isDurable ? (body.condition ?? null) : null},
          ${body.brand ?? null}, ${body.model ?? null},
          ${body.image_url ?? null}, ${body.featured_image_id ?? null}, ${body.variety_id ?? null},
          ${metadataJson}::jsonb,
          ${body.seed_process ?? null}, ${body.seed_stage ?? null}, ${sourcePlantId}, ${sourceKind},
          ${body.source_id ?? null}, ${body.acquired_from_source_id ?? null}
        ) RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('inventory-items lambda error', err);
    if (err.code === '23514') {
      // BUG-INVUPDATESEEDGUARD-001 — the COMPLETE half of that fix. validateUpdate's new seeds-only
      // guards catch this before the query, but only when the body happens to carry the provenance
      // column: that validator is body-only by design, and the PUT body is whatever the client
      // round-tripped. On a deep link the list has not loaded, updateItem's {...listRow, ...changes}
      // merge contributes nothing, and the body is the edit form's projection alone — which names
      // `category` and not `source_plant_id`. The guard cannot fire on that path and the constraint
      // does, so the two together are what actually close it.
      //
      // Keyed on the CONSTRAINT NAME, which is the only thing postgres gives us that identifies the
      // rule rather than the row. The generic arm below is unchanged for every other constraint.
      return resp(400, { error: SEED_CONSTRAINT_MESSAGES[err.constraint] ?? `Constraint violation: ${err.constraint ?? err.message}` });
    }
    if (err.code === '23502') return resp(400, { error: `Required field missing: ${err.column ?? err.message}` });
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
