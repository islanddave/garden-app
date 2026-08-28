// instagram.js — V4-IGSHARE-001 (Track D). Pure Instagram Content Publishing builders, validation,
// and status classification. No runtime deps (no neon/clerk/aws/fetch) so it unit-tests under
// `npm ci` without the handler's dependencies — mirrors ./graph.js.
//
// WHY INSTAGRAM IS NOT "FACEBOOK WITH A DIFFERENT ID". The Facebook path byte-uploads (multipart
// source=). The Instagram Content Publishing API has NO byte-upload: it takes an `image_url` and
// Meta's own fetcher retrieves it server-side. That single difference drives every design decision
// here and is why this is a separate module rather than a flag on graph.js.
//
// CONSEQUENCE — THE ORIGINAL S3 OBJECT MUST NEVER BE THE URL WE HAND META. Measured 2026-08-21:
// 4 of 5 sampled prod photos carry GPS EXIF (OnePlus/Google phones). The Facebook path strips EXIF
// before any byte leaves; handing Instagram a presigned URL to the untouched original would fetch
// Dave's home coordinates straight out of the object and silently undo that guarantee. The handler
// therefore stages EXIF-STRIPPED bytes to a short-lived staging key and presigns THAT. See
// stagingKey() below.
//
// VERIFIED 2026-08-21 (D0, the blocking prerequisite): Meta's fetcher DOES accept a signed,
// private, time-limited URL — presigned S3 object -> container -> status_code FINISHED on first
// poll. The signature was proven load-bearing (same URL unsigned -> HTTP 403). So Track D needs NO
// world-readable surface, which is the opposite of what the planning crucible assumed.

// D8: the Facebook module reads FB_GRAPH_VERSION. Instagram shares graph.facebook.com/{version} but
// must NOT silently inherit a version bumped for Facebook's sake — attached_media and IG publishing
// deprecate on independent schedules. Split the knob, fall back for continuity.
export const IG_GRAPH_VERSION =
  process.env.IG_GRAPH_VERSION || process.env.FB_GRAPH_VERSION || 'v21.0';

// Instagram's documented limits. These are IG's, NOT Facebook's — graph.js MAX_CAPTION is 5000,
// which would sail past IG's 2200 and fail at container creation, consuming quota for nothing.
export const IG_MAX_CAPTION = 2200;
export const IG_MAX_HASHTAGS = 30;
export const IG_MAX_MENTIONS = 20;
export const IG_MAX_BYTES = 8 * 1024 * 1024;   // IG caps at 8MB; Facebook's ceiling is 10MB
export const IG_MAX_CAROUSEL = 10;
export const IG_MIN_CAROUSEL = 2;              // 1 item is a plain single post, not a carousel
// alt_text on POST /{ig-user-id}/media. Meta's parameter reference: "For image posts only.
// Alternative text, up to 1000 character, for an image. Only supported on a single image or image
// media in a carousel." So it rides on the SINGLE container and on each carousel CHILD — never on
// the carousel parent, which holds no image of its own, and never on video/reels.
export const IG_MAX_ALT_TEXT = 1000;

// D4 polling contract. A container is not publishable the instant it is created; Meta fetches the
// URL asynchronously. Publishing a non-FINISHED container fails, so polling is mandatory, not
// defensive. The ceiling aborts rather than looping forever.
export const POLL_INTERVAL_MS = 3000;
export const POLL_CEILING_MS = 60000;

// The presigned staging URL only has to outlive Meta's fetch, which completed in under 3s in the D0
// probe. Short TTL bounds the window in which the URL grants access to anyone holding it. Do NOT
// reuse PHOTO_URL_TTL_SECONDS (900) — src/lib/photoModel.js hardcodes PRESIGN_TTL_MS against it and
// lambda/photos returns expires_in: 900 in three places, so that constant is load-bearing elsewhere.
export const STAGING_URL_TTL_SECONDS = 600;

export function igBase(v = IG_GRAPH_VERSION) { return `https://graph.facebook.com/${v}`; }
export function igMediaUrl(igUserId, v = IG_GRAPH_VERSION) { return `${igBase(v)}/${encodeURIComponent(igUserId)}/media`; }
export function igPublishUrl(igUserId, v = IG_GRAPH_VERSION) { return `${igBase(v)}/${encodeURIComponent(igUserId)}/media_publish`; }
export function igNodeUrl(id, v = IG_GRAPH_VERSION) { return `${igBase(v)}/${encodeURIComponent(id)}`; }
export function igLimitUrl(igUserId, v = IG_GRAPH_VERSION) { return `${igBase(v)}/${encodeURIComponent(igUserId)}/content_publishing_limit`; }

// Staging object key. Segregated under a dedicated prefix so a lifecycle rule can sweep anything the
// handler's own delete missed (a mid-run timeout leaves the key behind), and so it is never
// confusable with a real photo object.
export function stagingKey(groupId, photoId) {
  return `ig-staging/${groupId}/${photoId}.jpg`;
}

// Caption counting. IG counts hashtags and @-mentions across the whole caption and rejects the
// container above its limits. Matching is deliberately conservative: \w plus unicode letters, and a
// tag must follow start-of-string or whitespace so "a#b" and an email's @ do not count.
export function countHashtags(caption) {
  if (!caption) return 0;
  return (caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
}
export function countMentions(caption) {
  if (!caption) return 0;
  return (caption.match(/(^|\s)@[\p{L}\p{N}_.]+/gu) || []).length;
}

// Validate the POST body against INSTAGRAM's limits. Returns the same shape as
// graph.js validateShareRequest so the handler can treat them uniformly.
export function validateInstagramRequest(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};
  const ids = Array.isArray(b.photo_ids) ? b.photo_ids : null;

  if (!ids) errors.push('photo_ids must be a non-empty array');
  else {
    if (ids.length === 0) errors.push('photo_ids must contain at least one photo');
    if (ids.length > IG_MAX_CAROUSEL) errors.push(`photo_ids may contain at most ${IG_MAX_CAROUSEL} photos`);
    if (ids.some((x) => typeof x !== 'string' || x.length === 0)) errors.push('every photo_id must be a non-empty string');
    if (new Set(ids).size !== ids.length) errors.push('photo_ids must not contain duplicates');
  }

  let caption = null;
  if (b.caption != null) {
    if (typeof b.caption !== 'string') errors.push('caption must be a string');
    else {
      if (b.caption.length > IG_MAX_CAPTION) errors.push(`caption may be at most ${IG_MAX_CAPTION} characters for Instagram`);
      if (countHashtags(b.caption) > IG_MAX_HASHTAGS) errors.push(`caption may contain at most ${IG_MAX_HASHTAGS} hashtags`);
      if (countMentions(b.caption) > IG_MAX_MENTIONS) errors.push(`caption may contain at most ${IG_MAX_MENTIONS} @-mentions`);
      if (errors.length === 0) caption = b.caption;
    }
  }

  let clientRequestId = null;
  if (b.client_request_id != null) {
    if (typeof b.client_request_id !== 'string' || b.client_request_id.length > 200) {
      errors.push('client_request_id must be a string <= 200 chars');
    } else clientRequestId = b.client_request_id;
  }

  return { ok: errors.length === 0, errors, photoIds: ids ?? [], caption, clientRequestId };
}

// D6: preparePhoto() in the handler checks JPEG magic bytes only and does NO size check. Facebook
// tolerates 10MB; Instagram rejects above 8MB — and a rejected container still consumes quota
// against the 400/24h creation cap, so check BEFORE spending a container.
export function checkImageBytes(byteLength) {
  if (byteLength > IG_MAX_BYTES) {
    return { ok: false, error: `image is ${(byteLength / 1048576).toFixed(1)}MB; Instagram's limit is 8MB` };
  }
  return { ok: true };
}

// Classify a container status poll ({ status_code, status }).
//
// Deliberately distinguishes ERROR from EXPIRED. They look alike and are not:
//   ERROR   — the fetch or the media failed. Recoverable by re-creating with a FRESH url (the old
//             presigned URL may simply have expired mid-fetch).
//   EXPIRED — the container aged out (24h) unpublished. Unrecoverable; the container is gone.
// Collapsing them makes the retry path either useless or an infinite loop.
export function classifyContainerStatus(json) {
  const code = json?.status_code ?? null;
  const detail = json?.status ?? '';
  return {
    code,
    detail,
    finished: code === 'FINISHED',
    published: code === 'PUBLISHED',
    errored: code === 'ERROR',
    expired: code === 'EXPIRED',
    inProgress: code === 'IN_PROGRESS',
    terminal: code === 'FINISHED' || code === 'ERROR' || code === 'EXPIRED' || code === 'PUBLISHED',
    retryable: code === 'ERROR', // fresh URL may succeed; EXPIRED never will
  };
}

// D7: the quota endpoint counts PUBLISHES only. Container creations are capped separately (400/24h)
// and are NOT reflected here, so a caller that only reads this can still be throttled by creating
// containers it never publishes. Returned as {quotaUsage, configQuotaUsage} when present.
export function parsePublishingLimit(json) {
  const d = Array.isArray(json?.data) ? json.data[0] : null;
  if (!d) return { known: false, used: null, cap: null };
  const used = typeof d.quota_usage === 'number' ? d.quota_usage : null;
  // Meta's docs contradict themselves on the cap (50 vs 100); read it from the response when the
  // config is present rather than hardcoding either number.
  const cap = typeof d.config?.quota_total === 'number' ? d.config.quota_total : null;
  return { known: used != null, used, cap };
}

// alt_text, spread into a field list. Mirrors altField() on the Facebook side and makes the same
// choice for the same reason: an absent description must be an ABSENT FIELD, never alt_text=''. An
// empty string is a stored, deliberate-looking "this image has no description" that suppresses the
// platform's own handling, whereas omitting leaves the media in the state Instagram already knows
// how to treat. Filler would be worse than either — a screen reader announces it as a description.
//
// Over the 1000-character cap the field is OMITTED rather than truncated. This text is DERIVED from
// planting/variety/crop names, so it should be a short phrase; anything approaching 1000 characters
// means something upstream is wrong, and a silently truncated description would hide that while
// possibly ending mid-word. Sending it anyway would fail container creation and burn quota.
export function igAltField(alt) {
  const a = typeof alt === 'string' ? alt.trim() : '';
  if (!a || a.length > IG_MAX_ALT_TEXT) return [];
  return [['alt_text', a]];
}

// Build the child-container fields for a carousel item. Children carry NO caption — the caption
// belongs on the parent, and setting it on a child is silently ignored. They DO carry alt_text:
// Meta's reference allows it on "image media in a carousel", and the child is the only container in
// this flow that corresponds to an actual image.
export function carouselChildFields(imageUrl, accessToken, alt) {
  return [
    ['image_url', imageUrl],
    ['is_carousel_item', 'true'],
    ...igAltField(alt),
    ['access_token', accessToken],
  ];
}

// Build the parent carousel container fields. `children` is a comma-separated list of child
// container ids, in display order. NO alt_text here — the parent holds no image of its own; the
// per-image descriptions live on the children built above.
export function carouselParentFields(childIds, caption, accessToken) {
  return [
    ['media_type', 'CAROUSEL'],
    ['children', childIds.join(',')],
    ['caption', caption ?? ''],
    ['access_token', accessToken],
  ];
}

// Build the fields for a single (non-carousel) image container.
export function singleImageFields(imageUrl, caption, accessToken, alt) {
  return [
    ['image_url', imageUrl],
    ['caption', caption ?? ''],
    ...igAltField(alt),
    ['access_token', accessToken],
  ];
}
