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
//
// PATTERNS ARE EXACT SOURCE TEXT and the plugin THROWS when one no longer matches — a mutant that
// silently fails to apply would be scored SURVIVED, the one result here that can lie. So when a
// parallel change rewrites one of these lines (V5-TODAYSHAPE-001 was ported alongside a CareNeeded
// Row change on 2026-09-24), the matrix goes loud, and the fix is to re-point the pattern here.
// `shrinkRows` keys only on the row's opening `<div data-testid="care-row" style={{` for that reason:
// it survives any edit to the rest of the row's style object.

// name -> [file, pattern, replacement, what defect it simulates]
export const MUTANTS = {
  clipRowPanel: [
    'src/components/today/CareNeeded.jsx',
    '<div id={panelId} data-testid="care-group-panel" role="list">',
    '<div id={panelId} data-testid="care-group-panel" role="list" style={{ height: 0, overflow: \'hidden\' }}>',
    'the care list is present, mounted, queryable and accessible — and occupies NO SPACE. 9,239 of 9,241 unit tests passed over it when measured (2026-09-08).',
  ],
  hideRowPanel: [
    'src/components/today/CareNeeded.jsx',
    '<div id={panelId} data-testid="care-group-panel" role="list">',
    '<div id={panelId} data-testid="care-group-panel" role="list" style={{ display: \'none\' }}>',
    'THE POSITIVE CONTROL. Same line as clipRowPanel, a defect jsdom CAN see (18 unit tests red on 2026-09-08). If this one survives here, the gate is not reading the panel at all.',
  ],
  dropRainNote: [
    'src/components/today/CareNeeded.jsx',
    'const n = Array.isArray(plan && plan.rain_skipped) ? plan.rain_skipped.length : 0',
    'const n = 0',
    'the one line explaining why rain-credited plantings are absent from the list disappears. Survived the full unit suite (2026-09-08).',
  ],
  dropSubstrate: [
    'src/pages/Today.jsx',
    '{plan.substrate?.msg && !plan.substrate?.on_hold && (',
    '{false && plan.substrate?.msg && !plan.substrate?.on_hold && (',
    'the feeding note vanishes. Killed by exactly ONE unit assertion on 2026-09-08 — one careless rename from vacuous.',
  ],
  dropBasisStamp: [
    'src/pages/Today.jsx',
    '{asOfLabel(data?.generated_at) && (',
    '{false && asOfLabel(data?.generated_at) && (',
    'the "Plan from overnight · as of …" provenance stamp is suppressed. Killed by exactly ONE unit assertion on 2026-09-08.',
  ],
  dropWatchBand: [
    'src/pages/Today.jsx',
    '<HarvestWatchBand />',
    '<></>',
    'the whole "Worth checking soon" band disappears in a re-layout.',
  ],
  dropWeather: [
    'src/pages/Today.jsx',
    '{plan.weather && (',
    '{false && plan.weather && (',
    'the weather card — the top of screen one — disappears.',
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
    'the lead group stops force-opening, so the page opens with every group collapsed and zero rows visible. The exact "opening screen shows nothing" failure the budget carve-out exists to prevent.',
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
  // misleads. It clamps the row container itself, which does produce the sliver; later keys in the
  // style object do not set height or overflow, so the prefix wins.
  shrinkRows: [
    'src/components/today/CareNeeded.jsx',
    '<div data-testid="care-row" style={{ ',
    '<div data-testid="care-row" style={{ height: 1, overflow: \'hidden\', ',
    'the rows survive as 1px slivers — count intact, checkVisibility() true, non-zero height, and unreadable. A count-plus-non-zero gate passes this.',
  ],
  dropDormant: [
    'src/components/today/CareNeeded.jsx',
    '<DormantList plan={plan} />',
    '<></>',
    'the dormant plantings — the block that renders in the empty state too — disappear.',
  ],
  dropBulkChips: [
    'src/components/today/CareNeeded.jsx',
    '{presentTypes.length > 0 && (',
    '{false && presentTypes.length > 0 && (',
    'the bulk-action block goes, taking the "Log all watering (N)" one-tap path with it.',
  ],

  // ── added 2026-09-24 with the regions Today gained after the gate was first built ─────────────
  dropCueLine: [
    'src/pages/Today.jsx',
    '<WeatherCueLine callout={cueCallout} generatedAt={data?.generated_at} planDate={data?.plan_date} />',
    '<></>',
    'the engine\'s one-cue-per-day weather line ("Cool night (44°F) — protect …") stops rendering. On a quiet day that is indistinguishable from the engine being silent.',
  ],
  dropFrostLine: [
    'src/pages/Today.jsx',
    '<FrostAlertLine alertsSent={plan.alerts_sent} lowShown={agreed?.lowF} planLow={plan.weather?.tonightLow} />',
    '<></>',
    'the frost advisory / frost-watch line Dave was emailed about has no surface on Today again — BUG-FROSTALERTNOAPP-001 reintroduced.',
  ],
  dropDroughtLine: [
    'src/pages/Today.jsx',
    '<DroughtLine plan={plan} />',
    '<></>',
    'the garden-wide drought line is unmounted — the "shipped but never rendered" state DroughtLine.jsx\'s own header warns about.',
  ],
  dropLeafWetness: [
    'src/pages/Today.jsx',
    '<LeafWetnessLine plan={plan} />',
    '<></>',
    'the leaf-wetness scouting line is unmounted. It renders on ~23% of days, so its absence reads as an ordinary dry week.',
  ],
  dropCapNote: [
    'src/components/today/CareNeeded.jsx',
    '{hiddenTotal > 0 && (',
    '{false && hiddenTotal > 0 && (',
    'the one line saying rows are being WITHHELD goes, so the visible list silently under-reports the garden while the group counts still claim the full number.',
  ],
  dropShowMore: [
    'src/components/today/CareNeeded.jsx',
    '{group.hidden > 0 && (',
    '{false && group.hidden > 0 && (',
    'the "Show N more" door goes: the capped rows are still withheld and now unreachable from the list.',
  ],
  uncapRows: [
    'src/components/today/CareNeeded.jsx',
    'const capping = !showCapped',
    'const capping = false',
    'the length cap silently stops applying, and the lead group renders every water row again — the ~4,500px page V5-TODAYCAP-001 removed.',
  ],
  dropMoistButton: [
    'src/components/today/CareNeeded.jsx',
    '{canMoistureCheck(row) && <MoistureButton',
    '{false && canMoistureCheck(row) && <MoistureButton',
    'the per-row "Moist" button stops rendering on water rows. Every row, count and region stays intact; only a per-control census sees it.',
  ],
  dropDroughtList: [
    'src/components/today/CareNeeded.jsx',
    '<DroughtList plan={plan} />',
    '<></>',
    'the "Dry — no deep soak" list is unmounted: plantings held off calendar watering lose the only drought context they get.',
  ],
  dropFeedSuppressed: [
    'src/components/today/CareNeeded.jsx',
    '<FeedSuppressedList plan={plan} />',
    '<></>',
    'the "No feed schedule for N plantings" disclosure goes, and those plantings look forgotten rather than deliberately unfed.',
  ],
}
