// src/components/seed/seedStages.js
// V4-SEEDHISTORY-001 — the seed-lot processing vocabulary for the /inventory/:id surface.
//
// THIS IS THE THIRD DECLARATION OF THE SAME THREE VALUES, and naming that is the point of putting
// it in its own file rather than inlining it. The set is fixed by the DB CHECK
// inventory_items_seed_stage_check (migrations/v4-seedsaveflow-001/0a-ddl.sql:37-55, which also
// records the 3-not-4 decision and names the constraint as the one place to change if a stage is
// ever added). It is spelled out again in lambda/inventory-items/index.js once — the /seed-stage
// route's STAGES; the wide PUT's SEED_STAGES went with BUG-SEEDSTAGEHEADSHIP-001, when that verb
// stopped reading the stage. src/pages/SavedSeeds.jsx used to carry a fourth copy and imports this
// one now (V4-SEEDSTOREDQTY-001).
//
// Restating it here is therefore the least-bad option, and it is NOT left to drift:
// src/__tests__/seedStageVocabulary.test.js reads the other two declarations' source text and
// fails if either stops agreeing with this one, and pins that SavedSeeds.jsx still imports it.
export const SEED_STAGES = ['fermenting', 'drying', 'stored']

export const SEED_STAGE_LABELS = {
  fermenting: 'Fermenting',
  drying:     'Drying',
  stored:     'Stored',
}

// [{value,label}] for the frozen Select primitive. PROCESS ORDER, never alphabetical — these are
// steps, and `stored` is terminal; sorting them would put Drying first and teach the wrong sequence
// on the one control where the sequence is the meaning. (Same argument dropdownRegistry.js:54-55
// makes for using Select rather than EnumSelect, which sorts.)
export const SEED_STAGE_OPTIONS = SEED_STAGES.map(v => ({ value: v, label: SEED_STAGE_LABELS[v] }))

// Unknown values render as themselves rather than as a blank or a placeholder. Same reasoning as
// Select's withStoredValue (src/components/forms/Select.jsx:32-38): a stored value this file does
// not know about is data, and hiding it is how a real value gets silently replaced.
export const seedStageLabel = (s) => SEED_STAGE_LABELS[s] ?? String(s ?? '')
