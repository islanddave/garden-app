// V4-OVERWINTERCARE-001 — the overwintering regimes as the PICKER shows them.
//
// The four keys are the model; everything else here is UI copy. The keys are duplicated from
// lambda/daily-plan/overwinter.js rather than imported because that module is CommonJS Lambda
// source and this one is bundled into the SPA — src/lib/wateringScale.js reaches into lambda/ for a
// JSON file, but no production SPA module imports a CJS lambda .js, and this is not the change to
// make it the first. src/__tests__/overwinterRegimeParity.test.js holds the two lists (plus the
// plants Lambda's allowlist) identical, so a fifth regime cannot be added to the model without
// this picker failing loudly instead of silently omitting it.
//
// WHAT THE COPY HAS TO DO. Dave is standing in front of a plant deciding which of four buckets it
// is in, and the four are ordered by DRYING RATE, not by how alive the plant is — which is exactly
// the counter-intuitive part of the model. So each label names the SITUATION ("held indoors"), the
// description names the PLANTS, and the check interval is shown as the consequence of the choice.
// Naming the interval in the picker is not decoration: it is the only place the user can see that
// picking "cold and resting" means a monthly check rather than never.
export const OVERWINTER_REGIME_OPTIONS = [
  {
    value: 'protected_productive',
    icon: '🥬',
    label: 'Under cover, still growing',
    description: 'Low tunnel or cold frame — kale, spinach, mache. Check every 14 days; the cover sheds the rain.',
  },
  {
    value: 'field_hardy',
    icon: '🧄',
    label: 'Hardy, out in the ground',
    description: 'Garlic, mache, established perennials. Check every 21 days — a snowless dry cold snap is the risk.',
  },
  {
    value: 'tender_indoors',
    icon: '🫚',
    label: 'Held indoors, tender',
    description: 'Ginger and tropicals kept above their cold floor. Check every 10 days — heated air dries a pot fast.',
  },
  {
    value: 'protected_quiescent',
    icon: '🪴',
    label: 'Cold and resting',
    description: 'Fig or fuchsia in a cold garage. Check every 30 days — barely damp; wet plus cold is what rots these.',
  },
]

export const OVERWINTER_REGIME_KEYS = OVERWINTER_REGIME_OPTIONS.map((o) => o.value)

// The stored attribute is either the object form or the `true` shorthand (readAttr accepts both),
// and `false` means absent. Returns null when nothing is set, so a caller can branch on truthiness
// without re-deriving the shorthand rule.
export function overwinterRegimeOf(attr) {
  if (attr == null || attr === false) return null
  if (attr === true) return OVERWINTER_REGIME_OPTIONS[0].value
  return typeof attr.regime === 'string' ? attr.regime : OVERWINTER_REGIME_OPTIONS[0].value
}

export function overwinterLabel(attr) {
  const regime = overwinterRegimeOf(attr)
  if (!regime) return null
  // An unrecognised stored value is labelled by its own text rather than silently relabelled to the
  // default the engine will actually run. The engine's fallback is a safety behaviour; showing it
  // as the user's choice would hide the mismatch instead of surfacing it.
  return OVERWINTER_REGIME_OPTIONS.find((o) => o.value === regime)?.label ?? regime
}
