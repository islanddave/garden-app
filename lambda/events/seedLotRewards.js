// seedLotRewards.js — V5-SEEDMULTIPARENT-001 release 2a: key a seed_saved event's rewards on the JAR.
//
// Release 2's client writes one seed_saved event per parent planting of a saved-seed lot. The flat XP
// grant is keyed on the EVENT id and a critter is rolled per event, so a jar with N parents would pay
// N times. This module answers, for one just-inserted seed_saved event, whether its rewards may be
// keyed on the lot instead, and what the two lot-keyed predicates read:
//   • flat XP: the grant's source_id becomes the LOT id, so the existing
//     UNIQUE (user_id, reason, source_id) pays once per person per jar. `xpAlreadyPaid` is the half
//     that index cannot see: a jar whose earlier event was paid on its EVENT id (every save before
//     this release, and any later event that fell through to the event key) must not pay again.
//   • critter: `otherEventExists` — any OTHER seed_saved event carrying this lot id, live OR
//     soft-deleted. Deleted rows count on purpose: event delete is soft and leaves the critter, so a
//     live-only test would roll again on every remove-then-re-add.
//
// RETURNS NULL — "exactly today's behaviour", event-keyed grant and a roll — for every case that is
// not provably this one: not a seed_saved event, no planting, no metadata.seed_lot_id, an id that is
// not uuid-shaped, a lot that is absent / foreign / soft-deleted, a planting that is not a LIVE
// seed_parent of that lot, and any read that throws. NEVER throws: rewards are derived, and nothing
// here may fail the event write that has already committed.
//
// The uuid test is NOT decoration. metadata is free-form jsonb straight from the request body; an
// unguarded value reaching a ::uuid cast is a 22P02 inside the flat grant's non-fatal try block,
// i.e. the XP silently dropped. Nothing below is bound into SQL before UUID_RE has passed it, and
// what is bound afterwards is the id as the DATABASE returned it, not as the request spelled it.
//
// The lot half reuses household.js loadOwnedInventoryItem as it stands (uuid guard, household, not
// deleted). The link half lives HERE and not in household.js: that file is one source copied to 19
// directories and held byte-identical by lambda/household-copies-sync.test.js. It carries no
// category test of its own: only a seeds lot can hold a seed_parent link.
// Column contract for the link read: seed-lot-parent-planting-columns.test.js.
import { loadOwnedInventoryItem } from './household.js';

export const SEED_SAVED_EVENT_TYPE = 'seed_saved';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The lot id a seed_saved event names, lowercased, or null when it names none that is uuid-shaped.
export function readSeedLotId(metadata) {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = metadata.seed_lot_id;
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return null;
  return raw.toLowerCase();
}

// → null, or { lotId, xpAlreadyPaid, otherEventExists }.
export async function resolveSeedLotRewards(sql, { eventType, eventId, plantId, metadata, userId, householdIds }) {
  try {
    if (eventType !== SEED_SAVED_EVENT_TYPE) return null;
    if (!eventId || !UUID_RE.test(String(plantId ?? ''))) return null;
    const claimed = readSeedLotId(metadata);
    if (!claimed) return null;

    const lot = await loadOwnedInventoryItem(sql, claimed, householdIds);
    if (!lot) return null;
    const lotId = String(lot.id).toLowerCase();
    if (!UUID_RE.test(lotId)) return null;

    // One round trip for the link and both predicates. The two event_log arms compare the metadata
    // value as lowercased TEXT and never cast it: other rows' metadata is as free-form as this one's.
    const rows = await sql`
      SELECT
        EXISTS (
          SELECT 1 FROM public.seed_lot_parent_planting sl
          WHERE sl.inventory_item_id = ${lotId}::uuid
            AND sl.plant_id = ${plantId}::uuid
            AND sl.role = 'seed_parent'
            AND sl.deleted_at IS NULL
        ) AS is_live_parent,
        EXISTS (
          SELECT 1 FROM event_log oe
          WHERE oe.event_type = ${SEED_SAVED_EVENT_TYPE}
            AND lower(oe.metadata->>'seed_lot_id') = ${lotId}
            AND oe.id <> ${eventId}::uuid
        ) AS other_event_exists,
        EXISTS (
          SELECT 1 FROM xp_events x
          JOIN event_log pe ON pe.id = x.source_id
          WHERE x.user_id = ${userId}
            AND x.reason = 'event_logged'
            AND lower(pe.metadata->>'seed_lot_id') = ${lotId}
        ) AS xp_already_paid
    `;
    const row = rows[0];
    if (!row || row.is_live_parent !== true) return null;
    return {
      lotId,
      xpAlreadyPaid: row.xp_already_paid === true,
      otherEventExists: row.other_event_exists === true,
    };
  } catch (err) {
    console.warn('seed lot reward check failed (non-fatal, event-keyed rewards):', err?.message ?? String(err));
    return null;
  }
}
