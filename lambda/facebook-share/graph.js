// graph.js — V4-FBSHARE-001. Pure Graph-API URL/field builders, request validation, and error
// classification. No runtime deps (no neon/clerk/aws/fetch) so it unit-tests under `npm ci` without
// the handler's dependencies — mirrors lambda/harvests/aggregate.js. The handler owns the actual
// fetch()/FormData I/O; this module owns everything decidable without a network call.

// Graph version is env-overridable so a version deprecation is a config bump, not a redeploy.
export const GRAPH_VERSION = process.env.FB_GRAPH_VERSION || 'v21.0';
export const MAX_PHOTOS = 10;      // attached_media practical ceiling; enforced at selection + here
export const MAX_CAPTION = 5000;   // app-side sanity cap (FB allows more); avoids accidental huge posts

export function graphBase(v = GRAPH_VERSION) { return `https://graph.facebook.com/${v}`; }
export function photoUploadUrl(pageId, v = GRAPH_VERSION) { return `${graphBase(v)}/${encodeURIComponent(pageId)}/photos`; }
export function feedUrl(pageId, v = GRAPH_VERSION) { return `${graphBase(v)}/${encodeURIComponent(pageId)}/feed`; }
export function nodeUrl(id, v = GRAPH_VERSION) { return `${graphBase(v)}/${encodeURIComponent(id)}`; }

// attached_media is passed as indexed form fields, each a JSON object referencing a published=false
// media id. Order here is the display order in the post.
export function attachedMediaFields(mediaIds) {
  return mediaIds.map((id, idx) => [`attached_media[${idx}]`, JSON.stringify({ media_fbid: String(id) })]);
}

// Validate the POST body. Returns { ok, errors[], photoIds[], caption|null, clientRequestId|null }.
// photo_ids must be a non-empty array of <= MAX_PHOTOS unique-ish strings (UUIDs; the DB fetch is the
// real existence + household check, so we only shape-validate here). caption optional.
export function validateShareRequest(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};
  const ids = Array.isArray(b.photo_ids) ? b.photo_ids : null;

  if (!ids) errors.push('photo_ids must be a non-empty array');
  else {
    if (ids.length === 0) errors.push('photo_ids must contain at least one photo');
    if (ids.length > MAX_PHOTOS) errors.push(`photo_ids may contain at most ${MAX_PHOTOS} photos`);
    if (ids.some((x) => typeof x !== 'string' || x.length === 0)) errors.push('every photo_id must be a non-empty string');
    if (new Set(ids).size !== ids.length) errors.push('photo_ids must not contain duplicates');
  }

  let caption = null;
  if (b.caption != null) {
    if (typeof b.caption !== 'string') errors.push('caption must be a string');
    else if (b.caption.length > MAX_CAPTION) errors.push(`caption may be at most ${MAX_CAPTION} characters`);
    else caption = b.caption;
  }

  let clientRequestId = null;
  if (b.client_request_id != null) {
    if (typeof b.client_request_id !== 'string' || b.client_request_id.length > 200) {
      errors.push('client_request_id must be a string <= 200 chars');
    } else clientRequestId = b.client_request_id;
  }

  return { ok: errors.length === 0, errors, photoIds: ids ?? [], caption, clientRequestId };
}

// Classify a Graph error envelope ({ error: { code, error_subcode, message, type } }) plus the HTTP
// status. tokenInvalid => the Page token is dead/expired (re-auth runbook). rateLimited => back off,
// keyed on error.code (NOT HTTP 429 — Graph returns rate errors as 200/400 with a code).
export function classifyGraphError(json, httpStatus = 0) {
  const e = (json && json.error) || {};
  const code = typeof e.code === 'number' ? e.code : null;
  const subcode = typeof e.error_subcode === 'number' ? e.error_subcode : null;
  const message = e.message || `Graph request failed (HTTP ${httpStatus})`;

  // 190 = invalid/expired access token; 102 = session/API auth; 10x OAuth family.
  const tokenInvalid = code === 190 || code === 102 || e.type === 'OAuthException' && (subcode === 463 || subcode === 467);
  // 4 = app rate limit, 17 = user rate limit, 32 = page rate limit, 613 = custom rate limit.
  const rateLimited = code === 4 || code === 17 || code === 32 || code === 613;
  const retryable = rateLimited || httpStatus >= 500 || code === 1 || code === 2; // 1/2 = transient/unknown

  return { code, subcode, message, tokenInvalid, rateLimited, retryable };
}
