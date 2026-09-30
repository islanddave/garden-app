// src/lib/putUpClientState.js
// Put-Up (V4 §5.6 / §6.5, review-2 B70) — THE PERSISTED-CLIENT-STATE REGISTRY for the Put-Up page: every
// URL param it reads and every storage key it (or a sheet on it) writes, in one list.
//
// WHY A REGISTRY. After every promote the NEW bundle boots on URLs and drafts the OLD bundle wrote (the
// service worker's reload keeps the URL and history.state). A renamed param drops a person out of what
// they were doing; a renamed key orphans their draft; a reshaped draft half-restores. So a param or key
// is never renamed or reshaped silently: it is listed here with its shape, putUpClientState.test.js pins
// that the code's constants are these, and a change to one is a deliberate edit to both.
//
// PURE DATA. Nothing reads this at runtime except the one constant the page imports (FIND_PARAM); the
// rest is the ledger the test holds the code to.

// ── URL params on /put-up ─────────────────────────────────────────────────────────────────────────
export const FIND_PARAM = 'find'

export const PUT_UP_URL_PARAMS = Object.freeze({
  view: "'pantry' — lands on the Pantry segment (Today's band: /put-up?view=pantry&filter=use-soon). Release 1a.",
  filter: "'use-soon' — the Pantry narrowed to discard status soon|past, behind a removable \"Use soon ×\" chip. Release 1a.",
  batch: '<kitchen_batch id> — batch detail mode. V5-BATCHCLOSE-001.',
  state: "'closed' — the closed-batches list. V5-BATCHCLOSE-001.",
  session: "'putup' — the walk (Walk a place). The shipped key, kept (V4 §6.2; a phone mid-walk at deploy lands back in it).",
  place: '<storage_location id> — the walk\'s place. B′ release 2.',
  [FIND_PARAM]: 'free text — the page search; its first keystroke pushes a history entry so Back clears it. B′ release 2.',
  recipe: '<recipe id> — recipe detail (release 4, the recipes lane; V4 §6.2). A recipe search hit opens it.',
})

// ── Storage keys ──────────────────────────────────────────────────────────────────────────────────
export const PUT_UP_STORAGE_KEYS = Object.freeze({
  // sessionStorage via draftStash.js — the shipped "Log a put-up" form's draft (never rename: PutUp.jsx DRAFT_KEY).
  'put-up': { store: 'sessionStorage (draftStash)', shape: 'the log form snapshot + prefillKey' },
  // localStorage — the walk's stash (putUpSession.js WALK_KEY). v1 records from the shipped freezer walk
  // ({storageId, date, dateApprox, …}) still read; B′ writes {place:{key,id,label,kind}, whenChoice,
  // pickedDate, when:{date,precision}, whenWords, date} under the same key and version, and a record
  // without `when` only preselects its place (WalkPlace.resumableWalk).
  'garden:putup-walk:v1': { store: 'localStorage', shape: '{v:1, place, whenChoice, pickedDate, when, whenWords, date} | legacy {v:1, storageId, date, dateApprox, …}' },
  'garden:putup-not-mine:v1': { store: 'localStorage', shape: '{v:1, slugs: string[]}' },
  // localStorage via kitchen/sheetDraft.js — one key per sheet per person: <prefix><sub>:<sheet>:<id|new>.
  'garden:putup-draft:v1:': { store: 'localStorage (sheetDraft prefix)', shape: '{v:1, sheet, savedAt, data}; 24 h; sheets below' },
  // localStorage — the Pantry rename bridge, per viewer (components/pantry/pantryBridge.js).
  'garden:pantry-bridge:v1:': { store: 'localStorage (prefix + clerk sub)', shape: '{visits: int, dismissed: bool}' },
})

// The sheet names inside the sheetDraft prefix, each with its data shape's checker's home.
export const PUT_UP_DRAFT_SHEETS = Object.freeze({
  start: 'kitchen/StartBatchSheet.jsx',
  checkin: 'putup/CheckOnItSheet.jsx',
  putup: 'putup/PutItUpSheet.jsx (isPutItUpDraft)',
  line: 'putup/LineSheet.jsx',
  putsomethingup: 'pantry/PutSomethingUpSheet.jsx (isDoorDraft) — B′ release 2',
})
