// Planting-attribution pure functions for the preservation Lambda.
//
// Dependency-free on purpose: index.js imports packages that resolve locally but are not installed
// by `npm ci` in CI, so a unit test importing it passes locally and fails in CI. Kept here so
// src/__tests__/preservationAttribution.test.js covers the rules with zero Lambda deps.

// Cross-table rule (planting's crop/variety must match), so it cannot be a column CHECK; this is the
// sole enforcement point, on both POST and PUT.
//   * planting null        -> caller could not resolve it (missing OR out of household); the caller
//                             must not distinguish, or the error becomes an existence oracle.
//   * crop/variety omitted -> derived from the planting, so the DB attribution CHECK is satisfied.
//   * crop/variety given   -> must match; rejecting rather than overwriting keeps what the user picked.
export function reconcilePlantAttribution(body, planting) {
  if (!planting) return { error: 'plant_id does not match a planting you can log against' };
  const pCrop = planting.crop_type_slug ?? null;
  const pVariety = planting.variety_id ?? null;
  // String-compare: uuid columns arrive as strings but fixtures/ids may be other primitives, and a
  // type mismatch must not read as a contradiction.
  if (body.variety_id && pVariety && String(body.variety_id) !== String(pVariety)) {
    return { error: 'variety_id does not match that planting — clear one of them' };
  }
  if (body.crop_type_slug && pCrop && String(body.crop_type_slug) !== String(pCrop)) {
    return { error: 'crop_type_slug does not match that planting — clear one of them' };
  }
  return {
    crop_type_slug: body.crop_type_slug ?? pCrop,
    variety_id: body.variety_id ?? pVariety,
  };
}

// Human label for a planting group; ordinal and sown date tell successions of one variety apart.
// UTC formatting is required: the neon driver returns `date` columns as Date objects at UTC
// midnight, and a local-timezone render shifts them a day behind west of Greenwich.
export function plantingLabel(r) {
  const base = r.planting_name || r.planting_variety_name || 'Planting';
  const bits = [];
  if (r.planting_succession_order != null) bits.push(`wave ${r.planting_succession_order}`);
  if (r.planting_sown_at) {
    const d = r.planting_sown_at instanceof Date ? r.planting_sown_at : new Date(r.planting_sown_at);
    if (!isNaN(d.getTime())) {
      bits.push(`sown ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`);
    }
  }
  return bits.length ? `${base} — ${bits.join(', ')}` : base;
}
