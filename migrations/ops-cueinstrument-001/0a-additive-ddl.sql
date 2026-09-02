-- 0a-additive-ddl.sql
-- OPS-CUEINSTRUMENT-001 — public.weather_cue_impression.
--
-- NOT APPLIED as of authoring (2026-09-02). This lane executed no DDL anywhere — not on staging, not
-- on prod. Apply order per gates.yml: staging -> rehearse 0r -> re-apply -> prod -> dev push ->
-- promote. CI's integration job branches off STAGING WITHOUT applying migrations, so this must land
-- on staging BEFORE the dev push or the writer's integration coverage reads as infra flake rather
-- than a missing relation.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS A PRECONDITION OF THE RENDER, NOT A FOLLOW-UP
--
-- V5-WXCALLOUTRENDER-001 puts the daily weather cue on Today. The stated purpose of that render is
-- to find out whether Dave acts on a surfaced weather line. Without a row per rendered cue there is
-- no denominator: a cue that was shown and correctly ignored is indistinguishable from a cue that
-- never fired, and every later precision claim about the surface is unfalsifiable.
--
-- The app has already run exactly this experiment and lost the instrument. public.ready_impression
-- logged 112 impressions over 6 days (2026-08-18 -> 08-24) and was then removed as collateral of
-- V4-WEIGHQUEUEKILL-001, with the in-tree note that any future precision claim about that surface
-- has lost its instrument. Mining the surviving six days produced the only real evidence anyone has
-- about whether Dave acts on a surfaced cue (crop-level conversion 81.3% against a ~39.6% base rate;
-- plant-level 6.6%). That is what a six-day instrument bought, and what its absence costs.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- SHAPE: MIRRORS public.watch_impression (v4-watchimpression-001), WITH THREE DELIBERATE DEVIATIONS
--
-- Kept verbatim from that table, for the same reasons its own DDL gives:
--   * bigint GENERATED ALWAYS AS IDENTITY surrogate — impression rows are never addressed
--     individually by anything (no undo, no client route, no cross-system reference), so an 8-byte
--     ascending key keeps the PK index small on the highest-write-rate table in the family.
--   * user_id text NOT NULL, and NO created_by. The V4-OWNERSHIP-001 transfer trigger fires on
--     created_by across 9 tables and reads a NULL -> value write as an ownership transfer; user_id
--     records WHO WAS SERVED, which is not an ownership claim. Do not add created_by "for auditing".
--   * shown_on date NOT NULL — the ET CIVIL DAY (America/New_York), stamped SERVER-side, not the
--     write instant and not the client's clock. A timestamptz here would compile, write and read
--     fine while silently re-anchoring the dedupe grain to UTC.
--   * A UNIQUE natural key + ON CONFLICT DO NOTHING in the writer. Dave opens Today many times a
--     day; without the guard, "impressions per day" would measure phone-checking frequency.
--   * model_version text NOT NULL — the partition key that joins numerator to denominator within
--     one model generation and never across two.
--   * CHECK'd closed vocabularies on every categorical column, and lean indexing (one secondary
--     index, chosen for the analysis read shape rather than on a guess).
--
-- DEVIATION 1 — NO plant_id, AND THEREFORE NO FK. watch_impression's grain is one planting served;
-- this surface's grain is one GARDEN-WIDE weather statement. computeCallout takes weather and
-- hydrology and names no planting at all, so a plant_id column here would have to be invented, and
-- an invented key is worse than an absent one because it gets joined.
--
-- DEVIATION 2 — NO region AND NO slot. Those columns exist on watch_impression because a served list
-- has visible and collapsed parts and "served" is not "seen". This surface renders AT MOST ONE line
-- (engine.js computeCallout is priority-ordered and returns a single cue or null), unconditionally
-- visible, above the fold, with no disclosure to expand. There is no tail to be honest about.
--
-- DEVIATION 3 — TWO COLUMNS THIS SURFACE NEEDS THAT THAT ONE DOES NOT HAVE:
--
--   form   which rendering FORM was served. V5-WXCALLOUTRENDER-001 renders heat/rain/wet in
--          check-form and freeze/cold imperatively, because on 4 of 34 archived cue-days the cue
--          first existed only at the 15:30 run — after the action window, on a surface read at
--          08:00 — while freeze/cold are deterministic on tonight's low and so are not stale at
--          08:00. That split is a live design claim about how Dave reads the line. Recording the
--          form is what makes it MEASURABLE instead of assumed, and what lets a later change of
--          form read as a change rather than silently pooling two populations into one rate.
--
--   plan_generated_at   WHICH nightly run produced the cue. This is the staleness coordinate the
--          form split exists because of: a cue whose plan was generated at 15:30 was never on
--          screen inside its own action window for a reader who opens Today at 08:00. Nullable —
--          it is client-supplied (from the read model's own generated_at) and a client that omits
--          or garbles it should cost one column, not the row.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY cue IS IN THE UNIQUE KEY
--
-- UNIQUE (user_id, shown_on, cue). Only one cue can be live at a time, but the plan is regenerated
-- several times a day and a regeneration can legitimately change WHICH cue is live (a morning 'rain'
-- becoming an afternoon 'wet'). One row per cue per day records that both were shown that day; a
-- key without it would silently keep only the first and make the day look like it had one cue when
-- it had two. Same reasoning watch_impression gives for keeping region in its key.
--
-- Growth is bounded structurally at (users x 5) rows per day — single digits per day, forever.
--
-- CHECK BLAST RADIUS. Unlike the batch writers in this family, this one inserts a SINGLE row per
-- request, so a CHECK violation costs one impression rather than a whole day's batch. The
-- vocabularies are still pinned: cue is closed at engine.js computeCallout's five icons, form at the
-- render's two. Adding a sixth rule to computeCallout requires widening cue_chk FIRST — an
-- unwidened CHECK would drop exactly the new rule's impressions and nothing else, which is the
-- shape of a silent measurement hole.

BEGIN;

CREATE TABLE IF NOT EXISTS public.weather_cue_impression (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- WHO WAS SERVED the cue. Clerk sub. Not created_by — see the ownership note above. The daily plan
  -- is written per user_id (Dave's and Jen's differ), so the impression is per-user too.
  user_id       text        NOT NULL,

  -- The ET CIVIL DAY the cue was rendered — America/New_York, stamped from the server's clock in the
  -- writer, never from the request body. A phone with a skewed clock, or a tab left open across
  -- midnight, would otherwise corrupt the dedupe grain the whole design rests on.
  shown_on      date        NOT NULL,

  -- engine.js computeCallout's `icon` — the RULE that fired, not a glyph name. Closed vocabulary.
  cue           text        NOT NULL,

  -- 'check' or 'imperative' — the form the line was actually rendered in.
  form          text        NOT NULL,

  -- src/lib/weatherCue.js WX_CUE_MODEL_VERSION as served, mirrored server-side as the fallback for a
  -- request that omits it. Same role as watch.js WATCH_MODEL_VERSION on the watch table.
  model_version text        NOT NULL,

  -- The daily_plan.generated_at of the plan the cue came from: which nightly run produced it. With
  -- shown_on this answers "was this cue on screen inside its own action window?" without re-deriving
  -- it from a plan row that has since been overwritten by a later run of the same day.
  plan_generated_at timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Closed at engine.js computeCallout. Widen BEFORE adding a sixth rule there, never after.
  CONSTRAINT weather_cue_impression_cue_chk
    CHECK (cue IN ('freeze', 'cold', 'heat', 'rain', 'wet')),
  CONSTRAINT weather_cue_impression_form_chk
    CHECK (form IN ('imperative', 'check')),

  -- The dedupe guard the writer's ON CONFLICT names. A plain UNIQUE constraint, not a partial index:
  -- nothing here is soft-deleted, so the natural key needs no WHERE clause — and a constraint keeps
  -- the conflict target a column list, which cannot be quietly re-arbitrated by a second index.
  CONSTRAINT uq_weather_cue_impression_day UNIQUE (user_id, shown_on, cue)
);

-- ONE secondary index. The analysis read shape is the per-cue time series — "every day the 'rain'
-- cue was shown, joined to what was logged that day" — which is exactly (cue, shown_on). The UNIQUE
-- constraint's index (user_id leading) already serves the writer's conflict check and any per-user
-- scan. NO model_version index: the refit filters model_version after the per-cue read, and an
-- unused index is pure write cost. Mirror the dismissal table's (model_version, observed_on) index
-- later WITH a query plan to justify it, not on a guess.
CREATE INDEX IF NOT EXISTS idx_weather_cue_impression_cue_day
  ON public.weather_cue_impression (cue, shown_on);

COMMENT ON TABLE public.weather_cue_impression IS
  'OPS-CUEINSTRUMENT-001. One row per weather cue RENDERED on Today, per user per ET civil day — '
  'the denominator V5-WXCALLOUTRENDER-001 needs to be a test that can fail (public.ready_impression '
  'was the last instrument of this kind and was removed with V4-WEIGHQUEUEKILL-001). Written '
  'non-fatally by POST /api/daily-plan/cue-impressions; deduped per day by '
  'uq_weather_cue_impression_day + ON CONFLICT DO NOTHING. Shape mirrors public.watch_impression '
  'minus plant_id/region/slot (this surface renders one garden-wide line, not a ranked list) plus '
  'form and plan_generated_at. Partition by model_version, never across.';

COMMENT ON COLUMN public.weather_cue_impression.shown_on IS
  'ET civil day (America/New_York) the cue was rendered — server-stamped, not UTC, not the client clock.';
COMMENT ON COLUMN public.weather_cue_impression.cue IS
  'The computeCallout rule that fired: freeze | cold | heat | rain | wet. Closed vocabulary — widen the CHECK before adding a rule.';
COMMENT ON COLUMN public.weather_cue_impression.form IS
  'How the line was worded: check = "did this get done?", imperative = a command. freeze/cold render '
  'imperative (deterministic on tonight''s low); the rest render check-form because the cue can first '
  'exist at the 15:30 run, after its own action window.';
COMMENT ON COLUMN public.weather_cue_impression.plan_generated_at IS
  'daily_plan.generated_at of the plan the cue came from — which nightly run produced it. NULL when the client omitted it.';

COMMIT;
