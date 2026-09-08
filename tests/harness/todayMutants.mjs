// todayMutants.mjs — the defect catalogue for the Today layout gate's mutation proof.
//
// A DATA FILE, imported by two consumers that must not import each other:
//   · tests/harness/vite.harness.mutant.mjs applies one of these in memory,
//   · scripts/mutate-today-shape-check.mjs enumerates them and runs the gate against each.
// Split out because the runner importing the CONFIG would evaluate the config's default export,
// which builds the mutation plugin, which throws when no TODAY_SHAPE_MUT is set — the runner would
// crash before running anything. (It did, and the wrapper reported exit 0 while it did.)
//
// Each entry states the DEFECT IT SIMULATES, not just the edit, so a future reader can tell whether
// the guard set still covers the failure mode rather than only whether the script exits 0.

// name -> [file, pattern, replacement, what defect it simulates]
export const MUTANTS = {
  clipRowPanel: [
    'src/components/today/CareNeeded.jsx',
    '<div id={panelId} data-testid="care-group-panel" role="list">',
    '<div id={panelId} data-testid="care-group-panel" role="list" style={{ height: 0, overflow: \'hidden\' }}>',
    'the care list is present, mounted, queryable and accessible — and occupies NO SPACE. 9,239 of 9,241 unit tests pass over it.',
  ],
  hideRowPanel: [
    'src/components/today/CareNeeded.jsx',
    '<div id={panelId} data-testid="care-group-panel" role="list">',
    '<div id={panelId} data-testid="care-group-panel" role="list" style={{ display: \'none\' }}>',
    'THE POSITIVE CONTROL. Same line as clipRowPanel, a defect jsdom CAN see (18 unit tests red). If this one survives here, the gate is not reading the panel at all.',
  ],
  dropRainNote: [
    'src/components/today/CareNeeded.jsx',
    'const n = Array.isArray(plan && plan.rain_skipped) ? plan.rain_skipped.length : 0',
    'const n = 0',
    'the one line explaining why 72 plantings are absent from the list disappears. Survived the full unit suite.',
  ],
  dropSubstrate: [
    'src/pages/Today.jsx',
    '{plan.substrate?.msg && !plan.substrate?.on_hold && (',
    '{false && plan.substrate?.msg && !plan.substrate?.on_hold && (',
    'the feeding note vanishes. Killed by exactly ONE unit assertion — one careless rename from vacuous.',
  ],
  dropBasisStamp: [
    'src/pages/Today.jsx',
    '{asOfLabel(data?.generated_at) && (',
    '{false && asOfLabel(data?.generated_at) && (',
    'the "Plan from overnight · as of …" provenance stamp is suppressed. Killed by exactly ONE unit assertion.',
  ],
  dropWatchBand: [
    'src/pages/Today.jsx',
    '<HarvestWatchBand />',
    '<></>',
    'a whole 957px region disappears in a re-layout.',
  ],
  dropWeather: [
    'src/pages/Today.jsx',
    '{plan.weather && (',
    '{false && plan.weather && (',
    'the 253px weather card — 30% of screen one — disappears.',
  ],
  dropCultivationLead: [
    'src/pages/Today.jsx',
    '<CultivationLead />',
    '<></>',
    'the page loses its durable door to /sow. It is the ONLY region present in all four states.',
  ],
  dropHouseholdToggle: [
    'src/pages/Today.jsx',
    '{!loading && !error && canShowOthers && (',
    '{false && !loading && !error && canShowOthers && (',
    'the second caretaker becomes unreachable from Today.',
  ],
  noLeadExpand: [
    'src/lib/careNeeded.js',
    'if (keys.size === 0) { keys.add(g.key); used = n; continue }',
    'if (keys.size === 0) { used = n; continue }',
    'the lead group stops force-opening, so the page opens with all nine groups collapsed and zero rows visible. The exact "opening screen shows nothing" failure the budget carve-out exists to prevent.',
  ],
  reorderStack: [
    'src/pages/Today.jsx',
    "<div data-testid=\"today-plan-stack\" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>",
    "<div data-testid=\"today-plan-stack\" style={{ display: 'flex', flexDirection: 'column-reverse', gap: 14 }}>",
    'A PURE CSS REORDER. The care list now paints ABOVE the weather card with the DOM untouched, so every compareDocumentPosition ordering assertion in the repo still passes. Only a rect-ordered census can see it.',
  ],
  // REWRITTEN after its first version was a BAD MUTANT. That one set `minHeight: 1; maxHeight: 1`
  // on the row's inner <Link> and the matrix scored it SURVIVED — but the row container is
  // `display:flex; align-items:stretch` and its Skip/Water buttons are 48px, so the ROW never
  // shrank and there was nothing for the gate to catch. A mutant that applies cleanly and changes
  // nothing reads exactly like a hole in the gate, which is the one way a mutation matrix actively
  // misleads. It now clamps the row container itself, which does produce the sliver.
  shrinkRows: [
    'src/components/today/CareNeeded.jsx',
    "<div data-testid=\"care-row\" style={{ display: 'flex', alignItems: 'stretch', borderTop: '1px solid ' + P.border }}>",
    "<div data-testid=\"care-row\" style={{ display: 'flex', alignItems: 'stretch', height: 1, overflow: 'hidden', borderTop: '1px solid ' + P.border }}>",
    'the rows survive as 1px slivers — count intact, checkVisibility() true, non-zero height, and unreadable. A count-plus-non-zero gate passes this.',
  ],
  dropDormant: [
    'src/components/today/CareNeeded.jsx',
    '<DormantList plan={plan} />',
    '<></>',
    'the four hidden dormant plantings — the block that renders in the empty state too — disappear.',
  ],
  dropBulkChips: [
    'src/components/today/CareNeeded.jsx',
    '{presentTypes.length > 0 && (',
    '{false && presentTypes.length > 0 && (',
    'the bulk-action block goes, taking the "Log all watering (74)" one-tap path with it.',
  ],
}

