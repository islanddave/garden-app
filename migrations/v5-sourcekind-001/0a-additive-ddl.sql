-- 0a-additive-ddl.sql
-- V5-SOURCEKIND-001 — make source.kind a MINTABLE vocabulary instead of a frozen CHECK.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS, AND WHY IT DELIBERATELY REVERSES PART OF V5-SOURCEENTITY-001.
--
-- v5-sourceentity-001 shipped source.kind as a 12-value CHECK and argued at length (its README §2)
-- that the CHECK was "the mechanism that stops source.kind going the way of source_type" — the
-- column that lost its CHECK on 2026-07-07 and is now unconstrained free text. That argument was
-- sound about the DANGER and wrong about the REMEDY.
--
-- Dave's ruling, 2026-09-04, on being shown the 12: "1 but i want to be able to create a new type as
-- part of the interface like we can do with crop type."
--
-- HE IS NOT ASKING FOR FREE TEXT, AND THIS IS NOT THAT. What actually destroyed source_type was not
-- "the set could grow" — it was that the column had NO table behind it, so any writer could put any
-- string in it, silently, with nothing to collide against. crop_types is the counter-example living
-- in this same schema: its vocabulary grows on demand and has NOT fragmented, because growth runs
-- through a guarded mint — server-derived slug, resolve-against-existing (exact / plural / coupled
-- synonym), rate-limited, and checked against soft-deleted rows too (lambda/varieties/validate.js
-- resolveCropTypeName, lambda/varieties/index.js:168-180). A user who types "Nurseries" is handed
-- the existing `nursery`, not given a thirteenth row.
--
-- So the guarantee moves rather than disappearing:
--   BEFORE  kind ∈ a literal list frozen in a CHECK; growth = a code change and a deploy.
--   AFTER   kind is an FK into public.source_kind; growth = a guarded mint that must first fail to
--           resolve against every existing slug, live or soft-deleted.
-- A frozen CHECK is a stronger guarantee about the SET and a much weaker one about the USER: faced
-- with a place that is none of the 12, the only options were 'other' (which erases the distinction)
-- or a free-text field elsewhere (which is how the 73 spellings happened in the first place).
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- SAFE TO RUN AGAINST BOTH LIVE DATABASES, and the reason is measurable rather than assumed.
-- public.source is EMPTY on staging and prod (v5-sourceentity-001 is substrate only, nothing
-- backfilled) and NO deployed Lambda or bundle reads or writes source.kind. So dropping the CHECK
-- and adding the FK cannot reject a row the running code produces, and cannot fail validation
-- against existing data — there is none. That is the 2026-08-03 arming-a-CHECK test asked of prod's
-- live artifact rather than of this branch.
--
-- ORDER INSIDE THE TRANSACTION MATTERS: seed source_kind BEFORE adding the FK, or the FK has nothing
-- to point at. Both happen here, atomically.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql
-- Apply order: staging -> rehearse 0r -> re-apply staging -> prod -> dev push.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. THE VOCABULARY TABLE. Shaped to mirror public.crop_types exactly where the concepts match —
-- text slug PK, display_name, sort_order, created_by defaulting to 'system', soft-delete — so that
-- the mint path, the picker and any future admin screen can be the crop-type ones with the table
-- name changed, rather than a second pattern to learn. RLS off, matching crop_types and
-- plant_varieties: a shared catalogue nobody owns.
CREATE TABLE IF NOT EXISTS public.source_kind (
  slug         text PRIMARY KEY,
  display_name text        NOT NULL,
  sort_order   integer     NOT NULL DEFAULT 0,
  created_by   text        NOT NULL DEFAULT 'system',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,

  -- The slug is a PRIMARY KEY and an FK target, so it is SERVER-DERIVED, never caller-supplied —
  -- the same rule slugifyCropType enforces for crop types, and for the same reason: letting a client
  -- name a key invites collisions and unicode games. This CHECK is the database's half of that.
  CONSTRAINT chk_source_kind_slug_shape
    CHECK (slug ~ '^[a-z0-9]+(_[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 60),

  CONSTRAINT chk_source_kind_display_name_shape
    CHECK (display_name = btrim(display_name)
           AND char_length(display_name) BETWEEN 2 AND 80
           AND display_name ~ '[A-Za-z0-9]')
);

-- Case/punctuation-folded uniqueness on the LABEL, not just the slug. The slug PK already stops two
-- rows named `farm_stand`; this stops "Farm Stand" and "Farm  stand" existing as two rows with
-- different slugs and indistinguishable labels — the exact drift shape that produced 73 spellings of
-- 35 places. Partial on live rows so a soft-deleted kind frees its label for reuse, matching
-- uq_source_match_key_live.
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_kind_display_live
  ON public.source_kind (regexp_replace(lower(display_name), '[^a-z0-9]', '', 'g'))
  WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at'
                   AND tgrelid = 'public.source_kind'::regclass) THEN
    CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.source_kind
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

END
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- NO AUDIT TRIGGERS ON THIS TABLE, AND THE REASON IS STRUCTURAL — DO NOT "FIX" IT BY ADDING THEM.
--
-- The first draft of this migration DID attach audit_stmt_update / audit_stmt_delete here, by
-- analogy with V5-SOURCEAUDITLOG-001 on public.source. They installed cleanly, passed a triggerdef
-- shape gate, and wrote NOTHING. Caught on staging 2026-09-04 only by driving a real edit through:
--
--   WARNING: audit_stmt_update(source_kind): audit write FAILED, SQLSTATE=42703
--            (column o.id does not exist). The originating UPDATE is unaffected.
--
-- Both generic audit functions select `n.id` / `o.id` and insert it into public.audit_events.row_id,
-- which is typed **uuid**. This table is keyed by a text `slug`, mirroring public.crop_types — so
-- there is no id to read, and even with one the key could not be stored in a uuid column. Every
-- table that carries these triggers today (plants, event_log, harvest_log, plant_varieties) has a
-- uuid `id`; crop_types, the only other slug-keyed vocabulary in the schema, carries no audit
-- triggers for exactly this reason. That absence was a constraint, not an oversight.
--
-- The failure mode is the dangerous one: both functions catch WHEN OTHERS and downgrade it to a
-- WARNING so the user's edit still succeeds. A trigger here does not error, does not appear broken,
-- and logs nothing — a table that LOOKS audited. post_audit_triggers_not_installed makes this
-- prohibition enforceable rather than advisory.
--
-- If a source_kind edit history is ever genuinely wanted, it needs one of: a uuid surrogate key on
-- this table, or a text-keyed audit variant plus a widened audit_events.row_id — the latter shared
-- with four other tables, so it is a migration of its own and not a line in this one. Until then the
-- honest position is that this 12-row vocabulary has no edit history, exactly as crop_types does not.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. THE SEED — the 12 Dave approved, verbatim, in the order they were put to him.
--
-- sort_order is spaced by 10 SO THAT A MINTED KIND CAN BE SLOTTED BETWEEN TWO SEEDS without
-- renumbering the table. crop_types defaults sort_order to 0 and ties break on display_name; here a
-- mint will also land on 0 and therefore sort FIRST, which is wrong for a list whose head should be
-- the common cases. The picker orders by (sort_order, display_name) and the mint path sets
-- sort_order to (max + 10), so a new kind lands at the END where a new thing belongs.
--
-- 'other' is last on purpose and is NOT special-cased in the schema: with minting available it
-- should be reached rarely, and a kind that keeps being 'other' is a signal a real kind is missing.
--
-- 'gift' is still deliberately absent. A gift is a TRANSACTION, which plants.source_type already
-- records; the giver is a 'person'. Minting is not a reason to re-litigate that — it is a reason it
-- no longer has to be litigated in advance.
INSERT INTO public.source_kind (slug, display_name, sort_order, created_by) VALUES
  ('seed_company',  'Seed company',  10,  'system'),
  ('nursery',       'Nursery',       20,  'system'),
  ('garden_center', 'Garden center', 30,  'system'),
  ('farm_stand',    'Farm stand',    40,  'system'),
  ('market',        'Market',        50,  'system'),
  ('retail',        'Retail',        60,  'system'),
  ('plant_swap',    'Plant swap',    70,  'system'),
  ('person',        'Person',        80,  'system'),
  ('organization',  'Organization',  90,  'system'),
  ('brand',         'Brand',         100, 'system'),
  ('own_garden',    'Own garden',    110, 'system'),
  ('other',         'Other',         120, 'system')
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. SWAP THE GUARANTEE. Drop the frozen CHECK, add the FK.
--
-- NO ACTION on delete, matching the four source FKs and for the same reason: a HARD delete of a kind
-- that sources point at should RAISE, not silently null their classification. The app soft-deletes
-- (deleted_at), which hides a kind from the picker while leaving every existing pointer intact and
-- readable — that is the whole reason source_kind is soft-deletable rather than a plain enum.
ALTER TABLE public.source DROP CONSTRAINT IF EXISTS chk_source_kind;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_source_kind') THEN
    ALTER TABLE public.source
      ADD CONSTRAINT fk_source_kind
      FOREIGN KEY (kind) REFERENCES public.source_kind(slug);
  END IF;
END
$$;

-- Reverse lookup: "list my seed companies" walks from a kind to its sources. idx_source_kind_live
-- from v5-sourceentity-001 already covers source(kind) WHERE deleted_at IS NULL AND kind IS NOT
-- NULL, which is exactly this query, so no new index on the parent side. The FK's own lookup uses
-- source_kind's PK.

COMMENT ON TABLE public.source_kind IS
  'V5-SOURCEKIND-001. The mintable vocabulary behind source.kind — what sort of PLACE a source is. '
  'Replaces the 12-value CHECK v5-sourceentity-001 shipped, at Dave''s direction (2026-09-04), so a '
  'new kind can be created from the picker the way a crop type can. NOT a relaxation to free text: '
  'source.kind is an FK here, and the mint path resolves a proposed name against every existing '
  'slug INCLUDING soft-deleted ones before it will create a row — the same guard that has kept '
  'crop_types from fragmenting. Seeded with the 12 Dave approved. RLS off, matching crop_types.';

COMMENT ON COLUMN public.source_kind.sort_order IS
  'Picker order, spaced by 10 across the seeds so a minted kind can slot between two of them without '
  'renumbering. The mint path assigns max(sort_order) + 10 so a new kind lands at the END; it must '
  'NOT default to 0 the way crop_types.sort_order does, or every newly minted kind would sort above '
  'the twelve common ones.';

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-sourcekind-001',
        'SOURCEKIND: V5-SOURCEKIND-001. New public.source_kind vocabulary table (text slug PK, '
        'display_name, sort_order spaced by 10, created_by, soft-delete, RLS off) shaped to mirror '
        'crop_types, seeded with the 12 kinds Dave approved 2026-09-04, with a folded-label unique '
        'index over live rows and a set_updated_at trigger. NO audit triggers, deliberately and '
        'structurally: the generic audit functions read n.id into audit_events.row_id (uuid) and '
        'this table is slug-keyed like crop_types, so they install cleanly and silently log nothing '
        '- proven on staging, and now forbidden by post_audit_triggers_not_installed. '
        'source.kind''s frozen 12-value CHECK chk_source_kind is DROPPED and replaced by FK '
        'fk_source_kind -> source_kind(slug) with NO ACTION on delete, so the vocabulary can grow '
        'through a guarded mint (Dave: "i want to be able to create a new type as part of the '
        'interface like we can do with crop type") without becoming free text. Safe on live data: '
        'public.source is empty on both databases and no deployed writer sets kind.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
