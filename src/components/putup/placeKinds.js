// src/components/putup/placeKinds.js
// Put-Up R2a — the ONE list of the kinds of place a put-up can live in, and the word each is shown by where
// a person picks one. The six kinds are the server's (storage_location.kind: jarRoutes.PLACE_KINDS,
// storage-location's VALID_KINDS); src/__tests__/placeKinds.test.js binds this list, jarWords.KIND_WORDS and
// recipes.STORAGE_KIND_WORDS to them by key set, so a seventh kind cannot be added to one of the four alone.
// No chip reads a bare "Freezer": one word inside the other is not a choice, and the two freezers are dated
// differently (12 months against 4 for Freeze whole — a difference of quality, not of anything else).
export const PLACE_KINDS = Object.freeze([
  { kind: 'fridge', label: 'Fridge' }, { kind: 'fridge_freezer', label: 'Fridge freezer' },
  { kind: 'deep_freezer', label: 'Deep freezer' }, { kind: 'pantry', label: 'Pantry shelf' },
  { kind: 'cold_storage', label: 'Cellar' }, { kind: 'other', label: 'Counter or other' },
])

// What "＋ Somewhere else" offers: all six, in that order (the door and the Walk through
// DoorParts.PlaceChipRow, Put it up through PutItUpSheet's PlacePicker).
export const NEW_PLACE_KINDS = PLACE_KINDS

export function placeKindLabel(kind) { return PLACE_KINDS.find(k => k.kind === kind)?.label ?? null }
