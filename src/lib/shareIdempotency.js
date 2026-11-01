// Reload-durable idempotency keys for social publishing (V4-FBSHARE-001).
//
// WHY THIS EXISTS. The key cannot live in a React useRef: a useRef dies on reload — and a reload is
// precisely what happens in the failure the key exists to prevent: the client aborts at its own
// fetch timeout while the Lambda keeps running to its 180s budget and posts anyway, so the user sees
// a failure for a post that succeeded, reloads the PWA, and retries. With a freshly-minted id the
// server's replay lookup (`WHERE client_request_id = ...`) misses and the same photos post to the
// public Page a SECOND time. The key has to survive the one event it exists for.
//
// KEYED BY CONTENT, NOT BY ATTEMPT. The slot key is the canonical (target, sorted photo ids,
// caption) tuple, which gives all three behaviours at once:
//   retry in the same tab   -> same id (the in-memory ref still holds it)
//   retry after a reload    -> same id (storage hit; identical content resolves the same slot)
//   after a success         -> slot cleared, so a DELIBERATE repost of the same photos mints a new
//                              id and genuinely posts again.
// That last line is why this is not the plain `hash(photo_ids + caption + target)` a purely
// deterministic scheme would use: a deterministic key replays forever, so once Dave posted a photo
// he could never post it again. Content-keyed storage that clears on success keeps the retry
// protection without taking reposting away.
//
// The canonical tuple is used as the map key verbatim rather than hashed. A hash would be shorter
// but any collision means replaying an UNRELATED post's result back to the user as if it were
// theirs, and the storage cost here is one pending post's worth of text.
//
// Every storage access is wrapped: localStorage throws outright in some privacy modes, and this
// must degrade to the old in-memory behaviour rather than break sharing.

const STORE_KEY = 'gardens.share.idempotency.v1';
// Slots are pruned past this age. A slot only survives an ABANDONED attempt (posted-then-never-
// retried); the success path clears its own. 24h is long enough to cover "I'll retry in the
// morning" and short enough that a genuine repost the next day is not silently replayed.
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

// Canonical, order-insensitive identity of one share attempt. photo_ids are sorted because
// selecting the same photos in a different order is the same post for idempotency purposes, and
// caption is normalised the same way the request body normalises it (trimmed, blank -> null).
// The field separator is NUL, written as the two-character escape `\x00` (a RAW NUL byte here trips
// OPS-NULBYTESRC-001, which keeps source greppable). NUL is the separator because it is
// the one character that cannot appear in either field: photo ids are UUIDs, and a caption comes
// from a textarea, which browsers never populate with NUL. A visible delimiter like `|` or a space
// could appear inside a caption and let two different posts collide onto one slot — which would
// replay an unrelated post's result back to the user as if it were theirs.
export function shareSlotKey({ target, photoIds, caption }) {
  const ids = Array.isArray(photoIds) ? [...photoIds].map(String).sort() : [];
  const cap = typeof caption === 'string' && caption.trim() ? caption.trim() : '';
  return `${target ?? 'facebook'}\x00${ids.join(',')}\x00${cap}`;
}

function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeStore(store) {
  try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* storage unavailable — in-memory ref still covers the same-tab retry */ }
}

function prune(store, now) {
  let changed = false;
  for (const [k, v] of Object.entries(store)) {
    if (!v || typeof v.at !== 'number' || (now - v.at) > IDEMPOTENCY_TTL_MS) { delete store[k]; changed = true; }
  }
  return changed;
}

export function newRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

// Return the id already associated with this slot, minting and persisting one if there is none.
// Idempotent by construction: two calls with the same slot return the same id until it is released.
export function acquireRequestId(slot, now = Date.now()) {
  const store = readStore();
  prune(store, now);
  const hit = store[slot];
  if (hit?.id) {
    writeStore(store);            // persist the prune
    return hit.id;
  }
  const id = newRequestId();
  store[slot] = { id, at: now };
  writeStore(store);
  return id;
}

// Called on a CONFIRMED success. Drops the slot so the next post of identical content is a genuinely
// new post rather than a replay of this one.
export function releaseRequestId(slot) {
  const store = readStore();
  if (slot in store) {
    delete store[slot];
    writeStore(store);
  }
}
