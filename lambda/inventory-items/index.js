import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

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

const VALID_TYPES = ['consumable', 'durable'];
const VALID_CATEGORIES = ['seeds','growing_media','lighting','shelving','tools','pest_control','containers','climate_control','nutrients_and_amendments','other'];
const VALID_UNITS = ['each','packet','oz','fl oz','lb','gal','qt','bag','roll','sheet','other'];
const VALID_CONDITIONS = ['excellent','good','fair','poor'];
const VALID_STATUSES = ['active','depleted','retired','missing'];

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

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/inventory-items';

  const idMatch = rawPath.match(/^\/api\/inventory-items\/([^/]+)$/);

  try {
    if (idMatch) {
      const itemId = idMatch[1];

      if (method === 'GET') {
        const rows = await sql`
          SELECT * FROM inventory_items
          WHERE id = ${itemId}
            AND created_by = ${userId}
            AND deleted_at IS NULL
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');
        const verr = validateUpdate(body);
        if (verr) return resp(400, { error: verr });

        const isConsumable = body.type === 'consumable';
        const isDurable = body.type === 'durable';
        const tags = Array.isArray(body.tags) ? body.tags : [];

        // PUT replaces all editable fields. Frontend sends complete payload.
        // type-discrimination enforced by nullifying off-type fields server-side.
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
            featured_image_id = ${body.featured_image_id ?? null}
          WHERE id = ${itemId}
            AND created_by = ${userId}
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
            AND created_by = ${userId}
            AND deleted_at IS NULL
          RETURNING id
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      const rows = await sql`
        SELECT * FROM inventory_items
        WHERE created_by = ${userId}
          AND deleted_at IS NULL
        ORDER BY created_at DESC
      `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const verr = validateCreate(body);
      if (verr) return resp(400, { error: verr });

      const isConsumable = body.type === 'consumable';
      const isDurable = body.type === 'durable';
      const tags = Array.isArray(body.tags) ? body.tags : [];

      // INSERT writes BOTH user_id and created_by with the Clerk JWT.sub.
      // Both are NOT NULL TEXT in the deployed schema (twin-column reality —
      // legacy from Supabase migration, not yet collapsed). prevent_ownership_transfer
      // trigger enforces created_by immutability post-INSERT.
      const rows = await sql`
        INSERT INTO inventory_items (
          user_id, created_by, type, name, category,
          location_id, location_text, source, source_url, purchase_date,
          unit_cost, unit, quantity_purchased, notes, tags, status,
          quantity_on_hand, reorder_threshold, reorder_quantity,
          quantity, condition, brand, model,
          image_url, featured_image_id
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
          ${body.image_url ?? null}, ${body.featured_image_id ?? null}
        ) RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('inventory-items lambda error', err);
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    if (err.code === '23502') return resp(400, { error: `Required field missing: ${err.column ?? err.message}` });
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
