-- 0a-additive-ddl.sql
-- V4-PUTUPSESSION-001 slice 1 — preserved_at_approx. Lets a put-up say its date is an ESTIMATE.
--
-- WHY THIS COLUMN EXISTS, IN ONE PARAGRAPH. Slice 0 (shipped v4.87.0) added the freezer walk: two
-- questions at the start of a sitting, one of which is "roughly when did you put this up?" answered
-- with "This summer" / "Earlier this year". coarseDate() resolves that to the midpoint of the window
-- and every item in the walk is saved with it. preserved_at is NOT NULL and there was nowhere to
-- record that the value is an estimate, so slice 0 knowingly stores a guess in the same shape as a
-- date Dave picked off a calendar, and every read surface renders the two identically. The walk's
-- own band says "around Jul 16" because it still has the flag in React state; the moment the row is
-- re-read from the database that distinction is gone. This column is where it survives.
--
-- SCOPE: ONE nullable boolean column on preservation_log. No constraint, no index, no backfill, no
--   other table, no view. This is the smallest DDL that closes the defect.
--
-- DESIGN DECISIONS THIS DDL ENCODES:
--
--   * D1 — NULLABLE, NO DEFAULT. NULL means "unrecorded", never "exact".
--     `boolean NOT NULL DEFAULT false` is the obvious shape and it is WRONG HERE, for a reason
--     specific to this feature rather than to house style: the freezer walk has been live in prod
--     since v4.87.0 and has already been writing midpoint-estimated dates with nothing to mark them.
--     A default of false would stamp exactly those rows — the ones this column exists for — with
--     "the user chose this date deliberately". That is the precise falsehood being fixed, baked in
--     by the fix. NULL says the honest thing: nobody was ever asked.
--     Same conclusion v4-putupprov-001 D1-b reached for source_kind (a default of own_garden is a
--     false-provenance generator) and the same norm v4-harvattr-001/gates.yml pins across six
--     columns with is_nullable='YES' AND column_default IS NULL. Same table family, same norm.
--
--   * D1-a — CONSEQUENCE FOR READS, stated so nobody "improves" it later. Only TRUE changes
--     rendering. NULL and FALSE both render as a plain date, so every row that exists today looks
--     byte-identical to today and no backfill is needed to keep the pantry looking right. Read code
--     must therefore test `=== true` / `IS TRUE`, never truthiness of a three-valued column.
--
--   * D2 — NO CHECK CONSTRAINT, deliberately. A boolean's domain is already closed by its type;
--     the closed-vocabulary CHECK pattern this table uses five times over (source_kind, method,
--     source_label shape) exists because those are TEXT columns where the type constrains nothing.
--     Adding one here would be cargo cult. There is nothing to widen later, so the
--     "widen it, never drop it" hazard v4-putupprov-001 documents at length does not arise.
--
--   * D3 — NO BACKFILL, and the pre-existing rows stay NULL. Inferring approximate-ness from the
--     data is not possible: a midpoint date and a date Dave typed are the same value in the same
--     column, which is the whole defect. Inventing FALSE for them would assert a fact nobody
--     recorded. A post gate asserts no pre-existing row acquired an invented flag.
--
--   * D4 — NARROWING IS THE THING TO NOT SMUGGLE IN LATER. Making this NOT NULL, or adding a CHECK
--     that requires it, would 400 every write from a service-worker-cached bundle that has never
--     heard of the column — Dave runs this as an installed PWA on Android where a loaded tab keeps
--     its old bundle until reload. Same trap the put-up design doc §5.1 flags for food_category.
--     If it ever should be mandatory that is a separate arming step, after the old bundles age out.
--
-- SAFETY / IDEMPOTENCY: ADD COLUMN IF NOT EXISTS. Re-running the whole file is a clean no-op — the
--   family contract (v4-putup-001/0a header). schema_version INSERT is ON CONFLICT DO NOTHING.
--   No destructive DDL, no data migration, nothing that can fail on existing data: adding a
--   nullable column with no default is a catalogue-only change in PG 11+, so there is no table
--   rewrite and no lock held for the length of one.
--
-- APPLY ORDER: 0a is the only apply step. No 0b loader (nothing to load), no 0c validate (nothing
--   can be invalid — there is no constraint). STAGING FIRST, rehearse 0r, re-apply, then PROD, and
--   PROD BEFORE THE PROMOTE. The 42703 hazard v4-putupprov-001 documents applies verbatim: a Lambda
--   carrying this column against a column-less prod raises 42703 on every POST and PUT while
--   SELECT p.* reads keep working, so the app looks healthy while every write is dead. Full
--   sequencing in gates.yml.
--
-- COORDINATED EDIT IN ANOTHER MIGRATION'S GATES — DO NOT SEPARATE THESE TWO.
--   migrations/v4-putupprov-001/gates.yml carries post_column_count_is_23, which is `continuous`
--   (that file sets `continuous` nowhere and scripts/gate_runner.py defaults it to True), so it
--   re-runs against live prod and staging in every --continuous-only sweep. This migration takes
--   preservation_log to 24 columns, so that gate is renamed and re-pinned to 24 in the same commit.
--   It reds on BOTH environments in the window between the code landing and the DDL being applied
--   there — that is the gate working, not a fault, and it is why prod is applied before the promote.
--
-- ROLLBACK: 0r-rollback.sql. Read its header before running it — dropping this column destroys
--   recorded estimate flags, and the preferred lever is a CODE rollback.

BEGIN;

-- ── 1. The column. Nullable, no default (D1). ────────────────────────────────────────────────────
ALTER TABLE public.preservation_log
  ADD COLUMN IF NOT EXISTS preserved_at_approx boolean;   -- NULL = unrecorded. NEVER defaulted.

COMMENT ON COLUMN public.preservation_log.preserved_at_approx IS
  'TRUE when preserved_at is an ESTIMATE (the freezer walk resolved a coarse answer like "this summer" to the midpoint of that window) rather than a date the user picked. NULL = unrecorded, which is what every row written before this column existed carries — it is NOT the same claim as FALSE. Only TRUE changes how a date renders; NULL and FALSE both render plain. Deliberately nullable with no default and no CHECK: see 0a header D1/D2.';

INSERT INTO public.schema_version (version, description)
VALUES ('4.88.0-putupsession-001','PUTUPSESSION-001 slice 1: preservation_log gains preserved_at_approx boolean, NULLABLE with NO DEFAULT and NO CHECK (NULL=unrecorded, never "exact" — no backfill, every pre-existing row stays NULL). Closes the knowing limitation of slice 0 (v4.87.0), where the freezer walk resolved a coarse answer ("this summer") to a window midpoint and stored it in the same shape as a date the user picked, so every read surface rendered an estimate as though it were chosen exactly. NOT NULL DEFAULT false was rejected: it would stamp the already-written walk rows — precisely the rows this exists for — as deliberately chosen. Only TRUE changes rendering; NULL and FALSE render identically, so no existing row changes appearance. No constraint (a boolean type is already a closed domain), no index, no other table touched. Takes preservation_log from 23 to 24 columns; v4-putupprov-001/gates.yml post_column_count gate re-pinned to 24 in the same commit.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
