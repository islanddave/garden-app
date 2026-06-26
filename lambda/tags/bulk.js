// bulk.js — V4-GARDENIA-001 bulk entity-tags assembly. Pure: folds the two SQL result sets
// (direct + projected tag rows, each carrying an entity_id column) into a per-planting map
//   { <entity_id>: { direct: Tag[], projected: Tag[] } }
// consumed by GARDENIA's faceted group-by. Kept out of index.js so it is unit-testable
// without the handler's getSecrets/verifyToken/neon import-time deps (household.js precedent).
export function assembleBulkEntities(directRows = [], projRows = []) {
  const entities = {};
  const ensure = (id) => (entities[id] ??= { direct: [], projected: [] });
  for (const r of directRows) { const { entity_id, ...tag } = r; ensure(entity_id).direct.push(tag); }
  for (const r of projRows) { const { entity_id, ...tag } = r; ensure(entity_id).projected.push(tag); }
  return entities;
}
