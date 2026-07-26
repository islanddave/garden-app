-- 0a-additive-ddl.sql
-- V4-PUTUPPROV-001 — Put-Up PROVENANCE. Lets a put-up record produce that was NOT grown here
--   (bought frozen peaches, a farm-stand half-bushel, a u-pick orchard run) without attributing it
--   to a planting that never existed. Canon: putup-provenance-plan-V101-20260726.md.
--
-- SCOPE: two nullable columns on preservation_log + five new CHECKs + ONE widened existing CHECK.
--   Touches no other table, no view, no index.
--
-- DESIGN DECISIONS THIS DDL ENCODES:
--
--   * D1-a — source_kind is a TEXT column with a CHECK, *not* a Postgres ENUM. Widening a CHECK is
--     DROP + ADD (cheap, reversible, twice-precedented here: v3-status-001, v4-flag-issue); widening
--     an ENUM via ALTER TYPE is neither cleanly transactional nor removable.
--     Vocabulary is EIGHT values. `u_pick` is in because Franklin County put-up from mid-Aug to late
--     Oct runs on pick-your-own, which is neither own_garden nor farm_stand, and "I picked it myself
--     at Clarkdale inside a two-week window" is the fact worth having six months later.
--     `traded`/`plant_swap` is deliberately OUT even though plants.source_type gained it: a swapped
--     PLANT is a lineage fact, swapped PRODUCE behaves identically to a gift on a freezer inventory.
--
--     >>> HOW TO ADD A VALUE LATER — READ THIS BEFORE YOU REACH FOR DROP CONSTRAINT. <<<
--     WIDEN this CHECK (DROP + ADD with the longer list). Do NOT drop it and go free-text.
--     v4-source-freetext did exactly that to plants.source_type on 2026-07-07 — "so new source
--     options store without a schema change" — and the vocabulary fragmented. That reversal happened
--     because dropping looked cheaper than migrating, and it only looked that way because nobody had
--     written down that widening was the sanctioned move. It is. This is that note.
--     The escape hatch is what makes a closed vocabulary safe here: `other` + source_label means an
--     unforeseen source NEVER blocks a save, so there is never schedule pressure to drop the CHECK.
--     OSSIFICATION GUARD: when
--       SELECT count(DISTINCT btrim(lower(source_label))) FROM preservation_log WHERE source_kind='other'
--     exceeds 3, review for a widen — `other` is meant to be a waiting room, not a destination.
--
--   * D1-b — NULLABLE, NO DEFAULT. NULL means "unrecorded", never "own_garden".
--     A NOT NULL DEFAULT 'own_garden' was rejected on three grounds:
--       (i)  Its only real advantage — turning a dropped column into a loud 23502 instead of a silent
--            wipe — evaporates once the PUT is COALESCE-preserving (see 0-d in the Lambda), which it
--            now is. So the advantage buys nothing and the honesty cost remains.
--       (ii) From August through October the MAJORITY of put-up rows will be bought-in. A DB-level
--            default of own_garden is a false-provenance generator during exactly the season this
--            feature exists for: a stale cached bundle POSTing without the key would stamp
--            "grown in Dave's garden" as fact.
--       (iii) This project already gate-enforces the pattern — v4-harvattr-001/gates.yml asserts
--            is_nullable='YES' AND column_default IS NULL across six columns precisely to make
--            NULL=UNKNOWN structural rather than conventional. Same table family, same norm.
--     NO BACKFILL. The single pre-existing row stays NULL. We can infer from its non-null plant_id
--     that it was garden-grown, but recording that adds nothing (reads render nothing for NULL, so
--     the row looks identical either way) and a post gate asserts no pre-existing row acquired
--     invented provenance.
--     CONSEQUENCE: every CHECK below is born-valid on the existing data, so there is NO
--     NOT VALID / backfill / VALIDATE dance and NO 0c-validate.sql — same reasoning v4-putup-001
--     documents for its own inline CHECKs, reached by a different route.
--
--   * D1-c — the other-requires-label CHECK is written NULL-SAFE, and this is not pedantry.
--     The obvious form —  CHECK (source_kind <> 'other' OR btrim(source_label) <> '')  — DOES NOT
--     WORK. With source_kind='other' and source_label IS NULL it evaluates FALSE OR NULL = NULL, and
--     Postgres ACCEPTS a CHECK that evaluates to NULL (only FALSE rejects). It would permit exactly
--     the case it exists to prevent. chk_preservation_log_method_other gets this right by carrying an
--     explicit IS NOT NULL conjunct; we use IS DISTINCT FROM + COALESCE to the same end.
--
--   * D2-b — source_label is VENDOR-ONLY (Dave-confirmed 2026-07-26: "Dave's Natural Garden" is a
--     place he buys from, not his own garden). So a label never coexists with own_garden: the write
--     path nulls it on an explicit flip, and both read surfaces gate on
--     source_kind <> 'own_garden'. Garden rows render byte-identically to today.
--     Bounded at 120 chars AT THE DATABASE, not only in validateCreate, because the Lambda Function
--     URL is directly callable with a valid Clerk JWT — the app is not the only writer.
--
--   * D2-c — a farm-stand peach attributed to a planting is a data lie, so the plant-conflict CHECK
--     is the server-side backstop for it. Verified SAFE against the existing FK action: plant_id is
--     ON DELETE SET NULL, so deleting a planting nulls the FK and leaves source_kind='own_garden',
--     which this CHECK permits. (harvest_log_id is enforced in validateCreate only — a second column
--     in the CHECK would make legacy rows un-decrementable for no added protection.)
--
--   * D6 — method vocab WIDENED by one value: 'purchased_preserved' (Dave-confirmed 2026-07-26).
--     Bought FROZEN peaches — the case that started this thread — had no honest method: all 13
--     existing values describe an action Dave performed, so store-bought-already-preserved could only
--     be logged as method='other' + "bought frozen", overloading the escape hatch until 'other' meant
--     two unrelated things and method-grouped views went incoherent.
--     This is the ONE place this file is not purely additive in FORM (Postgres cannot alter a CHECK
--     in place, so it is DROP + ADD) — but it is additive in EFFECT: the new predicate is a strict
--     superset of the old, so no existing row and no existing writer can break. The pre gate
--     snapshots the old definition; the post gate asserts all 13 original values survive.
--
-- SAFETY / IDEMPOTENCY: ADD COLUMN IF NOT EXISTS for the columns. Postgres has NO
--   "ADD CONSTRAINT IF NOT EXISTS", so every ADD CONSTRAINT is guarded by a NOT EXISTS lookup against
--   pg_constraint — the family contract is "re-running the whole file is a clean no-op"
--   (v4-putup-001/0a header), and a half-failed staging apply followed by a re-run is a realistic
--   path here. NOTE these are guarded-but-still-BORN-VALID: guarded is not the same as NOT VALID.
--   schema_version INSERT is ON CONFLICT DO NOTHING. No destructive DDL. No data migration.
--
-- APPLY ORDER: 0a is the only apply step. Gates in gates.yml (pre/post). No 0b loader, no 0c
--   validate. STAGING FIRST, then rehearse 0r and re-apply, then prod. See gates.yml sequencing —
--   and note that prod DDL must land BEFORE the promote is dispatched, because a new Lambda against
--   a column-less prod raises 42703 on every POST and PUT, killing every existing "Mark used" tap
--   while reads (SELECT p.*) keep working. The app would look healthy while all writes were dead.
--
-- ROLLBACK: 0r-rollback.sql drops the CONSTRAINTS and the schema_version row and DELIBERATELY LEAVES
--   THE COLUMNS. Dropping them destroys recorded provenance — the feature's entire payload. Prefer
--   rolling back the CODE. See that file's header.

BEGIN;

-- ── 1. The two columns. Nullable, no default (D1-b). ─────────────────────────────────────────────
ALTER TABLE public.preservation_log
  ADD COLUMN IF NOT EXISTS source_kind  text,   -- NULL = unrecorded. NEVER defaulted to own_garden.
  ADD COLUMN IF NOT EXISTS source_label text;   -- vendor/place free text. NULL unless non-garden.

COMMENT ON COLUMN public.preservation_log.source_kind IS
  'Where this produce came from. NULL = unrecorded (never assume own_garden). Vocab is closed by chk_preservation_log_source_kind; widen that CHECK to add a value, never drop it (see 0a header).';
COMMENT ON COLUMN public.preservation_log.source_label IS
  'Free-text vendor/place, e.g. "Warner Farms". Vendor-only: nulled when source_kind is own_garden. Required when source_kind = other.';

-- ── 2. Constraints. Guarded (no ADD CONSTRAINT IF NOT EXISTS in PG) but born-valid. ──────────────
DO $$
BEGIN
  -- D1-a. Closed 8-value vocabulary. NULL passes (unrecorded is legal).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_preservation_log_source_kind') THEN
    ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_source_kind
      CHECK (source_kind IS NULL OR source_kind IN (
        'own_garden','u_pick','farm_stand','csa','store','gift','foraged','other'
      ));
  END IF;

  -- D1-c. other REQUIRES a label. NULL-SAFE: IS DISTINCT FROM + COALESCE, because
  -- (source_kind <> 'other' OR btrim(NULL) <> '') evaluates to NULL and a NULL CHECK PASSES.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_preservation_log_source_other') THEN
    ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_source_other
      CHECK (source_kind IS DISTINCT FROM 'other' OR COALESCE(btrim(source_label), '') <> '');
  END IF;

  -- Two-state label: absent, or meaningful. Blocks '' and '   ' fragmenting the vendor list.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_preservation_log_source_label_nonblank') THEN
    ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_source_label_nonblank
      CHECK (source_label IS NULL OR btrim(source_label) <> '');
  END IF;

  -- D2-b. Bounded at the DB: the Lambda URL is directly callable with a valid Clerk JWT.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_preservation_log_source_label_len') THEN
    ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_source_label_len
      CHECK (source_label IS NULL OR char_length(source_label) <= 120);
  END IF;

  -- D2-c. A non-garden source cannot carry a planting link. Safe vs ON DELETE SET NULL on plant_id.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_preservation_log_source_plant') THEN
    ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_source_plant
      CHECK (source_kind IS NULL OR source_kind = 'own_garden' OR plant_id IS NULL);
  END IF;
END $$;

-- ── 3. D6 — widen the method vocab by one value. DROP + ADD; strict superset, additive in effect. ─
ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_method;
ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_method
  CHECK (method IN (
    'roast_freeze','whole_freeze','blanch_freeze','dehydrate','powder','passata',
    'can_water_bath','can_pressure','jam_preserve','ferment','cure_store','cold_store',
    'purchased_preserved',   -- D6: bought already preserved. No method was performed here.
    'other'
  ));

INSERT INTO public.schema_version (version, description)
VALUES ('4.15.0-putupprov-001','PUTUPPROV: preservation_log gains source_kind + source_label, both NULLABLE with NO DEFAULT (NULL=unrecorded, never own_garden — no backfill, the 1 pre-existing row stays NULL). 5 new born-valid CHECKs: 8-value source_kind vocab (own_garden|u_pick|farm_stand|csa|store|gift|foraged|other; widen it, never drop it — cf. v4-source-freetext); NULL-SAFE other-requires-label via IS DISTINCT FROM + COALESCE (the naive form evaluates NULL and a NULL CHECK passes); label non-blank; label <=120 chars (Lambda URL is directly callable); non-garden source cannot carry plant_id (safe vs ON DELETE SET NULL). ALSO widens chk_preservation_log_method by one value, purchased_preserved, for bought-already-preserved goods — strict superset, DROP+ADD because PG cannot alter a CHECK in place. No table, view or index otherwise touched.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
