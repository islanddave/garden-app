// BUG-CADENCESIZE-001 — vessel-data gaps, surfaced where Dave already looks.
//
// WHY THIS EXISTS. The watering interval now reads `container_size` for some vessels, so a missing or
// wrong vessel record stopped being cosmetic. It is not rare: of 228 active plantings (live prod,
// 2026-08-18) 98 have a NULL `container_size` and 22 have no `container_type` at all — and a location
// literally named "Bag Area" holds 78 `fabric_bag` rows alongside 26 recorded `plastic_pot`, three of
// which were photographed and are unambiguously black fabric grow bags.
//
// The engine's answer to a gap is to DECLINE (see engine.dailyFloorFor: unknown vessel keeps today's
// behaviour). That is correct and safe, but it is also silent. This module makes the same gap visible.
//
// DESIGN CONSTRAINT — ambient, not a chore list. Dave fixes these walking past a bag, not sitting down
// to a data-entry session. So there is no banner, no badge and no new visual language: the detail sheet
// already hides a row whose value is empty (`.filter(([, v]) => v)`), which renders a missing pot size
// as literally nothing. This turns that invisible absence into a STATED one in the sheet's existing
// muted label style — the same "convert an inference into a stated fact" move `waterStaleness` already
// makes elsewhere in this codebase.
//
// THIS MODULE NEVER WRITES. It describes; Dave edits.

// Loose readability probe — deliberately NOT a reimplementation of the Lambda's parseContainerGal.
// Its only job is "could a human-entered string plausibly be read as a number plus a unit at all", so
// that obvious garbage ("big", "large") gets flagged to Dave. Reproducing the gallon math here would
// create a second source of truth that silently drifts from the engine's, which is a worse failure than
// the one it would catch. A string this accepts but the engine cannot parse simply gets no prompt —
// the engine still declines to act on it, so the safe direction is preserved either way.
const READABLE_SIZE = /\d\s*(gal|quart|qt|liter|litre|l|oz|ounce|inch|in|"|cm|ft|foot|feet|')/i;

// Location-name -> the container_type family that name implies. Keys are matched case-insensitively as
// substrings of the location path, so "Gardens / Bag Area" matches 'bag'.
//
// SCOPE, stated honestly: this is the LOCATION-NAME half of the conflict check only. A `container_type`
// that disagrees with its PROJECT SIBLINGS is the other half and is not computed here — the detail page
// loads one planting and has no sibling vessel data, so it would need a new API field. The location
// check already covers the motivating case (the Bag Area plastic_pots) because those rows carry the
// location, so the sibling check is additive value rather than a gap in the motivating scenario.
const LOCATION_IMPLIES = [
  { match: 'bag', types: ['fabric_bag'], label: 'grow bags' },
  { match: 'trough', types: ['trough'], label: 'troughs' },
  { match: 'raised bed', types: ['raised_bed', 'in_ground'], label: 'raised beds' },
];

// Vessels whose size is implied by the type itself — asking for a size on these is noise, so a missing
// size is NOT a gap for them. Mirrors the engine's reasoning (a trough is a trough at any recorded size).
const SIZE_IMPLIED_TYPES = new Set(['in_ground', 'raised_bed', 'trough', 'whiskey_barrel', 'tray_cell',
  'soil_block', 'solo_cup']);

// Returns an array of gap descriptors, most actionable first. Empty array = nothing to say.
// Each: { kind, field, text }. `text` is user-facing copy; `kind` is stable for tests/telemetry.
export function vesselDataGaps(pl) {
  if (!pl || typeof pl !== 'object') return [];
  const type = typeof pl.container_type === 'string' ? pl.container_type.trim().toLowerCase() : '';
  const size = typeof pl.container_size === 'string' ? pl.container_size.trim() : '';
  const path = typeof pl.location_path === 'string' ? pl.location_path.toLowerCase() : '';
  const gaps = [];

  // A type/location conflict is listed FIRST: a wrong value is worse than a missing one, because the
  // rest of the app (and now the watering interval) treats it as known.
  if (type && path) {
    for (const { match, types, label } of LOCATION_IMPLIES) {
      if (path.includes(match) && !types.includes(type)) {
        gaps.push({ kind: 'type_conflicts_location', field: 'container_type',
          text: `Recorded as ${labelFor(type)}, but this location is ${label}` });
        break;
      }
    }
  }
  if (!type) {
    gaps.push({ kind: 'missing_type', field: 'container_type', text: 'Not recorded' });
  }
  // Only ask for a size where a size means something and none is implied by the type.
  if (!SIZE_IMPLIED_TYPES.has(type)) {
    if (!size) gaps.push({ kind: 'missing_size', field: 'container_size', text: 'Not recorded' });
    else if (!READABLE_SIZE.test(size)) {
      gaps.push({ kind: 'unreadable_size', field: 'container_size', text: `"${pl.container_size}" — no size read` });
    }
  }
  return gaps;
}

// Convenience for a single field: the gap to show on that row, or null.
export function vesselGapFor(pl, field) {
  return vesselDataGaps(pl).find((g) => g.field === field) || null;
}

function labelFor(type) { return String(type).replace(/_/g, ' '); }
