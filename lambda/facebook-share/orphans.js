// Orphan cleanup for a failed multi-photo post — pure control flow, injected I/O.
//
// WHY THIS IS ITS OWN MODULE. index.js cannot be imported by the root vitest run (its AWS/Clerk/Neon
// deps live in this directory's own package.json), so anything left inside the handler has no
// execution coverage — and this path had none. It is also the path that decides whether a PUBLIC
// Facebook Page is left holding invisible published=false media, which makes "untested" the wrong
// status for it. Following the header contract in index.js: pure logic lives in a sibling module,
// unit-tested without deps.
//
// THE DEFECT THIS REPLACES. The previous inline version fired every delete, discarded every return
// value, and then marked EVERY 'uploading' row in the group 'orphan_cleaned'. The delete helper
// swallows its own errors and returns false, so a delete that never happened was recorded as a
// completed cleanup: the audit trail asserted the Page was clean while a real object sat on it, and
// no query could separate the two cases. Status is now derived per media id from the delete that
// actually ran.

// media        : [{ photo_id, media_fbid }] — the published=false uploads that DID succeed
// deleteMedia  : async (media_fbid) => boolean   truthy ONLY on a confirmed delete
// markCleaned  : async (photo_id) => void        row -> 'orphan_cleaned'
// markStranded : async (photo_id, media_fbid) => void   row -> 'failed' + a specific error
// log          : (message, detail) => void       loud channel for the stranded case
//
// Returns { cleaned: [...], stranded: [...] } so the caller (and a test) can assert the split.
export async function cleanupOrphanMedia({ media, deleteMedia, markCleaned, markStranded, log }) {
  const list = Array.isArray(media) ? media : [];
  if (list.length === 0) return { cleaned: [], stranded: [] };

  // A delete helper that THROWS rather than returning false must not abort the other deletes, and
  // must not be scored as a success. Both funnel to the same "not confirmed" verdict.
  const outcomes = await Promise.all(list.map(async (m) => {
    let deleted = false;
    try { deleted = !!(await deleteMedia(m.media_fbid)); } catch { deleted = false; }
    return { photo_id: m.photo_id, media_fbid: m.media_fbid, deleted };
  }));

  const cleaned = outcomes.filter((o) => o.deleted);
  const stranded = outcomes.filter((o) => !o.deleted);

  if (stranded.length && typeof log === 'function') {
    log(`orphan cleanup FAILED for ${stranded.length} of ${outcomes.length} media`,
      stranded.map((o) => o.media_fbid).join(','));
  }

  // Status writes are audit-only and must never mask the original publish failure, so each is
  // isolated: one row failing to update cannot stop the rest from being recorded.
  for (const o of cleaned) {
    try { await markCleaned(o.photo_id); } catch { /* audit-only */ }
  }
  for (const o of stranded) {
    try { await markStranded(o.photo_id, o.media_fbid); } catch { /* audit-only */ }
  }

  return { cleaned, stranded };
}

// The error text written onto a stranded row. Exported so the test asserts the real string and so
// the wording lives next to the logic that produces it.
export function strandedError(mediaFbid) {
  return `orphan cleanup failed — unpublished media ${mediaFbid} is still on the Page and must be removed manually`;
}
