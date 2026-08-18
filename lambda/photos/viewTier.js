// V4-TIERBLINDMINT-001 — tier selection for GET /api/photos/view-url/:id.
//
// That route presigned photos.storage_path unconditionally, so the re-mint could only ever hand
// back the ORIGINAL. Both list read paths serve a tile its THUMB instead (thumbs/<storage_path>,
// derived by convention — BUG-PHOTOBLANK-001), and PhotoImg re-mints by photo id ALONE, so a thumb
// tile that healed a 900s expiry silently adopted the full original and kept it for the rest of its
// life. Not a regression (one request instead of three, no blank flash, same bytes) but it defeats
// the thumbnail saving on any tile that heals, which is the entire point of the tier.
//
// The response NAMES the tier it minted, not just the URL. Without that name a caller cannot tell a
// thumb presign from a full one, so it could not honour the tier even having asked for it — which is
// the "tier-blind" half of the defect, distinct from the "always original" half.
//
// SECURITY — the tier is an ENUM, never a key fragment. The caller names a tier from a closed set
// and the SERVER owns the prefix that name maps to, exactly as thumb-upload-url already does: "the
// `thumbs/` prefix is applied SERVER-SIDE and is not caller-nameable". Interpolating a caller string
// into the key would hand back the traversal and prefix-smuggling surface that A0.1
// (uploadKeyPolicy.js) spent a route closing.

export const PHOTO_VIEW_TIERS = Object.freeze(['full', 'thumb']);

// Server-owned prefixes. Only reachable for a name that already passed PHOTO_VIEW_TIERS.
const TIER_PREFIX = Object.freeze({ full: '', thumb: 'thumbs/' });

// Absent/empty => 'full': every already-shipped client sends no tier and must keep getting the
// original. An UNKNOWN tier returns null (the route 400s) rather than coercing to 'full' — silently
// serving the original for `?tier=thumbnail` would reintroduce exactly the tier-blindness this
// closes, and would hide the typo behind a 200.
export function normalizeViewTier(tier) {
  if (tier == null || tier === '') return 'full';
  return PHOTO_VIEW_TIERS.includes(tier) ? tier : null;
}

// The S3 key for a photo's storage_path at a given tier. Re-validates the tier rather than trusting
// the caller to have normalized: an unvalidated tier falling through to the original key is the
// silent-degrade this module exists to prevent, so it must not be reachable by a wiring mistake.
// A falsy path stays null so the caller's resolvePhotoViewUrl keeps its pre-existing null handling
// (view_url: null, not a 500).
export function viewTierKey(storagePath, tier) {
  if (!PHOTO_VIEW_TIERS.includes(tier)) return null;
  if (!storagePath) return null;
  return `${TIER_PREFIX[tier]}${storagePath}`;
}
