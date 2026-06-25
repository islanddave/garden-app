// validate.js — V4-TAGSUB-001 pure validators + enums + slug + admin gate.
// No DB/network imports — unit-testable in isolation (crucible D-TEST). Mirrors lambda/varieties/validate.js shape.

export const VALID_VISIBILITY = ['shared', 'private'];
// User-creatable facets ONLY. type/lifecycle are derived (system), location is a projected FK facet —
// none are hand-typed (D-DERIVE-GUARD / model). The DB CHECK allows all five; the API is intentionally tighter.
export const VALID_USER_FACETS = ['group', 'freeform'];
export const VALID_ENTITY_TYPES = ['plant', 'cultivar', 'location', 'project'];

// lowercase, trim, collapse any run of non-alphanumerics to a single hyphen, strip leading/trailing
// hyphens, cap at 60 chars. "Peppers" / "peppers" / "  Peppers " all collapse to "peppers".
export function slugify(label) {
  return String(label ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function validateTagCreate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.label || typeof body.label !== 'string' || !body.label.trim()) return 'label is required';
  if (!body.facet || !VALID_USER_FACETS.includes(body.facet)) {
    return `facet must be one of: ${VALID_USER_FACETS.join(', ')} (type/lifecycle/location are not hand-assignable)`;
  }
  if (body.visibility != null && !VALID_VISIBILITY.includes(body.visibility)) {
    return `visibility must be one of: ${VALID_VISIBILITY.join(', ')}`;
  }
  if (!slugify(body.label)) return 'label must contain at least one alphanumeric character';
  return null;
}

export function validateTagPatch(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (body.label == null && body.visibility == null) return 'nothing to update (label or visibility required)';
  if (body.label != null && (typeof body.label !== 'string' || !slugify(body.label))) {
    return 'label must be a non-empty string with at least one alphanumeric character';
  }
  if (body.visibility != null && !VALID_VISIBILITY.includes(body.visibility)) {
    return `visibility must be one of: ${VALID_VISIBILITY.join(', ')}`;
  }
  return null;
}

export function validateEntityTagCreate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.tag_id || typeof body.tag_id !== 'string') return 'tag_id is required';
  if (!body.entity_type || !VALID_ENTITY_TYPES.includes(body.entity_type)) {
    return `entity_type must be one of: ${VALID_ENTITY_TYPES.join(', ')}`;
  }
  if (!body.entity_id || typeof body.entity_id !== 'string') return 'entity_id is required';
  return null;
}

// Fail-CLOSED admin gate (D-ADMIN). Unset/empty ADMIN_CLERK_SUBS -> nobody is admin -> 403 for all.
export function isAdmin(userId, env) {
  const subs = (env.ADMIN_CLERK_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return subs.length > 0 && subs.includes(userId);
}

// The (entity_type -> base table, id column) map for the existence/scope check on attach (D-ENTITY).
// entity_id has no FK (polymorphic), so the API confirms the target row is real before linking.
export const ENTITY_TABLE = {
  plant: 'garden_node',
  cultivar: 'plant_varieties',
  location: 'locations',
  project: 'plant_projects',
};
