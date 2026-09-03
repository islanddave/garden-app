-- 0a-additive-ddl.sql
-- V5-SOURCEENTITY-001 — public.source, the first-class supplier/origin entity.
--
-- STATUS AT AUTHORING (2026-09-03): NOT APPLIED ANYWHERE. Substrate only — no Lambda, no UI, no
-- backfill in this file. Measured against live prod (neondb, PostgreSQL 17.11) on 2026-09-03.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS — measured, not asserted.
--
-- "Where did this come from" is free text in FIVE places today, with no shared vocabulary between
-- any two of them. Counts are live prod, 2026-09-03:
--
--   plants.source_ref                 182 rows (166 live, 16 soft-deleted), 41 distinct spellings
--   inventory_items.source            385 rows (all live),                  32 distinct spellings
--   inventory_items.metadata->>'vendor'            202 rows, 10 distinct
--   inventory_items.metadata->>'purchase_location'  12 rows,  1 distinct
--   inventory_items.metadata->>'retailer'           10 rows,  1 distinct
--
-- 73 distinct strings across the two columns represent roughly 35 real places. The same place is
-- spelled differently within one column and across both: "Botanical Interests" has four spellings in
-- inventory plus a fifth in plants; "High Mowing" has three; "Shawski Farm" / "Shawski Farms" /
-- "Skawski Farms" are three typings of ONE shopping trip (all three rows created 2026-05-31, all
-- nursery_transplant); "Starview Gardens" (46) vs "Starview" (2); "Long River Produce Market" (26)
-- vs "Long River Market, Deerfield, MA, USA" (1).
--
-- THE DRIFT HAS ALREADY REPLICATED INTO THE JSON LAYER. metadata->>'vendor' was written to be the
-- clean, deduplicated half — and it ALREADY carries both 'High Mowing Organic Seeds' and
-- 'High Mowing' as separate values. A free-text field cannot hold a vocabulary, however carefully
-- it is populated the first time. That is the whole argument for an entity.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY ONE SHARED TABLE AND NOT ONE PER PARENT — decided from the data, not from taste.
--
-- 9 real places already appear in BOTH columns: Amazon, Home Depot, Botanical Interests, High
-- Mowing Organic Seeds, Seed Savers Exchange, Greenfield Co-op, Belchertown Plant Swap, and the
-- Gardener's Supply / Lake Valley pairs. Two tables would mean two rows for Botanical Interests,
-- two websites to keep in step, two sets of Dave's notes on whether they are reliable, and a
-- "what have I ever got from here" question that no single query can answer. The entity being
-- modelled is a PLACE IN THE WORLD; it is not a property of the table that happens to point at it.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- TWO FK COLUMNS PER PARENT, NOT ONE — this is the one non-obvious decision here, and the data
-- forced it rather than a preference.
--
-- Dave asked whether "Botanical Interests (via Gardener's Supply Company, Hadley MA)" is the same
-- source as "Botanical Interests". His own data already answers: no, it is two facts, and the
-- schema already stores both. All 12 "(via Gardener's Supply…)" rows carry BOTH
--   metadata->>'vendor'            = 'Botanical Interests' | 'Seed Savers Exchange' | 'High Mowing…'
--   metadata->>'purchase_location' = 'Gardener's Supply Company, Hadley MA'
-- Someone already separated the brand from the shop by hand. Four more rows do the same thing in
-- prose, across BOTH parent tables:
--   inventory  "Free from Belchertown Plant Swap, June 2026 (originally Lake Valley Seed, item #233)"
--   inventory  "Magic Wings Inc (via Belchertown Plant Swap)"
--   inventory  "Amazon (GoveeLife)" / "Amazon (NaturesGoodGuys)" / "Amazon (Toudura)"
--   plants     "Liz Young via Belchertown Plant Swap June"
--
-- A single FK would force the dedupe to DESTROY one of those two facts on ~20 rows. So:
--   source_id                — the ORIGINATOR: who grew, bred, packed, or gave the thing.
--   acquired_from_source_id  — the SHOP / MARKET / EVENT where it changed hands, set only when it
--                              differs from the originator. NULL means "not recorded, or not
--                              distinct" — it does NOT mean "same as source_id".
-- For the large majority of rows only source_id is ever set. This is the minimum shape that does not
-- lose a distinction the data already draws; it is not an extra feature.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- source.kind IS A THIRD AXIS, NOT A THIRD VOCABULARY. Read this before objecting.
--
-- This schema has fragmented a provenance vocabulary once already (plants.source_type,
-- v4-source-freetext, 2026-07-07), and V4-SEEDORIGIN-001 exists partly to stop the second time. So
-- the burden here is to show source.kind is NOT another fork of the same concept.
--
-- The two existing vocabularies describe THE TRANSACTION — how this particular row was acquired:
--   plants.source_type          free text since v4-source-freetext. Live prod distribution:
--                               nursery_transplant 114, NULL 95, seed_packet 49, rescued 37,
--                               gift 12, division 4, plant_swap 4, unknown 2, volunteer 1.
--   inventory_items.source_kind CHECK-constrained to VALID_SOURCE_KINDS from
--                               lambda/preservation/provenance.js (own_garden|u_pick|farm_stand|
--                               csa|store|gift|foraged|other). 100% NULL on prod — substrate only.
--
-- source.kind describes THE PLACE — what sort of establishment it is, stable across every
-- transaction with it. The two axes are measurably independent in Dave's own rows:
--   * "Long River Produce Market" is source_type='rescued' on 26 plants and 'volunteer' on 1.
--   * "Belchertown Plant Swap" carries plant_swap, gift AND nursery_transplant across 3 spellings.
--   * "Whatley Plant Swap" is 'rescued'; "Whatley Giving Garden" is 'plant_swap'.
-- One place, several acquisition types. A column that conflates them cannot answer either question.
--
-- Neither existing column is touched, neither vocabulary is extended, and nothing here constrains
-- what plants.source_type may contain. Where a value NAME coincides ('own_garden', 'plant_swap',
-- 'farm_stand') the two still mean different things — a place vs a transaction — and they are
-- independently valid. `gift` is deliberately ABSENT from source.kind: a gift is a transaction, and
-- plants.source_type already records it. The giver is a `person`.
--
-- THE VALUE SET IS DERIVED FROM THE 73 STRINGS, NOT INVENTED. Every value below is grounded in
-- language Dave already wrote into the data: "trust stand" (×4 distinct stands), "Plant Swap" (×5),
-- "(retail store)", "Gardens"/"Farm"/"Flower Farm", "packet"/"online order", "Home-saved". The
-- classification of each of the 73 strings is in dedupe-mapping.csv in this directory, which Dave
-- reviews. IF HE WANTS A DIFFERENT SET, THIS CHECK IS THE ONE PLACE TO CHANGE — and post_kind_
-- vocabulary_exact in gates.yml is the drift gate that keeps it honest afterwards.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT IS NOT DONE HERE, DELIBERATELY.
--
--   * NO BACKFILL, and no writer. dedupe-mapping.csv is a REVIEWABLE PROPOSAL, not an applied
--     decision. A wrong merge destroys a distinction Dave cares about, and 14 of the 73 rows are
--     flagged as needing his call. The backfill is a separate migration gated on his review.
--   * plants.source_ref and inventory_items.source ARE NOT DROPPED, ALTERED, OR EMPTIED. They are
--     the only record of provenance until a backfill is verified, and for some rows the only home
--     of a fact that has nowhere else to go — order numbers, receipt dates, "originally Lake Valley
--     Seed, item #233", "(HOMESTEAD discount)". Expand-only: this migration only ADDS.
--   * NO DEFAULT ON ANY NEW COLUMN. grown_as DEFAULT 'annual' stamped 362 of 413 cultivars with a
--     value nobody chose and had to be dropped on 2026-09-01. NULL is the honest state of every
--     existing row here.
--
-- CHECKS ARE ADDED VALID, NOT `NOT VALID` — the stated exception to the house L-058 pattern, same
-- as V4-SEEDORIGIN-001 and V4-SEEDSAVEFLOW-001. That pattern guards against a validating scan
-- tripping on historical rows and against a still-deployed old writer. Neither applies: every
-- constrained column is CREATED IN THIS STATEMENT, so every existing row is NULL, and no deployed
-- code can write a column that did not exist a moment ago. Leaving an unvalidated constraint for
-- someone to arm later is its own trap — arming a CHECK is a deploy against the still-live old
-- writer (2026-08-03 incident).
--
-- BLAST RADIUS, CHECKED ON LIVE PROD 2026-09-03 (not assumed):
--   * Views over the two parents — v_sow_candidates, garden_node, v_container_recency,
--     v_resolved_care. Postgres expands `*` at view-definition time, so an added column widens none
--     of them. No view is touched by this file.
--   * plants/inventory_items RLS policies are column-agnostic
--     (`current_user_id() IS NOT NULL AND deleted_at IS NULL`) — an added column cannot affect them.
--   * audit_stmt_update / audit_stmt_delete on plants capture the WHOLE ROW via to_jsonb, so they
--     pick the new columns up additively with no column list to maintain.
--   * gv.entity_planting_ins / _rename / _softdel and gv.bump_version reference named columns only
--     and do not read the whole row — unaffected.
--   * prevent_ownership_transfer (installed on 9 tables incl. both parents) fires on created_by /
--     user_id. This file writes neither, and the trigger is NOT installed on public.source.
--     DO NOT INSTALL IT THERE: a shared catalogue has no owner, and created_by here records who
--     first entered the row, not who owns the place.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql
-- Apply order (gates.yml §SEQUENCING): staging -> rehearse 0r -> re-apply staging -> prod ->
--   dev push -> promote.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. THE ENTITY.
--
-- RLS DELIBERATELY OFF, matching public.plant_varieties — the closest analogue in this schema and
-- the correct precedent: a shared catalogue that both users read and neither owns (RLS off, zero
-- policies, verified on prod 2026-09-03). The parents' own RLS is an authentication gate, not
-- per-user row isolation, so nothing is weakened: a caller who can read a plant could already read
-- everything about where it came from.
--
-- IF ANYONE EVER ENABLES RLS ON THIS TABLE, THEY MUST ADD A POLICY IN THE SAME MIGRATION. Enabling
-- RLS with zero policies is deny-all for every non-owner role and it fails SILENTLY — zero rows,
-- not a permission error, so it reads as "no data" instead of "no access". That exact footgun was
-- found live on public.schema_version on 2026-09-01 (v4-roschemaversion-001) and had been blinding
-- the read-only role for an unknown period.
CREATE TABLE IF NOT EXISTS public.source (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- THE HUMAN LABEL, and nothing else. No address, no order number, no date, no "(via …)". Those
  -- have their own columns below or stay in the parents' free text. "Chapley Gardens", not
  -- "Chapley Gardens - 397 Greenfield Rd Deerfield MA".
  name         text NOT NULL,

  -- WHAT SORT OF PLACE. NULL = not yet classified, which is honest for anything Dave has not
  -- reviewed. See the axis argument in the header — this is not plants.source_type and not
  -- inventory_items.source_kind.
  kind         text,

  -- WHERE IT IS. Split in two because they answer different questions and the data contains both
  -- shapes: locality is the groupable "which town is this" ("Deerfield, MA", "Hadley, MA",
  -- "Austria"); address is the street line you would navigate to ("397 Greenfield Rd"). A mail-order
  -- seed company legitimately has neither. public.locations is NOT reused: it is the user's own
  -- garden hierarchy (parent_id, zone_level, geofence_radius_m, qr_code_slug) and carries the
  -- ownership-transfer trigger — a vendor is not a place in Dave's garden.
  locality     text,
  address      text,

  -- THE ORDERING LINK, for the reorderable ones. DISTINCT FROM inventory_items.source_url, which is
  -- a PER-ITEM PRODUCT page — measured: the 8 Johnny's Selected Seeds rows carry 8 DIFFERENT
  -- source_url values, one per pepper variety. This column is the vendor's front door; that one is
  -- "the page I bought this exact packet from". Both are worth having and neither replaces the other.
  website_url  text,

  -- FREE NOTES: whether they were reliable, what they are good for, when they mark down. Explicitly
  -- unstructured — this is the field Dave asked for and structuring it would defeat it.
  notes        text,

  -- NORMALISED DUPLICATE-CATCHER. Case, punctuation, spacing and accents all folded away, so
  -- "Greenfield Co-op" / "greenfield coop" / "Greenfield  Co-Op" collide on insert instead of
  -- becoming three rows. STORED and GENERATED so it can never drift from name.
  --
  -- COLLATION-STABLE despite lower(): any character outside [a-z0-9] is stripped AFTER folding, so
  -- whether a given collation lower-cases 'É' to 'é' or leaves it alone, the stored key is the same.
  -- Both lower(text) and regexp_replace are IMMUTABLE (provolatile='i', verified on prod).
  --
  -- HONEST ABOUT ITS LIMIT: this catches typographic variants. It does NOT catch "Starview" vs
  -- "Starview Gardens", or "Shawski" vs "Skawski" — nothing in a UNIQUE index can. Those are caught
  -- by the picker (a writer chooses an existing row) and, later, by an alias table. See the design
  -- note §"stopping the 74th spelling".
  match_key    text GENERATED ALWAYS AS (regexp_replace(lower(name), '[^a-z0-9]', '', 'g')) STORED,

  -- Who first entered this row. Mirrors public.plant_varieties.created_by (text NOT NULL). NOT an
  -- ownership claim — see the prevent_ownership_transfer note in the header.
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- Soft delete, house standard. A source is never hard-deleted while a plant or a seed lot still
  -- points at it — the FKs below are deliberately NO ACTION so that attempt fails loudly.
  deleted_at   timestamptz,

  -- A name must contain something nameable, be trimmed, and be a label rather than a paragraph.
  -- The alphanumeric requirement also guarantees match_key is never the empty string, which would
  -- otherwise let every punctuation-only name collide with every other.
  CONSTRAINT chk_source_name_shape
    CHECK (name = btrim(name)
           AND char_length(name) BETWEEN 2 AND 200
           AND name ~ '[A-Za-z0-9]'),

  -- Membership. THE DRIFT GATE'S SUBJECT — post_kind_vocabulary_exact in gates.yml pins this exact
  -- list and its order. Changing it is a deliberate act in two files, not an accident in one.
  -- Grounded in the 73 measured strings; see dedupe-mapping.csv for which string lands where.
  --   seed_company  mail-order seed (Botanical Interests, Johnny's, Sandia, Mary's Heirloom …)
  --   nursery       grows and sells plants (Starview Gardens, Chapley Gardens, The Warren Place)
  --   garden_center retails plants and supplies without growing them (Gardener's Supply, Hadley MA)
  --   farm_stand    a farm's own stand, incl. the four honour-system "trust stand" entries
  --   market        market or co-op (Long River Produce Market, Greenfield Farmers Co-op)
  --   retail        general retail, not garden-specific (Amazon, Home Depot, Walmart, Big Y)
  --   plant_swap    a swap or giving-garden event
  --   person        a named human (Imogen, Emma Daley, Jen's uncle, Liz Young)
  --   organization  an institution or non-profit (UMass Libraries Common Seed Project, MFGA)
  --   brand         a producer you do not buy from directly (Bonnie, GoveeLife, Sereniseed)
  --   own_garden    seed or divisions off Dave and Jen's own plants
  --   other         genuinely none of the above (Panorama Tours, Austria — a souvenir packet)
  CONSTRAINT chk_source_kind
    CHECK (kind IS NULL OR kind = ANY (ARRAY[
      'seed_company','nursery','garden_center','farm_stand','market','retail',
      'plant_swap','person','organization','brand','own_garden','other'
    ])),

  -- A link that is not a link is worse than no link: it renders as a dead control. Scheme-only
  -- assertion, deliberately loose about the rest.
  CONSTRAINT chk_source_website_url
    CHECK (website_url IS NULL OR website_url ~ '^https?://')
);

-- ONE NAME, ONE ROW, among the live ones. Mirrors uq_plant_varieties_name_species exactly — the
-- house idiom is a partial unique index over a folded expression WHERE deleted_at IS NULL, so that
-- soft-deleting a source frees its name for reuse rather than poisoning it forever. Built on
-- match_key rather than lower(name) because match_key is strictly the stronger fold.
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_match_key_live
  ON public.source (match_key) WHERE deleted_at IS NULL;

-- "What sort of places do I buy from" / "list my seed companies". Partial: NULL kinds are the
-- unclassified backlog and are never the subject of this query.
CREATE INDEX IF NOT EXISTS idx_source_kind_live
  ON public.source (kind) WHERE deleted_at IS NULL AND kind IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at'
                   AND tgrelid = 'public.source'::regclass) THEN
    -- Same trigger function inventory_items uses. Named identically for the same reason.
    CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.source
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. THE POINTERS. Four nullable FK columns, two per parent. Nothing is backfilled.
--
-- NO ACTION (the default) ON DELETE, DELIBERATELY, ON ALL FOUR. Not CASCADE — that would delete a
-- plant because a vendor row was tidied up. Not SET NULL — that silently destroys the provenance
-- this whole migration exists to protect, and it would do it quietly at 3am. NO ACTION means a hard
-- DELETE of a referenced source RAISES, and the operator must soft-delete or repoint first. Loud is
-- correct here.
ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS source_id               uuid REFERENCES public.source(id),
  ADD COLUMN IF NOT EXISTS acquired_from_source_id uuid REFERENCES public.source(id);

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS source_id               uuid REFERENCES public.source(id),
  ADD COLUMN IF NOT EXISTS acquired_from_source_id uuid REFERENCES public.source(id);

-- A row that names the same place twice is a data error, not a redundancy: it means a writer set
-- "acquired from" without checking, and it makes "which of these did I get somewhere else" wrong.
-- The NULL arms keep the constraint satisfiable at every population, so it never becomes expensive
-- to add and never blocks a row that simply has not recorded one half.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_plants_source_distinct') THEN
    ALTER TABLE public.plants
      ADD CONSTRAINT chk_plants_source_distinct
      CHECK (acquired_from_source_id IS NULL
             OR source_id IS NULL
             OR acquired_from_source_id <> source_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_source_distinct') THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT chk_inventory_source_distinct
      CHECK (acquired_from_source_id IS NULL
             OR source_id IS NULL
             OR acquired_from_source_id <> source_id);
  END IF;
END
$$;

-- The reverse lookup — "everything I ever got from Long River Produce Market". Partial on NOT NULL
-- because until the backfill lands every row is NULL, and after it lands the NULLs are still the
-- rows with no recorded provenance, which this query is never about.
CREATE INDEX IF NOT EXISTS idx_plants_source_id
  ON public.plants (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plants_acquired_from_source_id
  ON public.plants (acquired_from_source_id) WHERE acquired_from_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_source_id
  ON public.inventory_items (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_acquired_from_source_id
  ON public.inventory_items (acquired_from_source_id) WHERE acquired_from_source_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. DOCUMENTATION THAT TRAVELS WITH THE SCHEMA.
COMMENT ON TABLE public.source IS
  'V5-SOURCEENTITY-001. One row per real place a plant or a supply came from: seed company, '
  'nursery, farm stand, market, plant swap, person, or own garden. Replaces free text that had '
  'grown to 73 distinct spellings for ~35 places across plants.source_ref, inventory_items.source '
  'and three inventory_items.metadata keys. Shared by BOTH parent tables because 9 of the places '
  'appear in both. RLS off, matching plant_varieties — a shared catalogue nobody owns. Soft-delete '
  'via deleted_at; the parents reference this with NO ACTION so a hard delete of a referenced row '
  'raises rather than silently nulling provenance.';

COMMENT ON COLUMN public.source.kind IS
  'What sort of PLACE this is — a property of the establishment, stable across transactions. NOT '
  'the acquisition vocabulary: plants.source_type (nursery_transplant|seed_packet|rescued|gift|'
  'division|plant_swap|volunteer|unknown) and inventory_items.source_kind (VALID_SOURCE_KINDS from '
  'lambda/preservation/provenance.js) both describe HOW A ROW WAS ACQUIRED and are untouched by '
  'this table. The axes are measurably independent: Long River Produce Market is source_type '
  '''rescued'' on 26 plants and ''volunteer'' on 1. ''gift'' is absent here on purpose — a gift is '
  'a transaction; the giver is a ''person''.';

COMMENT ON COLUMN public.source.match_key IS
  'Generated fold of name (lower, then every non-[a-z0-9] stripped) backing uq_source_match_key_live. '
  'Catches case/punctuation/spacing/accent variants at insert time. Does NOT catch omitted words '
  '("Starview" vs "Starview Gardens") or transposed letters ("Shawski" vs "Skawski") — no unique '
  'index can. Those are the picker''s job, and later an alias table''s.';

COMMENT ON COLUMN public.source.website_url IS
  'The vendor''s front door / ordering page. NOT the same as inventory_items.source_url, which is a '
  'per-ITEM product page — the 8 Johnny''s Selected Seeds rows carry 8 different source_url values, '
  'one per variety. Both are useful; neither replaces the other.';

COMMENT ON COLUMN public.plants.source_id IS
  'V5-SOURCEENTITY-001. The ORIGINATOR — who grew, bred, packed or gave this plant. Nullable and '
  'unbackfilled: plants.source_ref remains the record of provenance until a reviewed backfill lands.';
COMMENT ON COLUMN public.plants.acquired_from_source_id IS
  'V5-SOURCEENTITY-001. The shop, market or event where it changed hands, set ONLY when it differs '
  'from source_id ("Liz Young via Belchertown Plant Swap June"). NULL means not recorded or not '
  'distinct — it does NOT mean "same as source_id".';
COMMENT ON COLUMN public.inventory_items.source_id IS
  'V5-SOURCEENTITY-001. The ORIGINATOR — the brand or producer. For "Botanical Interests (via '
  'Gardener''s Supply Company, Hadley MA)" this is Botanical Interests, which is exactly what '
  'metadata->>''vendor'' already says on those 8 rows. Nullable and unbackfilled.';
COMMENT ON COLUMN public.inventory_items.acquired_from_source_id IS
  'V5-SOURCEENTITY-001. The shop where it was actually bought — Gardener''s Supply Company for the '
  '12 "(via …)" rows, which is exactly what metadata->>''purchase_location'' already says. NULL '
  'means not recorded or not distinct.';

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-sourceentity-001',
        'SOURCEENTITY: V5-SOURCEENTITY-001. New public.source catalogue (name, kind, locality, '
        'address, website_url, notes, generated match_key, soft-delete, RLS off matching '
        'plant_varieties) + partial-unique match_key index + kind index + set_updated_at trigger. '
        'plants and inventory_items each gain nullable source_id and acquired_from_source_id FKs '
        '(NO ACTION on delete) with a distinctness CHECK and four partial reverse-lookup indexes. '
        'TWO FKs because prod already records brand and shop as separate facts in '
        'metadata.vendor / metadata.purchase_location on 12 rows. Additive and expand-only: no view '
        'widened, no column altered, NO BACKFILL, no default, and plants.source_ref / '
        'inventory_items.source are untouched and remain the record of provenance. Substrate only '
        '- no Lambda or UI in this file.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;

-- Verify:
-- SELECT to_regclass('public.source');
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='public.source'::regclass ORDER BY conname;
-- SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
--  WHERE table_schema='public' AND column_name IN ('source_id','acquired_from_source_id')
--  ORDER BY table_name, column_name;
-- SELECT indexname FROM pg_indexes WHERE schemaname='public'
--  AND (tablename='source' OR indexname LIKE '%acquired_from_source%') ORDER BY 1;
