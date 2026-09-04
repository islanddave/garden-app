-- V5-INFLIGHTBATCH-001 — an object for a food process that is UNDERWAY.
--
-- WHY THIS EXISTS. Measured on prod 2026-09-03: preservation_log holds 5 rows, and 389 harvest
-- events have been logged since the last one. Dave has a pepper mash on the counter right now that
-- the schema cannot represent for TWO independent reasons — it is unfinished, and it mixes garden
-- jalapenos with bought fresnos and a reaper, which chk_preservation_log_source_plant forbids. The
-- gap is not the vocabulary: `ferment_mash` already ships, documented at lambda/preservation/
-- index.js:50 as "an UNFINISHED intermediate — still working, not a finished preserve". The gap is
-- that there is no object between a harvest and a finished jar. Design + 8-seat panel:
-- project-state/_crucible-inflight-20260903/DECISION-V100.md (gardening-docs).
--
-- ADDITIVE AND EXPAND-ONLY. Three new tables, one nullable column on preservation_log, one CHECK on
-- that column, one view. NOTHING existing is dropped, relaxed, or re-typed.
--
-- WHY NOT preservation_log (the "just add a status column" option). FIVE constraints make an
-- in-flight row unrepresentable there, not the two a first draft claimed: preserved_at date NOT
-- NULL, quantity_value NOT NULL CHECK (> 0), quantity_unit NOT NULL, package_count NOT NULL DEFAULT
-- 1 CHECK (>= 1), and chk_preservation_log_attribution (crop_type_slug OR variety_id — a mixed mash
-- with store aromatics has neither). And relaxing them is not a schema change: index.js:589-610 is a
-- FULL-REPLACE PUT assigning each of those columns unconditionally, so the DB NOT NULL is the only
-- backstop behind one app-layer `if` (validateCommon:179). A disarmed constraint never fails loudly,
-- and the disarm would land on prod before any Lambda that could compensate. Separately, all four
-- existing SELECTs (index.js:430,503,539,677) have NO status filter and the whats-put-up predicate
-- `remaining_count IS NULL OR > 0` actively ADMITS a null-remaining in-flight row — so that option
-- would have put unfinished ferments into the freezer headline, the Today band, and planting detail
-- on the day the migration landed, before a line of code read the new column.
--
-- WHY NOT inventory_items. `type text NOT NULL CHECK (type IN ('consumable','durable'))` plus six
-- paired CHECKs partition that table's columns; a kitchen batch is neither and must lie, and
-- whichever arm it picks makes a quantity column effectively NOT NULL on day one — the same fatal
-- flaw, reproduced, plus 40 columns. Also chk_inventory_source_plant_seeds_only and
-- chk_inventory_source_kind_seeds_only would forbid exactly the provenance this needs. And
-- v5-varietyhybridflag-001/gates.yml already recorded the deciding fact: putPayloadFrom
-- (InventoryDetail.jsx:1113) spreads the whole row minus a DENYLIST, so a new column there is
-- client-writable with no deploy at all.
--
-- NAMED kitchen_* AND NOT process_*. `event_batches` already exists on prod (401 rows, a
-- bulk-action undo/idempotency ledger for care events). Two unrelated meanings of "batch" one grep
-- apart is a trap for every future reader. `kitchen` also matches the capture affordance this is
-- built for ("Something in the kitchen").
--
-- NO CURRENT-STAGE CACHE, and this is a repair rather than a precaution. The one existing instance
-- of cache-beside-log — inventory_items.seed_stage vs seed_lot_stage_log — has THREE cache writers
-- (the /seed-stage CTE at inventory-items:447-466, the wide PUT at :858-860, the create INSERT at
-- :1075-1090) and ONE log writer (:462). Two of the three cannot append. All 3 live staged lots
-- diverged, which breaks the shipped stage_entered_at LATERAL (it joins on `sl.stage =
-- i.seed_stage`) and returns NULL on 100% of them — the "N days in drying" feature is dark in prod
-- today. Current stage here is DERIVED, through v_kitchen_batch_current below. Measured cost on
-- prod: one index probe per batch against a composite index that ships in this file, so the bound is
-- the number of OPEN BATCHES, not log depth.
--
-- CHECKS ARE CREATED VALIDATED, not NOT VALID. Every table below is brand new and empty, so there is
-- nothing to scan and nothing to violate. Per v5-varietyhybridflag-001's finding, NOT VALID buys
-- nothing here and leaves a permanent convalidated=false that a later reader cannot distinguish from
-- "known violators exist". The ONE check on an existing table (preservation_log) is verified
-- vacuous in gates.yml against all 5 live rows before it is armed.
--
-- RLS DELIBERATELY OFF, matching the preservation family. preservation_log, harvest_log,
-- storage_location and seed_lot_stage_log all have relrowsecurity=false; isolation for this family
-- is app-layer via householdScope(). That is a STATED inheritance, not a silent one. ⚠ If RLS is
-- ever enabled on these tables it must ship WITH policies in the same transaction — an RLS-enabled
-- table with no policy denies everything, silently, to everyone.

BEGIN;

-- ── 1. the parent ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.kitchen_batch (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- user_id, matching preservation_log and storage_location — NOT created_by, which is the
  -- inventory/event family's spelling. Read-scoped through householdScope(), so Jen sees Dave's.
  user_id             text NOT NULL,
  label               text NOT NULL,          -- "Pepper mash — Aug 2026". Free text on purpose.

  -- KIND IS NULLABLE. A kind picker at capture time is not free: the existing put-up picker has a
  -- 40% mis-file rate on its 5 live rows, and the whole point of the capture path this serves is
  -- that "something in the kitchen, started now, here is a photo" must be a COMPLETE, VALID record.
  -- The method is pinned at close-out, when it becomes a preservation_log row and that CHECK applies.
  kind                text,
  kind_other          text,

  -- THE START. Nullable AND graded, paired so neither half can lie about the other.
  --   started_at NULL + precision NULL      = never asked            (the honest default)
  --   started_at NULL + precision 'unknown' = asked, and he does not know
  --   started_at SET  + precision exact..month = a date with its grade
  -- The two NULL states are different claims and the renderer treats them differently — an un-asked
  -- batch may prompt, an `unknown` one must never prompt again. This is the same distinction
  -- v4-putupsession-001/0a-additive-ddl.sql:82 made deliberately three-valued for
  -- preserved_at_approx ("NULL = unrecorded ... it is NOT the same claim as FALSE").
  started_at          timestamptz,
  start_precision     text,
  start_anchor_kind   text,     -- what a back-date was pinned to
  start_anchor_id     uuid,     -- photos.id / harvest_log.id; NULL for 'memory'
  -- The honest floor when started_at IS NULL. "First recorded Sep 3" is a fact even when the start
  -- is not, and it is what the card leads with instead of a blank.
  first_recorded_at   timestamptz NOT NULL DEFAULT now(),

  -- EXPECTED DURATION AS A RANGE. A single expected_days makes "every derived number inherits the
  -- widest bound" uncomputable. Nullable: a process with no defensible window ships with no chip
  -- rather than a guessed one.
  expected_days_min   integer,
  expected_days_max   integer,

  -- SALT / BRINE, captured as FREE TEXT. The one field the preservation seat argued hardest to add:
  -- it simultaneously sets the safety margin, sets the rate, and is the only number the cook is
  -- actively holding at pack time. Ask at pack and you get it; ask a week later and it is gone
  -- forever. Free text ("1 tsp per cup", "a big pinch") because requiring a scale would mean it is
  -- never filled in at all.
  brine_note          text,

  -- SUSPENDED IS NOT CLOSED. A frozen candy parent resumes N times over months; showing it beside a
  -- day-2 syrup pot as equally "in flight" misreports the only thing the Going-now view exists to
  -- say. Distinct from closed_at, which is terminal.
  suspended_at        timestamptz,

  -- CLOSURE. Primary data, not a cache: written once, in one place, with no log counterpart to
  -- diverge from. closed_at IS NULL means in flight.
  closed_at           timestamptz,
  outcome             text,
  outcome_note        text,

  cover_photo_id      uuid REFERENCES public.photos(id) ON DELETE SET NULL,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,

  -- A DIFFERENT AXIS from chk_preservation_log_method's 18 values, deliberately and permanently:
  -- one mash batch legitimately outputs both `hot_sauce` and `ferment_mash` jars. The app must never
  -- auto-map one vocabulary to the other.
  CONSTRAINT chk_kitchen_batch_kind CHECK (kind IS NULL OR kind = ANY (ARRAY[
    'ferment','dehydrate','candy','cure','infuse','age','other'])),
  CONSTRAINT chk_kitchen_batch_kind_other CHECK (
    kind IS DISTINCT FROM 'other' OR (kind_other IS NOT NULL AND btrim(kind_other) <> '')),

  -- 'hour' exists because a dehydrator run has no rung for "sometime this afternoon", and grading it
  -- as `day` would render a 100%+ error as a confident figure.
  CONSTRAINT chk_kitchen_batch_start_precision CHECK (
    start_precision IS NULL OR start_precision = ANY (ARRAY[
      'exact','hour','day','week','month','unknown'])),
  -- The biconditional that makes the four start states above the ONLY four. A date always carries a
  -- real grade; a real grade never appears without a date; 'unknown' only ever appears without one.
  CONSTRAINT chk_kitchen_batch_start_pairing CHECK (
    (started_at IS NOT NULL) = (start_precision IS NOT NULL AND start_precision <> 'unknown')),
  CONSTRAINT chk_kitchen_batch_anchor_kind CHECK (
    start_anchor_kind IS NULL OR start_anchor_kind = ANY (ARRAY[
      'harvest','photo','purchase','memory','manual'])),
  -- One-directional on purpose: 'memory' legitimately has no id, but an id always needs a kind.
  CONSTRAINT chk_kitchen_batch_anchor_pairing CHECK (
    start_anchor_id IS NULL OR start_anchor_kind IS NOT NULL),

  CONSTRAINT chk_kitchen_batch_expected_pairing CHECK (
    (expected_days_min IS NULL) = (expected_days_max IS NULL)),
  CONSTRAINT chk_kitchen_batch_expected_order CHECK (
    expected_days_min IS NULL OR (expected_days_min >= 0 AND expected_days_max >= expected_days_min)),

  -- SIX OUTCOMES, NOT TWO, and the extra four are each load-bearing.
  --   put_up            — produced storable output(s), as intended
  --   put_up_different  — produced something real but not what was intended. Candying's commonest
  --                       non-ideal result is a DOWNGRADE ("not terminal — it's a chewy confection
  --                       now"); a binary close forces either a lie or discarding a real output.
  --   consumed          — eaten, never stored
  --   given_away
  --   discarded_spoiled — the only one that should prompt for a reason, and the only one worth
  --                       keeping a note on. Split from `consumed` because in a two-user household
  --                       "Jen cannot tell whether the jar was eaten or thrown out" is the actual
  --                       hazard: the next similar jar gets judged against a fate nobody knows.
  --   abandoned         — lost track of it. Honest, and it must be cheap, or mouldy batches stay
  --                       open forever and poison the Going-now list.
  CONSTRAINT chk_kitchen_batch_outcome CHECK (
    outcome IS NULL OR outcome = ANY (ARRAY[
      'put_up','put_up_different','consumed','given_away','discarded_spoiled','abandoned'])),
  CONSTRAINT chk_kitchen_batch_close_pairing CHECK ((closed_at IS NULL) = (outcome IS NULL)),
  -- A closed batch cannot also be suspended: suspended means "paused, still mine to finish".
  CONSTRAINT chk_kitchen_batch_suspend_exclusive CHECK (
    suspended_at IS NULL OR closed_at IS NULL),
  CONSTRAINT chk_kitchen_batch_label_nonblank CHECK (btrim(label) <> '')
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.kitchen_batch
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- Joins the 9-table majority rather than the preservation family, which lacks this. A batch is
-- long-lived and its whole value is provenance; a mid-flight owner flip would silently rewrite it.
CREATE TRIGGER prevent_ownership_transfer BEFORE UPDATE ON public.kitchen_batch
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ownership_transfer();

-- The Going-now query: open batches, newest start first, unknown starts LAST. NULLS LAST is not
-- cosmetic — SavedSeeds.jsx:594-613 already ruled it for the sibling surface, "unknown must not
-- outrank a measured one at the top of a 'check this' list".
CREATE INDEX idx_kitchen_batch_open ON public.kitchen_batch (user_id, started_at DESC NULLS LAST)
  WHERE closed_at IS NULL AND deleted_at IS NULL;

-- ── 2. fan-in: harvests AND non-garden inputs, ONE table ─────────────────────────────────────────
-- ONE table, discriminated — not two. "What went into this batch" must be answerable with one join,
-- or the UI shows the peppers and silently omits the salt.
--
-- source_kind IS DELIBERATELY NOT REUSED for the non-garden case. preservation_log.source_kind
-- answers "where did the PRODUCE come from" for that row's single subject, and it is coupled to
-- plant_id by chk_preservation_log_source_plant. Salt is not a provenance of the peppers; it is a
-- different entity in the jar.
CREATE TABLE public.kitchen_batch_input (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES public.kitchen_batch(id) ON DELETE CASCADE,
  input_kind     text NOT NULL,

  -- RESTRICT, NOT CASCADE, NOT SET NULL — and the FK is only half the protection.
  -- archive_plant_events HARD-DELETES harvest_log rows (into harvest_log_archive as jsonb). CASCADE
  -- would silently destroy a batch's provenance with no archive to recover from. SET NULL would
  -- leave a row saying "something went in" that cannot say what — unlike preservation_log's single
  -- optional link, this column is half the row's identity. RESTRICT alone would abort an archive
  -- with a bare 23503, which is exactly the failure Guard 2 exists to avoid. Hence Guard 4 in
  -- 0c-guard.sql, which MUST be applied with this file.
  harvest_log_id uuid REFERENCES public.harvest_log(id) ON DELETE RESTRICT,

  label          text,     -- required for every non-harvest input: 'Kosher salt', 'Cider vinegar'

  -- QUANTITY ON THE LINK, and it is not optional decoration. Dave's own crucible-hardened
  -- unsweet-watermelon guide already adjudicated this: "Rind is not a new harvest. It's a byproduct
  -- of fruit you already counted. Weigh it as an input to the preservation batch, never as a second
  -- harvest, or the season report double-counts every ripe melon." What goes into a batch is often a
  -- FRACTION of, and physically distinct from, the thing harvested.
  qty            numeric,
  qty_unit       text,
  -- TRUE when this input is an offcut of a harvest counted elsewhere (rind, peel, trimmings). The
  -- flag is what lets a future roll-up avoid double-counting without re-litigating each row.
  is_byproduct   boolean NOT NULL DEFAULT false,

  added_at       timestamptz NOT NULL DEFAULT now(),
  note           text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_kbi_kind CHECK (input_kind = ANY (ARRAY['harvest','purchased','pantry','other'])),
  -- Biconditional, not two one-way checks: a harvest row MUST carry the FK and a non-harvest row
  -- MUST NOT, so the discriminator can never disagree with the data.
  CONSTRAINT chk_kbi_harvest_pairing CHECK ((input_kind = 'harvest') = (harvest_log_id IS NOT NULL)),
  CONSTRAINT chk_kbi_label_required CHECK (
    input_kind = 'harvest' OR (label IS NOT NULL AND btrim(label) <> '')),
  -- Only a harvest can be a byproduct of one.
  CONSTRAINT chk_kbi_byproduct_needs_harvest CHECK (
    is_byproduct = false OR input_kind = 'harvest'),
  -- House idiom (chk_harvest_log_weight_pairing): a NULL pair means "unrecorded, assume the whole
  -- thing", which is honest for someone who does not weigh. It never means zero.
  CONSTRAINT chk_kbi_qty_pairing CHECK ((qty IS NULL) = (qty_unit IS NULL)),
  CONSTRAINT chk_kbi_qty_positive CHECK (qty IS NULL OR qty > 0),
  -- CHECK'd on purpose. preservation_log.quantity_unit is the ONE unit column in this family with no
  -- vocabulary constraint and it has ALREADY drifted — it stores 'quarts'/'cups' while
  -- harvest_log_unit_check spells the same unit 'qt' (filed as BUG-PRESERVUNITNOCHECK-001). Do not
  -- inherit that.
  CONSTRAINT chk_kbi_qty_unit CHECK (qty_unit IS NULL OR qty_unit = ANY (ARRAY[
    'g','kg','oz','lb','count','cup','tbsp','tsp','fl oz','qt','gal','ml','l','other']))
);

CREATE INDEX idx_kbi_batch ON public.kitchen_batch_input (batch_id, added_at DESC, id DESC);
-- Required by Guard 4, which looks up harvest -> batch. preservation_log has NO equivalent index on
-- harvest_log_id, so its Guard 3 seq-scans; do not replicate that.
CREATE INDEX idx_kbi_harvest ON public.kitchen_batch_input (harvest_log_id)
  WHERE harvest_log_id IS NOT NULL;
-- A pick cannot be added to the same batch twice.
CREATE UNIQUE INDEX uq_kbi_batch_harvest ON public.kitchen_batch_input (batch_id, harvest_log_id)
  WHERE harvest_log_id IS NOT NULL;

-- ── 3. the stage log — append-only, and the ONLY source of current stage ─────────────────────────
-- SPLIT AXIS, deliberately unlike seed_lot_stage_log. stage_kind is small, stable, and is what the
-- code branches on; label is free text and is what grows. seed_lot_stage_log froze its entire
-- vocabulary in a CHECK on a table with a deployed writer and NO delete route, which is what forced
-- the off-log repair path that produced the divergence this design refuses to copy.
--
-- AND IT MUST REPRESENT A LOOP. Candying's syrup phase is ONE stage occurring three times with an
-- incrementing parameter (600 g, +150 g, +150 g), and the occurrence count is 3 for half-inch
-- watermelon-rind batons but 6-12 for whole fruit — not knowable when the batch starts. A fixed
-- ordered enum where each stage occurs once encodes candying as impossible. Rows with parameters
-- give repetition, reversal and suspension for free.
--
-- ORDER IS NOT MONOTONIC, and consumers must not assume it is. Three of six documented candy
-- recoveries RE-ENTER the sequence ("return briefly to warm syrup", "re-melt", "rinse, re-dry,
-- re-dust"), so a `tended` row legitimately appears after a `finished` one.
CREATE TABLE public.kitchen_stage_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid NOT NULL REFERENCES public.kitchen_batch(id) ON DELETE CASCADE,
  stage_kind          text NOT NULL,
  label               text,      -- 'syrup rung 2', 'blended', 'skimmed'
  -- The repeated stage's incrementing parameter. 'syrup rung 2' with amount 150 g is the whole
  -- candying case; without these two columns it is a note nothing can read.
  amount              numeric,
  amount_unit         text,
  -- EVERY CONSEQUENTIAL TRANSITION IS DECIDED BY AN OBSERVED CUE, NOT A CLOCK, and the project's own
  -- candy guide says so verbatim: "A doneness cue overrides a stated time" and "If the two cues
  -- disagree, translucency wins — pull the pot." Recording only entered_at records the LESS
  -- authoritative half of each transition. Free text is enough.
  cue_observed        text,
  entered_at          timestamptz NOT NULL DEFAULT now(),
  -- PLACEMENT IS A RATE INPUT, NOT A MILESTONE — it lives here rather than on the batch so current
  -- location derives from the same LATERAL as current stage (one derivation, one truth). Moving a
  -- ferment to the fridge does not advance it; it approximately STOPS it.
  storage_location_id uuid REFERENCES public.storage_location(id),
  photo_id            uuid REFERENCES public.photos(id) ON DELETE SET NULL,
  note                text,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_ksl_stage_kind CHECK (stage_kind = ANY (ARRAY[
    'started','tended','moved','finished','failed'])),
  CONSTRAINT chk_ksl_moved_needs_location CHECK (
    stage_kind <> 'moved' OR storage_location_id IS NOT NULL),
  CONSTRAINT chk_ksl_label_nonblank CHECK (label IS NULL OR btrim(label) <> ''),
  CONSTRAINT chk_ksl_amount_pairing CHECK ((amount IS NULL) = (amount_unit IS NULL)),
  CONSTRAINT chk_ksl_amount_positive CHECK (amount IS NULL OR amount > 0)
);

-- `id DESC` is the deterministic tiebreak seed_lot_stage_log LACKS: two rows written in one
-- statement tie on entered_at AND created_at, leaving "current" nondeterministic. A "topped up +
-- skimmed" double-tap hits it. Every ORDER BY against this table uses this exact key.
CREATE INDEX idx_ksl_batch ON public.kitchen_stage_log (batch_id, entered_at DESC, id DESC);

-- ── 4. fan-out ───────────────────────────────────────────────────────────────────────────────────
-- SET NULL matches harvest_log_id's precedent: a jar outlives the batch record.
--
-- ⚠ batch_id IS DELIBERATELY NOT ADDED TO PRESERVATION_EDITABLE_COLUMNS
-- (lambda/preservation/provenance.js:33) — that constant is the declared single source of truth for
-- FOUR hand-lists, one of which (buildFullPayload) lives in the FRONTEND. If batch_id joined it, the
-- full-replace PUT would let a "Mark used" tap from a service-worker-cached bundle NULL a batch's
-- output link and return 200. That is the exact failure the preserved_at_approx COALESCE at
-- index.js:597-604 was written to prevent. It is set once, by the batch close-out route.
ALTER TABLE public.preservation_log
  ADD COLUMN batch_id uuid REFERENCES public.kitchen_batch(id) ON DELETE SET NULL;

CREATE INDEX idx_preservation_log_batch ON public.preservation_log (batch_id)
  WHERE batch_id IS NOT NULL;

-- Two paths to one provenance fact is a two-truths structure. A jar either came from a batch (whose
-- inputs live on the batch) or directly from one harvest — never both. Verified vacuous before
-- arming: gates.yml pre_preservation_one_provenance_vacuous asserts all live rows already satisfy it.
ALTER TABLE public.preservation_log
  ADD CONSTRAINT chk_preservation_log_one_provenance
  CHECK (batch_id IS NULL OR harvest_log_id IS NULL);

-- ── 5. the ONE read surface for current state ────────────────────────────────────────────────────
-- Every consumer reads this view, never the tables. That is what makes "no cache" survivable: one
-- derivation instead of N, so there is nothing to diverge. If a cache is ever genuinely needed it is
-- added as a TRIGGER-maintained column with no app write path — never a second writable one.
CREATE VIEW public.v_kitchen_batch_current AS
SELECT b.*,
       s.stage_kind          AS current_stage_kind,
       s.label               AS current_stage_label,
       s.entered_at          AS current_stage_entered_at,
       s.storage_location_id AS current_storage_location_id,
       (SELECT count(*) FROM public.kitchen_batch_input i WHERE i.batch_id = b.id)  AS input_count,
       (SELECT count(*) FROM public.preservation_log p
         WHERE p.batch_id = b.id AND p.deleted_at IS NULL)                          AS output_count
  FROM public.kitchen_batch b
  LEFT JOIN LATERAL (
       SELECT sl.stage_kind, sl.label, sl.entered_at, sl.storage_location_id
         FROM public.kitchen_stage_log sl
        WHERE sl.batch_id = b.id
        ORDER BY sl.entered_at DESC, sl.id DESC
        LIMIT 1
  ) s ON TRUE
 WHERE b.deleted_at IS NULL;

-- schema_version.description is NOT NULL with no default — omitting it fails the apply
-- mid-transaction. Caught by the prod dry-run, which is what the dry-run is for.
INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.110.0-inflightbatch-001',
        'INFLIGHTBATCH: kitchen_batch / kitchen_batch_input / kitchen_stage_log + '
        'preservation_log.batch_id + v_kitchen_batch_current. An object for a food process that is '
        'underway. Companion 0c adds Guard 4 to archive_plant_events.',
        now())
ON CONFLICT (version) DO UPDATE
  SET description = EXCLUDED.description, applied_at = EXCLUDED.applied_at;

COMMIT;

-- Verify:
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema='public' AND table_name LIKE 'kitchen%' ORDER BY 1;
--   SELECT conname FROM pg_constraint
--    WHERE conrelid IN ('public.kitchen_batch'::regclass,
--                       'public.kitchen_batch_input'::regclass,
--                       'public.kitchen_stage_log'::regclass) ORDER BY 1;
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='preservation_log' AND column_name='batch_id';
--   SELECT count(*) FROM public.v_kitchen_batch_current;
