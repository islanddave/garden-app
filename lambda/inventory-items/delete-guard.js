// BUG-INVREFSTRAND-001 (option C, Dave 2026-09-24: "Block only if sown") — the pre-delete reference
// check, and why the database cannot do it for us.
//
// THE DEFECT. Four foreign keys point at inventory_items, two of them ON DELETE RESTRICT, and NONE of
// them ever fires: this handler's DELETE is `UPDATE inventory_items SET deleted_at = NOW()`, and an FK
// guards DELETEs. The row survives, everything pointing at it keeps a technically-valid pointer, and
// every read path filters `deleted_at IS NULL` — so the pointer stops resolving, silently, on a 200.
//
// WHAT BLOCKS A DELETE: a reference that lives OUTSIDE the item — something grown from it or applied
// from it. A planting sown from a packet is its own record with its own history, and its link back to
// the seed it came from is provenance nobody can rebuild once the packet is gone. So is a treatment
// logged with a product. Worded by property, not by table, the way the Deleted-Planting and
// Archive-Hiding rules in project-rules/gardening.md are:
//   • a planting, archived or not, whose seed came from this item — plants.source_inventory_item_id.
//     ARCHIVED COUNTS: archiving is a statement about the garden, and an archived planting is still
//     history (the Archive-Hiding Rule). A SOFT-DELETED planting does not: it is retracted, and
//     blocking on it would make the item undeletable to protect a row nobody can see.
//   • a live treatment event that applied this item — event_log.treatment_product_id.
//
// WHAT DOES NOT BLOCK: what belongs to the item itself. Its own photos, its own seed-processing stage
// rows, and the seed_saved event's metadata.seed_lot_id pointer describe the item, not something else,
// so they keep their pointer and follow it into soft-deletion intact: clearing the item's deleted_at
// brings it back with every one of them (Soft-Delete-Only Rule: relations preserved; inventory has no
// restore route in the app today, so that is a data fix). Blocking on them made every saved-seed lot
// undeletable from birth (each is born with a stage row that nothing can remove) and failed Snap's
// inventory Undo every time (it attaches the captured photo before offering Undo) — measured on prod
// 2026-09-24: the four-relation guard refused 330 of 525 live items; this one refuses 39.
//
// A SINGLE CHOKE POINT, NOT THE WHOLE STORY. Every writer of the two blocking columns already refuses
// to point at a deleted item (the plants and events Lambdas both pass the id through
// loadOwnedInventoryItem, which filters deleted_at IS NULL), so in the app a strand is made by deleting
// after pointing — here. What gets past it: a reference created between the check and the UPDATE,
// restoring a planting or event that pointed at an item deleted meanwhile, and hand-written SQL.
// migrations/v5-invrefstrand-001/gates.yml is the detector, and it counts exactly what this blocks on.

// The relations a delete refuses over. Named by their real constraint so the census gate in
// v5-invrefstrand-001 and this list are compared against pg_constraint rather than only against each
// other. The detector's guard gate has one arm per entry here and no others —
// delete-gate-coverage.test.js holds the two together in both directions.
export const BLOCKING_RELATIONS = Object.freeze([
  { table: 'plants', column: 'source_inventory_item_id',
    constraint: 'plants_source_inventory_item_id_fkey' },
  { table: 'event_log', column: 'treatment_product_id',
    constraint: 'event_log_treatment_product_id_fkey' },
]);

// The other two foreign keys to inventory_items: they belong to the item and follow it. Listed so every
// FK the census names is classified here one way or the other — a fifth FK reds the census gate, and
// the coverage test then reds until it is added to exactly one of these two lists.
export const FOLLOWING_RELATIONS = Object.freeze([
  { table: 'photos', column: 'inventory_item_id',
    constraint: 'photos_inventory_item_id_fkey' },
  { table: 'seed_lot_stage_log', column: 'inventory_item_id',
    constraint: 'seed_lot_stage_log_inventory_item_id_fkey' },
]);

// The label the item's Status control shows for `depleted`. InventoryDetail renders
// INVENTORY_STATUSES (src/lib/inventoryEnums.js, a plain string list) through EnumSelect, which uses
// the value itself as the label — delete-reference-guard.test.js reads that list and fails if the
// label ever changes without this.
export const DEPLETED_STATUS_LABEL = 'depleted';

// ONE statement: the ownership check and the counts arrive together, and each Neon call is its own HTTP
// round trip. Zero rows = not found or not the caller's, which the route answers 404 before any count is
// read. The plantings count includes archived ones; `plants_archived` is only there so the sentence can
// say how many of them are archived.
//
// `saved_lot` — seed Dave saved himself rather than a packet he bought, so the sentence can call it what
// the app calls it ("seed lot"). EXACTLY isSavedLot's three facts (src/components/seed/seedLots.js), any
// one non-null and non-empty: a parent planting, a recorded origin kind, or a processing stage. The
// Lambda cannot import that module (each Lambda is zipped from its own directory), so the predicate is
// written again here in SQL, and saved-lot-pairing.test.js holds the two to the same facts and the same
// verdicts. Empty-string arms kept for parity, though the columns cannot hold '' today (uuid, CHECKs).
export async function deletePreflight(sql, itemId, householdIds) {
  const rows = await sql`
    SELECT i.category,
           (COALESCE(i.source_plant_id::text, '') <> ''
            OR COALESCE(i.source_kind, '') <> ''
            OR COALESCE(i.seed_stage, '') <> '') AS saved_lot,
           (SELECT count(*) FROM public.plants p
             WHERE p.source_inventory_item_id = i.id
               AND p.deleted_at IS NULL)::int AS plants,
           (SELECT count(*) FROM public.plants p
             WHERE p.source_inventory_item_id = i.id
               AND p.deleted_at IS NULL
               AND p.archived_at IS NOT NULL)::int AS plants_archived,
           (SELECT count(*) FROM public.event_log e
             WHERE e.treatment_product_id = i.id
               AND e.deleted_at IS NULL)::int AS event_log
      FROM public.inventory_items i
     WHERE i.id = ${itemId}
       AND i.created_by = ANY(${householdIds})
       AND i.deleted_at IS NULL
  `;
  const row = rows[0];
  if (!row) return { found: false, blocking: [] };
  const blocking = BLOCKING_RELATIONS
    .map((rel) => ({
      ...rel,
      count: Number(row[rel.table] ?? 0),
      ...(rel.table === 'plants' ? { archived: Number(row.plants_archived ?? 0) } : {}),
    }))
    .filter((rel) => rel.count > 0);
  // Strictly true: the driver parses a Postgres boolean to a JS boolean, and anything else is not one.
  return { found: true, category: row.category, savedLot: row.saved_lot === true, blocking };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function plantingsClause({ count, archived = 0 }) {
  if (archived === 0) return `${plural(count, 'planting was', 'plantings were')} sown from it`;
  if (archived === count) return `${plural(count, 'archived planting was', 'archived plantings were')} sown from it`;
  return `${count} plantings were sown from it (${archived} of them archived)`;
}

// The sentence the 409 carries in `error`, for Dave: what is in the way, how many, whether archived ones
// are among them (the packet page's "Sown from this packet" card lists only unarchived plantings, so an
// archived one would otherwise look like nothing), and what to do instead. NEVER "detach": clearing a
// planting's seed source destroys the provenance this refusal exists to protect.
//
// The subject is the app's own noun for the row: "This seed lot" for seed he saved (the Seeds pages say
// "Open the seed lot"), "This packet" for any other seed row, "This item" for everything else. A saved
// lot is a kind of seed row, so `category` decides first. Two of the three facts are seeds-only by CHECK
// (chk_inventory_source_plant_seeds_only, chk_inventory_source_kind_seeds_only); seed_stage has no such
// CHECK, and no non-seed row carried any of the three on prod on 2026-09-24 — one that did would still
// read "This item".
export function blockingMessage(blocking, category, savedLot = false) {
  const subject = category !== 'seeds' ? 'This item' : savedLot ? 'This seed lot' : 'This packet';
  const reasons = blocking.map((r) => (r.table === 'plants'
    ? plantingsClause(r)
    : `it was used in ${plural(r.count, 'logged treatment', 'logged treatments')}`));
  return `${subject} can't be removed: ${reasons.join(' and ')}. ` +
    `To mark it used up, set its Status to "${DEPLETED_STATUS_LABEL}" instead.`;
}
