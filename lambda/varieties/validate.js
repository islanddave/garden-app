// lambda/varieties/validate.js — pure request-body validators for the varieties Lambda.
// Extracted from index.js so they can be unit-tested without importing the handler's
// runtime deps (@neondatabase/serverless etc.). Bundled with index.js (whole-dir zip),
// so the relative import resolves at runtime. No side effects, no I/O.

export const VALID_SUN = ['full_sun', 'part_sun', 'part_shade', 'full_shade'];
// PLANTTYPE: mirrors the chk_plant_varieties_lifecycle CHECK + crop_types.default_lifecycle CHECK.
export const VALID_LIFECYCLE = ['annual', 'tender_perennial', 'perennial', 'biennial'];

export function validateBody(body, { requireName = true } = {}) {
  if (!body || typeof body !== 'object') return 'body required';
  if (requireName && (!body.name || typeof body.name !== 'string' || !body.name.trim())) return 'name is required';
  if (body.sun_requirements != null && !VALID_SUN.includes(body.sun_requirements)) {
    return `sun_requirements must be one of: ${VALID_SUN.join(', ')}`;
  }
  if (body.source_url != null && body.source_url !== '' && !/^https:\/\//.test(body.source_url)) {
    return 'source_url must use https://';
  }
  if (body.days_to_maturity_min != null && body.days_to_maturity_max != null) {
    const min = Number(body.days_to_maturity_min);
    const max = Number(body.days_to_maturity_max);
    if (!Number.isNaN(min) && !Number.isNaN(max) && min > max) {
      return 'days_to_maturity_min must be <= days_to_maturity_max';
    }
  }
  if (body.common_diseases != null && !Array.isArray(body.common_diseases)) {
    return 'common_diseases must be an array of strings';
  }
  // PLANTTYPE field validation (all optional). crop_type_slug existence is enforced by the
  // crop_types FK at the DB (bad slug → 23503 → 400); here we only type-check.
  if (body.crop_type_slug != null && (typeof body.crop_type_slug !== 'string' || !body.crop_type_slug.trim())) {
    return 'crop_type_slug must be a non-empty string or null';
  }
  if (body.lifecycle != null && !VALID_LIFECYCLE.includes(body.lifecycle)) {
    return `lifecycle must be one of: ${VALID_LIFECYCLE.join(', ')}`;
  }
  for (const k of ['scoville_min', 'scoville_max']) {
    if (body[k] != null) {
      const n = Number(body[k]);
      if (!Number.isInteger(n) || n < 0) return `${k} must be a non-negative integer or null`;
    }
  }
  if (body.scoville_min != null && body.scoville_max != null && Number(body.scoville_min) > Number(body.scoville_max)) {
    return 'scoville_min must be <= scoville_max';
  }
  if (body.growth_habit != null && typeof body.growth_habit !== 'string') {
    return 'growth_habit must be a string or null';
  }
  if (body.produces_scape != null && typeof body.produces_scape !== 'boolean') {
    return 'produces_scape must be a boolean or null';
  }
  return null;
}
