// V4-PUTUPLINK-001 — planting-attribution pure functions for the preservation Lambda.
//
// DEPENDENCY-FREE ON PURPOSE. index.js imports @neondatabase/serverless, @clerk/backend and
// @aws-sdk/client-secrets-manager, none of which are in the ROOT package.json — they resolve on a
// dev machine (hoisted from a lambda-local install) but `npm ci` in CI does NOT install them, so a
// unit test importing index.js fails at collect time in CI while passing locally. That is the exact
// local-green/CI-red trap this repo has been bitten by before. Keeping these here lets
// src/__tests__/preservationAttribution.test.js cover the L7 rules with zero Lambda deps.
// Sibling modules ship with the function bundle (same pattern as household.js).

// ── L7 cross-field integrity ─────────────────────────────────────────────────
// The design (V101 L7) required "planting_id's crop must match", but a cross-TABLE rule cannot be a
// column CHECK — chk_preservation_log_attribution only knows "crop OR variety". This is the sole
// enforcement point, and it runs on both POST and PUT.
//
//   * planting null        → caller could not resolve it (missing OR out of household — the caller
//                            must not distinguish, or the error becomes an existence oracle).
//   * crop/variety omitted → DERIVED from the planting, so picking a wave is complete attribution
//                            and the DB CHECK is always satisfied by the time the row lands.
//   * crop/variety given   → must MATCH. Rejecting rather than overwriting is deliberate: silently
//                            "fixing" a mismatch would rewrite what the user explicitly picked.
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

// Human label for a planting group. Successions are the whole reason to group by planting — three
// waves of one variety are name-identical, so the ordinal and sown date are what make them
// distinguishable. UTC formatting is required: the neon driver returns `date` columns as JS Date
// objects at UTC midnight, and a local-timezone render shifts them a day behind west of Greenwich.
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
