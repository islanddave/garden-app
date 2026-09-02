// V4-SEEDORIGIN-001 — the seed-lot provenance vocabulary, for lambda/inventory-items.
//
// THE CANONICAL DEFINITION IS lambda/preservation/provenance.js. This is a per-directory copy
// because each Lambda is zipped from its own directory, so a `../preservation/provenance.js` import
// 502s the deployed handler — the same constraint that forces the household.js copies (caught
// 2026-05-20).
//
// WHY THIS IS A NARROW COPY AND NOT A BYTE-IDENTICAL ONE, which is what the household.js precedent
// would suggest. The first attempt copied provenance.js whole. `lambda/authz-write-fk.test.js`
// (BUG-AUTHZFKENUM-001) immediately failed with:
//     inventory-items::harvest_log_id
//     inventory-items::plant_id
// — because that module's validateProvenance() reads `body.plant_id` and `body.harvest_log_id`, and
// the scanner correctly saw two FK-shaped body-settable columns in this Lambda's directory with no
// ownership decision recorded. Those are preservation_log's foreign keys. inventory-items does not
// write them and has no business declaring them.
//
// The sanctioned escape is to list them in that test's NOT_IN_SITES. That would have been the wrong
// fix: it permanently blinds an authz guard for two columns in THIS Lambda, so if inventory-items
// ever did start writing a plant_id from a request body, nothing would say so. Silencing a correct
// alarm to keep an over-broad copy is a bad trade. Copying only what is used costs one drift test
// and blinds nothing.
//
// DRIFT IS GUARDED BY VALUE, NOT BY BYTES: lambda/provenance-copies-sync.test.js imports this array
// and the canonical one and asserts deep equality. That is strictly stronger on the thing that
// matters — a byte-identical check passes if BOTH files are emptied; a value check does not.
//
// VALID_SOURCE_KINDS now has four synchronised homes, each with its own gate:
//   1. lambda/preservation/provenance.js                         (canonical)
//   2. this file                                                 (provenance-copies-sync.test.js)
//   3. chk_inventory_source_kind / chk_preservation_log_source_kind  (migration post-gates)
//   4. PUTUP_SOURCE_OPTIONS in src/lib/dropdownRegistry.js       (preservationProvenance.test.js)
// This schema already fragmented a provenance vocabulary once — plants.source_type,
// v4-source-freetext, 2026-07-07 — which is why every leg is gated rather than trusted.
//
// DEPENDENCY-FREE ON PURPOSE, inherited from the canonical module: index.js imports neon/clerk/aws,
// none of which are in the root package.json, so a unit test importing index.js dies under npm ci in
// CI. Everything here is importable by the blocking build-and-test suite. Do not add imports.

export const VALID_SOURCE_KINDS = [
  'own_garden', 'u_pick', 'farm_stand', 'csa', 'store', 'gift', 'foraged', 'other',
];
