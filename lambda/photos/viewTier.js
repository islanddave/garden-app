// Tier selection for GET /api/photos/view-url/:id.
//
// That route used to presign photos.storage_path unconditionally, so a re-mint could only hand back
// the ORIGINAL. Both list read paths serve a tile its THUMB instead (thumbs/<storage_path>, derived by
// convention), and PhotoImg re-mints by photo id ALONE, so a thumb tile that healed an expired (900s)
// URL silently adopted the full original and kept it, defeating the thumbnail saving on any tile that
// heals.
//
// The response NAMES the tier it minted, not just the URL. Without that name a caller cannot tell a
// thumb presign from a full one, so it could not honour the tier even having asked for it: the
// "tier-blind" half of the defect, distinct from the "always original" half.
//
// SECURITY — the tier is an ENUM, never a key fragment. The caller names a tier from a closed set
// and the SERVER owns the prefix that name maps to, exactly as thumb-upload-url already does: "the
// `thumbs/` prefix is applied SERVER-SIDE and is not caller-nameable". Interpolating a caller string
// into the key would reopen the traversal and prefix-smuggling surface that uploadKeyPolicy.js closes.

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
