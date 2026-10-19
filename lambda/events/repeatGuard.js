// BUG-EVENTSREPEATTAP-001 — the single-event POST does not write the same event twice.
//
// THE DEFECT. POST /api/events inserted whatever arrived, and prod shows what that costs: watering
// pairs 0.2-2.8 s apart (double taps), a Beet greens harvest written three times 21 s and 25 s apart,
// Red Raspberries 0.15 cup twice 25 s apart (both live, so the season total is doubled), fruit_set
// pairs at 16-24 s. api.js stops waiting at 15 s (API_TIMEOUT_MS), so 16-25 s is a write that
// committed after the client gave up, then a re-tap of Save on the form that was still filled in.
//
// The server decides, inside the write's own transaction (lambda/events/index.js, POST arm). This
// module holds only the pure parts, so they can be unit-tested without the handler: the window, which
// types are guarded, and the advisory-lock key.

// THE WINDOW. Covers every clear duplicate measured (all <= 25 s) with margin for a slow re-tap, and
// stays below the two ambiguous prod pairs (Zephyr Squash 1 count x2 at 60 s, Suyo Long 1 count x2 at
// 80 s), which may be real separate picks. Dropping a real pick silently is worse than a visible
// duplicate the user can undo, so the window errs short.
export const REPEAT_WINDOW_SECONDS = 45;

// NOT GUARDED. A photo event is one event per photo: prod has 59 identical `photo` pairs 5-30 s apart,
// and they are multi-photo uploads, not re-taps. Every one must keep inserting.
export const REPEAT_UNGUARDED_EVENT_TYPES = Object.freeze(['photo']);

export function isRepeatGuarded(eventType) {
  return typeof eventType === 'string' && eventType !== ''
    && !REPEAT_UNGUARDED_EVENT_TYPES.includes(eventType);
}

// THE LOCK KEY. Two requests in flight at once would each read the event log before the other's row
// exists and both insert. pg_advisory_xact_lock(hashtextextended(key, 0)) is taken first in the
// transaction, so the second request waits until the first commits; under READ COMMITTED (prod's
// default, and the driver sends no isolation header) its repeat check, the NEXT statement, then sees
// the first one's row. The key is the identity a repeat must share — the user, the anchors and the
// type — so unrelated events never wait on each other. A hash collision costs only a short wait.
// projectId is the DERIVED one (deriveEventProjectId), the value that is written.
export function repeatLockKey({ userId, plantId, projectId, locationId, eventType }) {
  return ['event_repeat', userId, plantId ?? '', projectId ?? '', locationId ?? '', eventType].join('|');
}
