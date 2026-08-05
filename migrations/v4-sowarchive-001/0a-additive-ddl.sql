-- 0a-additive-ddl.sql
-- V4-SOWARCHIVE-001 — archive-for-the-season on the Sow Now list.
-- Dave 2026-08-05: "some things I've already sown and I'm not going to sow more, so I don't want to
-- see them on the list. I want to kind of archive them. They should still show up somewhere on the
-- page, just at the bottom. And then from there I can unarchive them."
--
-- WHY A SEASON YEAR AND NOT A BOOLEAN. "Archive for the season" has to end. A boolean would need a
-- cron (or a New Year's Day migration) to clear it, and a job that silently fails leaves every
-- packet hidden for a year. Stamping the SEASON makes expiry a property of the read: the client
-- filters `sow_archived_season = <engine year>`, so on 1 Jan the predicate simply stops matching and
-- everything returns on its own. No job to run, no job to fail.
--
-- WHY THAT YEAR IS THE CLIENT'S AND NOT NOW()'s. sowEngine derives its working year from the
-- todayISO it is handed (sowEngine.js:683, getUTCFullYear of a LOCAL calendar date), and SowNow
-- builds that date locally (localTodayISO). If the server stamped EXTRACT(YEAR FROM now()) instead,
-- an archive made on 31 Dec at 8pm ET would be written as the NEXT year in UTC and stay hidden for
-- all of it. The write takes the season the client is actually looking at, so the stamp and the
-- filter cannot disagree by construction. The route still range-checks it (2000..2100).
--
-- WHY NOT status='retired'. inventory_items.status already allows 'retired', and it is the wrong
-- tool: status is a WHOLE-INVENTORY fact, so retiring a packet would also drop it out of the
-- Inventory page and out of v_sow_candidates entirely (the view filters status='active'), which is
-- the opposite of the ask — Dave wants it off the ACTIVE list but still on the page, unarchivable.
-- This needs a Sow-Now-scoped field, which is what these two columns are.
--
-- WHY THE VIEW EXPOSES IT RATHER THAN FILTERING IT. Archived packets must still be returned; the
-- bottom section is built client-side from the same payload. A view that filtered them would make
-- the archived list unreachable without a second round trip.
--
-- HOUSEHOLD-SCOPED, NOT PER-USER (Dave 2026-08-05). "I've already sown these" is a fact about the
-- garden, not a personal view preference, and v_sow_candidates is already household-scoped at the
-- route (created_by = ANY(householdIds)). Per-user would need a separate join table; this is one
-- column. If that ever changes, this is the migration to revisit.
--
-- SAFETY: additive. Two nullable columns, no defaults; a CREATE OR REPLACE of v_sow_candidates that
-- ADDS two columns (31 -> 33) and changes nothing else. The read path is `SELECT *`, so the new
-- columns are transparent to it, and a frontend that has not shipped yet simply never reads them.
-- Re-running is a clean no-op.
--
-- ON THE CHECK CONSTRAINT. Adding a CHECK validates existing rows and constrains the CURRENTLY
-- DEPLOYED writer, which is normally a deploy-shaped risk rather than a migration-shaped one. It is
-- safe here specifically because no shipped code writes either column: every existing row is
-- (NULL, NULL), which satisfies the constraint, and the old writers cannot violate it because they
-- never reference these columns at all. An UPDATE from the old inventory PUT path leaves both
-- values untouched and therefore still paired.

BEGIN;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS sow_archived_season integer,
  ADD COLUMN IF NOT EXISTS sow_archived_at timestamp with time zone;

COMMENT ON COLUMN public.inventory_items.sow_archived_season IS
  'Season (calendar year) this seed packet was archived OUT of the active Sow Now buckets. NULL = not archived. Expiry is a property of the read: the client shows it as archived only while this equals the engine year, so it returns by itself next season. Set from the CLIENT year to stay consistent with sowEngine (see 0a header).';

COMMENT ON COLUMN public.inventory_items.sow_archived_at IS
  'When the packet was archived from Sow Now. Display/audit only — sow_archived_season is the filter key. Paired with it by chk_sow_archive_pair.';

-- Both set or both clear. Guards the half-write that would otherwise read as archived-forever
-- (season set, at NULL) or archived-never (at set, season NULL).
ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS chk_sow_archive_pair;
ALTER TABLE public.inventory_items
  ADD CONSTRAINT chk_sow_archive_pair
  CHECK ((sow_archived_season IS NULL) = (sow_archived_at IS NULL));

-- Partial index: archived packets are a small minority of a small table, and every read of them is
-- "which of MY packets are archived". Cheap, and keeps the sequential scan off the hot path if the
-- seed inventory grows.
CREATE INDEX IF NOT EXISTS idx_inventory_sow_archived
  ON public.inventory_items (created_by, sow_archived_season)
  WHERE sow_archived_season IS NOT NULL AND deleted_at IS NULL;

-- Expose both columns to the client.
--
-- THE WHERE CLAUSE IS LOAD-BEARING AND IS REPRODUCED VERBATIM FROM THE LIVE DEFINITION (read via
-- pg_get_viewdef immediately before writing this file, at 31 columns incl. ct.dtm_basis). It is what
-- makes this view "active seed packets" rather than "every inventory row that happens to have a
-- variety". CREATE OR REPLACE VIEW validates column names, types and ORDER — and is entirely
-- indifferent to the WHERE, so it would NOT catch an omission here. Post-gates assert the filter
-- survived, on both the definition text and the row count. This trap already bit v4-sowfirstyear-001;
-- the defence is diffing against pg_get_viewdef, which is how this definition was produced.
--
-- NOTE the two new columns are APPENDED LAST. CREATE OR REPLACE VIEW can only add columns at the
-- end — inserting them mid-list fails outright.
CREATE OR REPLACE VIEW public.v_sow_candidates AS
SELECT i.id AS inventory_item_id,
       i.name AS item_name,
       i.quantity_on_hand,
       i.unit,
       i.created_by,
       i.purchase_date,
       i.source,
       i.metadata,
       v.id AS variety_id,
       v.name AS variety_name,
       v.crop_type_slug,
       v.lifecycle,
       v.grown_as,
       v.sun_requirements,
       v.days_to_maturity_min,
       v.days_to_maturity_max,
       v.start_method,
       v.start_indoor_weeks_min,
       v.start_indoor_weeks_max,
       v.direct_sow_timing,
       v.sow_depth_in,
       v.seed_spacing_in,
       v.row_spacing_in,
       v.days_to_germ_min,
       v.days_to_germ_max,
       v.sow_season,
       v.sow_notes,
       v.growth_habit,
       v.day_length_response,
       ct.first_year_harvest,
       ct.dtm_basis,
       i.sow_archived_season,
       i.sow_archived_at
  FROM inventory_items i
  JOIN plant_varieties v ON v.id = i.variety_id
  LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
 WHERE i.category = 'seeds'::text
   AND i.deleted_at IS NULL
   AND i.status = 'active'::text
   AND v.deleted_at IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.17.0-sowarchive-001','SOWARCHIVE: inventory_items.sow_archived_season int + sow_archived_at timestamptz (both nullable, paired by chk_sow_archive_pair) + partial index + v_sow_candidates gains both (31->33 cols). Lets a seed packet be archived OUT of the active Sow Now buckets into a bottom section for the rest of the season, unarchivable from there. Season-stamped so expiry is a property of the read (no cron): the client filters season = engine year, so archives release themselves on 1 Jan. Season comes from the CLIENT to stay consistent with sowEngine local-year derivation. Household-scoped, not per-user. NOT status=retired, which is a whole-inventory fact and would drop the packet from the view entirely.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
