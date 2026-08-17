-- 0a-additive-ddl.sql
-- V4-READYTRAYIMPRESSION-001 — public.ready_impression.
-- Canon: _lane_reports/dismissal-recon-20260816b.md "PROPOSED MINIMAL DESIGN → Option 1", with the
-- recon's blocking precondition resolved by Dave this session, verbatim: "I use it regularly. I
-- love it." (the harvest-session chip tray, /log?session=harvest).
--
-- NOT APPLIED as of authoring (2026-08-17). This lane executed no DDL anywhere — not on staging,
-- not on prod. Apply order per gates.yml: staging -> rehearse 0r -> re-apply -> prod -> dev push ->
-- promote. CI's integration job branches off STAGING WITHOUT applying migrations, so this must land
-- on staging BEFORE the dev push or the writer's coverage reads as infra flake rather than a
-- missing relation.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS TABLE IS — "SHOWN AND NOT PICKED", WITHOUT A DISMISSAL BUTTON
--
-- The weigh-in tray offers up to 14 plantings at the top of /log?session=harvest. Whether a chip
-- gets tapped is already the signal "was this the right thing to surface" — it needs NO reject
-- control, and the recon (§D) argues at length that a "not yet" button on a SEEDING tray would be
-- UX noise in a flow the user entered specifically to log harvests. So the negative label is
-- derived, not captured: this table is the denominator, and the numerator is an anti-join against
-- the harvests actually logged that ET day (the exact query is in the lane report).
--
-- The companion table public.watch_impression (V4-WATCHIMPRESSION-001) does the same job for the
-- Today watch band. This one is deliberately NOT that table — see WHY A SECOND TABLE below.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY A SECOND TABLE AND NOT A WIDENED watch_impression
--
-- The recon leaned toward widening (add 'ready_tray' to watch_impression_region_chk plus a nullable
-- source column) on cost grounds, and flagged that it could reasonably go the other way. It goes
-- the other way, for four reasons that are about correctness and blast radius, not taste:
--
--   1. THE SNAPSHOT COLUMNS ARE DISJOINT, NOT SHARED. watch_impression freezes anchor_kind +
--      check_from because the watch model's claim is "a watch opened on date X via tier Y". This
--      surface's model has no anchor and no tier: rankHarvestReady's claim is "this planting is
--      overdue_ratio R past a repeat_interval_days I cadence". Widening means two columns that are
--      always NULL for ready rows plus three that are always NULL for watch rows — a two-entity
--      table with a growing NULL matrix, and no single row shape that is ever fully populated.
--
--   2. THE SHARED CHECK IS A SHARED FAILURE DOMAIN, and watch_impression's own DDL says so:
--      "The writer batch-inserts a whole response in ONE statement, so a CHECK violation drops the
--      entire day's batch (non-fatally...). That is why only two vocabularies are pinned and
--      nothing speculative." Putting a second, independently-evolving region vocabulary behind that
--      same constraint means a future ready-side region value is a migration against the constraint
--      the WATCH batch validates against. Two writers, one constraint, one batch-drop.
--
--   3. APPLY COST INVERTS THE COST ARGUMENT. Widening a CHECK is DROP CONSTRAINT + ADD CONSTRAINT,
--      which takes ACCESS EXCLUSIVE on a table the Today GET writes on every load (259 live rows
--      and growing, measured on prod 2026-08-17). CREATE TABLE takes no lock on anything that
--      exists. The "cheaper" option is the one with the availability cost.
--
--   4. IT IS RECON §7d's OWN ARGUMENT, TRANSPLANTED. §7d rejects putting ready-scoped DISMISSALS in
--      harvest_watch_dismissal because the two would be indistinguishable and would "silently
--      contaminate the watch calibration dataset the table was built for". watch_impression IS that
--      dataset's denominator. A refit that forgets `AND region <> 'ready_tray'` would silently
--      inflate it. A separate relation makes that mistake impossible rather than merely detectable.
--
-- What a separate table costs: one CREATE TABLE and one ~40-line writer. What it does NOT cost: the
-- analysis still joins the two by (user_id, plant_id, shown_on) whenever a cross-surface question
-- is asked, because both tables carry that key in the same types with the same ET-civil-day grain.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- REGION SEMANTICS — SHOWN, NOT MERELY OFFERED
--
-- V4-HARVTRAYVIEWPORT-001 gave the tray a collapse: it renders HARVEST_TRAY_COLLAPSED_MAX chips and
-- puts the rest behind an explicit "Show N more". That disclosure is what makes the region column
-- necessary here — without it every rate would be computed over chips that were never on a screen.
--
--   tray       rendered in the collapsed tray at first paint — on screen with no user action. This
--              is the region a precision claim may be computed over.
--   tray_tail  in the merged list but behind the Show-N-more disclosure. SERVED, NOT NECESSARILY
--              SEEN — exactly watch_impression's 'tail' semantics, and exactly as honest about it:
--              there is no beacon on the expand tap in v1, so a rate over tray_tail is a rate over
--              opportunities, not views, and must say so.
--
-- The split is computed by the CLIENT calling its own selectTrayChips() — the same function that
-- decides what renders — so the label cannot drift from the pixels the way a server-side mirror of
-- a client walk can (that is the standing lockstep hazard on watch_impression's region split).
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- SOURCE SEMANTICS — THE PREREQUISITE THE RECON CALLED BLOCKING (§7c)
--
-- The tray is a MERGE of two producers: rankHarvestReady over /api/events/harvest-ready candidates,
-- and a recent-harvest fallback appended for plantings the strict readiness model misses
-- (BUG-HARVTRAYEMPTY-001). Before this migration the client flattened both into one array with no
-- provenance flag, so an impression could not distinguish "the readiness MODEL surfaced this" from
-- "the recency FALLBACK surfaced this" — which is the whole discrimination any precision claim
-- about the model needs. source is that flag, and it is NOT NULL: an unlabelled impression is worse
-- than no impression, because it silently averages the two populations.
--
--   ready   produced by rankHarvestReady (model row; carries the frozen model columns below)
--   recent  produced by the recent-harvest fallback (no model claim; frozen columns are NULL)
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THE UNIQUENESS GUARD IS DAY-GRAINED
--
-- UNIQUE (user_id, plant_id, shown_on, region) + ON CONFLICT DO NOTHING, adopted wholesale from
-- watch-route.js:525-528: without the day grain, "impressions per day" would measure how often the
-- user opens the flow, not exposure. Dave can enter a weigh-in session several times in an evening;
-- N entries collapse to one row per chip per region.
--
-- region is IN the key for the same reason it is there: a chip legitimately moves between regions
-- across two sessions in one day (queueing four plantings pushes others behind the disclosure), and
-- one row per region per day records that both statements were true that day. That also fixes the
-- hard growth bound at 2 rows per chip per day.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- COLUMN CONVENTIONS INHERITED FROM watch_impression, DELIBERATELY AND NOT BY COPY-PASTE:
--   * id bigint IDENTITY, not uuid — impression rows are never addressed individually (no undo, no
--     client route, no cross-system reference); the natural key is the UNIQUE constraint.
--   * NO created_by COLUMN. The V4-OWNERSHIP-001 transfer trigger fires on created_by across 9
--     tables and reads NULL -> value as an ownership transfer. user_id records WHO WAS SHOWN the
--     tray, which is not an ownership claim, and naming it user_id keeps this table entirely
--     outside that machinery. created_at + user_id already say everything an audit could ask.
--   * shown_on is a DATE in America/New_York, stamped SERVER-side inside the INSERT. Not from the
--     client (an unsynced phone clock would corrupt the dedupe grain) and not UTC (that splits one
--     evening's session across two "days" for five hours every night).

BEGIN;

CREATE TABLE IF NOT EXISTS public.ready_impression (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- WHO WAS SHOWN the tray. Clerk sub. Not created_by — see the ownership note above.
  user_id       text        NOT NULL,
  plant_id      uuid        NOT NULL REFERENCES public.plants(id),

  -- ET CIVIL DAY (America/New_York) the tray was rendered.
  shown_on      date        NOT NULL,

  -- 1-based display position WITHIN the region, in tray order (which is rankHarvestReady's order
  -- for the 'ready' block, then the fallback's). NOT NULL: unlike watch_impression's snoozed rows,
  -- every row here has a real position — the tray is a ranked list end to end.
  slot          smallint    NOT NULL,

  region        text        NOT NULL,
  source        text        NOT NULL,

  -- The CLIENT's ranking-model version (src/lib/harvestReadiness.js READY_MODEL_VERSION), not the
  -- server's. This surface ranks in the browser — the server cannot reconstruct a card's slot — so
  -- the build that made the claim is the honest provenance, and the Lambda mirrors the constant
  -- only as the fallback for a request that omits it.
  model_version text        NOT NULL,

  -- THE MODEL'S CLAIM, FROZEN AS SHOWN. Same rationale as watch_impression's anchor_kind/check_from
  -- and harvest_watch_dismissal's snapshot: recomputing later reads corrected reference data and
  -- mutable pick history, so a calibration fit would train on values the user never saw. All three
  -- are NULL for source='recent', which has no model claim to freeze.
  --   overdue_ratio           days_since_last_harvest / repeat_interval_days, the rank coordinate
  --   days_since_last_harvest as served by /api/events/harvest-ready
  --   repeat_interval_days    the crop cadence the model measured against
  overdue_ratio numeric(8,3),
  days_since_last_harvest smallint,
  repeat_interval_days    smallint,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ready_impression_region_chk
    CHECK (region IN ('tray', 'tray_tail')),
  CONSTRAINT ready_impression_source_chk
    CHECK (source IN ('ready', 'recent')),
  -- A model row must carry its claim and a fallback row must not: without this, a client bug that
  -- dropped the frozen columns would produce a table that still looks fine and silently answers
  -- every calibration question with NULLs.
  CONSTRAINT ready_impression_snapshot_chk
    CHECK (
      (source = 'recent' AND overdue_ratio IS NULL
                         AND days_since_last_harvest IS NULL
                         AND repeat_interval_days IS NULL)
      OR (source = 'ready' AND overdue_ratio IS NOT NULL)
    ),

  -- The dedupe guard the writer's ON CONFLICT names. A plain UNIQUE constraint, not a partial
  -- index: nothing here is soft-deleted, and a constraint keeps the conflict target a column list,
  -- which cannot be quietly re-arbitrated by a second index the way an index-name target can.
  CONSTRAINT uq_ready_impression_day UNIQUE (user_id, plant_id, shown_on, region)
);

-- LEAN INDEXING, one secondary index only — same read shape as watch_impression's: the per-plant
-- time series ("every day planting P was offered, joined to its eventual pick"), which is exactly
-- (plant_id, shown_on). The UNIQUE constraint's index (user_id leading) serves the writer's
-- conflict check and any per-user scan. No source/model_version index on a guess.
CREATE INDEX IF NOT EXISTS idx_ready_impression_plant_day
  ON public.ready_impression (plant_id, shown_on);

COMMENT ON TABLE public.ready_impression IS
  'V4-READYTRAYIMPRESSION-001. One row per planting SHOWN in the harvest-session weigh-in tray '
  '(/log?session=harvest) per region per user per ET civil day — the denominator for "shown and '
  'not picked", derived by anti-joining harvests logged that day. NO dismissal UI exists or is '
  'planned for this surface (recon §D): the absence of a tap IS the negative signal. Written '
  'non-fatally by POST /api/harvests/ready-impressions; deduped per day by uq_ready_impression_day '
  '+ ON CONFLICT DO NOTHING. region=tray_tail means offered but behind the Show-N-more disclosure, '
  'NOT necessarily seen. Deliberately separate from public.watch_impression — disjoint snapshot '
  'columns and a shared CHECK would be a shared batch-failure domain; see 0a-additive-ddl.sql.';

COMMENT ON COLUMN public.ready_impression.shown_on IS
  'ET civil day (America/New_York) the tray rendered — stamped server-side in the INSERT, never from the client clock.';
COMMENT ON COLUMN public.ready_impression.region IS
  'tray = rendered in the collapsed tray at first paint (shown). tray_tail = behind the Show-N-more '
  'disclosure (offered, not necessarily seen — no expand beacon in v1).';
COMMENT ON COLUMN public.ready_impression.source IS
  'ready = surfaced by rankHarvestReady (the readiness model). recent = surfaced by the '
  'recent-harvest fallback (BUG-HARVTRAYEMPTY-001). Never average the two.';
COMMENT ON COLUMN public.ready_impression.model_version IS
  'src/lib/harvestReadiness.js READY_MODEL_VERSION as the CLIENT build sent it — this surface ranks '
  'client-side, so the browser owns the model identity. Partition by it; never join across.';
COMMENT ON COLUMN public.ready_impression.overdue_ratio IS
  'days_since_last_harvest / repeat_interval_days as shown — the rank coordinate, frozen. NULL for source=recent.';

COMMIT;
