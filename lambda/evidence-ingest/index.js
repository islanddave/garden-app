// /api/evidence — DRG-ENGINE-003 evidence-ingest write path (slice 7). POST-only, Clerk-authed.
// ADDITIVE + DORMANT: shipped-but-unwired in V1 (no frontend route / Function-URL consumer yet).
// Validates the payload (validate.js) AND the entity_id against the live `entity` registry, then
// writes exactly ONE append-only evidence row. Rejects unknown entities (404) + schema mismatch (400).
// Append-only: the handler issues one INSERT and never UPDATE/DELETE (soft-delete is via the table's
// deleted_at, used by future admin/restore paths — Soft-Delete-Only Rule).
// HOUSEHOLD NOTE — DISCHARGED 2026-08-10 (BUG-AUTHZFKENUM-001). This used to read "add
// household-scoped write authz at wire time"; it is now here, because the handler shipped two
// body-settable FKs with no ownership check and — worse — was INVISIBLE to the static write-FK
// guard. lambda/authz-write-fk.test.js enumerated `body.<x>_id` in each dir's index.js; this
// handler never spells that token (validate.js destructures the body and the write reads
// `v.value.<x>`), so it contributed ZERO pairs and passed the ratchet while carrying both holes.
// That enumeration gap is fixed in the ratchet itself; the gates below are the live half.
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { validateEvidenceInput } from './validate.js';
import { householdScope, warnRejectedFk } from './household.js';
import { loadOwnedPlantingRef } from './authz-parents.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate.
function resp(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const secrets = await getSecrets();

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let userId;
  try {
    const payload = await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net'],
    });
    userId = payload.sub;
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }

  // householdScope('') returns [''] and `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty JWT
  // subject would be a live ownership value rather than a no-match. verifyToken rejects such a token
  // first; this is the second layer, and it must sit BEFORE householdScope (V4-AUTHZRESIDUE-001).
  if (!userId) return resp(401, { error: 'Unauthorized' });
  const householdIds = householdScope(userId);

  const method = event.requestContext?.http?.method ?? 'POST';
  const rawPath = event.rawPath ?? '/api/evidence';
  if (method !== 'POST' || rawPath !== '/api/evidence') return resp(405, { error: 'Method not allowed' });

  let body;
  try { body = event.body ? JSON.parse(event.body) : null; }
  catch { return resp(400, { error: 'Invalid JSON body' }); }

  const v = validateEvidenceInput(body);
  if (!v.ok) return resp(v.status, { error: v.error });

  const sql = neon(secrets.NEON_DATABASE_URL);
  try {
    // Registry validation (C-risk #4): the evidence MUST point at a live canonical entity.
    //
    // AUTHZ (BUG-AUTHZFKENUM-001): existence was ALL this proved. `entity` is a MIXED registry —
    // measured live 2026-08-10: 408 `cultivar` + 168 `critter_species` rows are shared vocabulary
    // owned by nobody (no created_by column exists on the table at all), while 271 `planting` rows
    // are household data reached through planting_ref_id -> plants(id). So the gate is conditional
    // by construction rather than blanket: the catalogue arms stay globally writable (gating them
    // would break the shared vocabulary, same carve-out as variety_id / crop_type_slug), and the
    // planting arm is scoped through the canonical planting predicate.
    //
    // The rejection reuses the SAME 404 as an absent entity, deliberately. The house pattern is a
    // generic 400, but here 400-vs-404 would itself be the existence oracle this contract forbids
    // (404 = "no such entity", 400 = "exists, not yours"). One response for both is strictly
    // stronger, and it preserves the shipped slice-7 contract.
    const ent = await sql`SELECT id, planting_ref_id FROM public.entity WHERE id = ${v.value.entity_id}::uuid AND deleted_at IS NULL`;
    if (ent.length === 0) return resp(404, { error: 'Unknown entity_id' });
    if (ent[0].planting_ref_id != null && !await loadOwnedPlantingRef(sql, ent[0].planting_ref_id, householdIds)) {
      warnRejectedFk(userId, 'evidence', 'entity_id', v.value.entity_id);
      return resp(404, { error: 'Unknown entity_id' });
    }

    // AUTHZ (BUG-AUTHZFKENUM-001): garden_node_id -> plants(id) was UUID-FORMAT-checked only
    // (validate.js), never ownership-checked, so any authenticated caller could anchor evidence to
    // another household's planting — and claim_scope='planting' makes garden_node_id REQUIRED, so
    // this is the handler's primary anchor, not an edge field. Generic 400, no existence oracle.
    if (v.value.garden_node_id != null && !await loadOwnedPlantingRef(sql, v.value.garden_node_id, householdIds)) {
      warnRejectedFk(userId, 'evidence', 'garden_node_id', v.value.garden_node_id);
      return resp(400, { error: 'garden_node_id does not match a planting you can use' });
    }

    // CARE-ENGINE-P0 dual-write (G-EVID): ONE append-only INSERT writes BOTH the legacy cols AND the
    // generalized V2 cols (derived in validate.js from the legacy tier). Still a single statement — the
    // append-only invariant (index.test.js: exactly one write, no UPDATE/DELETE) holds.
    const mp = v.value.model_provenance ? JSON.stringify(v.value.model_provenance) : null;
    const rows = await sql`
      INSERT INTO public.evidence
        (entity_id, schema_version, tier, axis, polarity, finding_type, observed_at, note, photo_ref, source, created_by,
         evidence_class, entity_type, claim, source_tier, trust_rank, strength_weight, claim_scope, evidence_kind,
         garden_node_id, captured_at, observed_until, provenance, model_provenance, retracted, source_record_id)
      VALUES
        (${v.value.entity_id}::uuid, ${v.value.schema_version}, ${v.value.tier}, ${v.value.axis}, ${v.value.polarity},
         ${v.value.finding_type}, ${v.value.observed_at}::timestamptz, ${v.value.note}, ${v.value.photo_ref}, ${v.value.source}, ${userId},
         ${v.value.evidence_class}, ${v.value.entity_type}, ${v.value.claim}, ${v.value.source_tier}, ${v.value.trust_rank}, ${v.value.strength_weight},
         ${v.value.claim_scope}, ${v.value.evidence_kind}, ${v.value.garden_node_id}::uuid, ${v.value.captured_at}::timestamptz,
         ${v.value.observed_until}::timestamptz, ${v.value.provenance}, ${mp}::jsonb, ${v.value.retracted}, ${v.value.source_record_id})
      RETURNING id, entity_id, schema_version, evidence_class, source_tier, trust_rank, created_at
    `;
    return resp(201, { evidence: rows[0] });
  } catch (err) {
    console.error('evidence-ingest lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
