-- 0a-additive-ddl.sql
-- V4-SEEDGERMRATE-001 (BD-057) — per-packet germination rate.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-germrate-001/0a-additive-ddl.sql
--
-- ── THE DESIGN, SETTLED WITH DAVE RATHER THAN GUESSED ───────────────────────────────────────────
-- BD-057 flagged two questions as must-ask. Both are answered, and the first answer corrected the
-- premise of the recon that preceded it.
--
-- I measured `SELECT count(*) FROM event_log WHERE event_type='sowing'` = 0 and reported that there
-- was nothing to derive a rate from. Dave: "The Sow event triggers the creation of a planting, so
-- it isn't really an event unless it gets saved as such at that point." The count was right and the
-- inference was wrong — sowing is not logged as an event because **the sowing IS the planting**.
-- InventoryDetail's Sow CTA carries source_inventory_item_id into PlantingEditor, which POSTs a
-- planting bearing that packet id (44 of 313 plantings carry one today).
--
-- So the unit of a sowing is a PLANTING ROW, and both counts belong on it:
--   Dave: "I will put in seed count sown and later record germinations (not the first germination
--   event, that is just noting at least one popped up, it would be a separate log of some sort —
--   doubt it is an event - its a data point.)"
-- Hence two plain columns, NOT an event type and NOT a side table. `germinated_at` already exists
-- and keeps its meaning — the DATE something first came up — and is deliberately left alone;
-- seeds_germinated is the COUNT, which is the thing it could never carry.
--
-- Q2, accumulation across multiple sowings from one packet: Dave chose "combine them, keep the
-- history". That needs no schema of its own — each sowing is already its own planting row, so the
-- packet's rate is SUM(seeds_germinated) / SUM(seeds_sown) over the plantings sharing its
-- source_inventory_item_id, and the per-sowing history is those rows. This is the whole reason the
-- counts go on the planting rather than on inventory_items: a single pair of numbers on the packet
-- could not have answered "80% in March, 45% in July" without inventing a history table.
--
-- ── WHY NOT REUSE qty_initial ───────────────────────────────────────────────────────────────────
-- Checked before adding a column. `qty_initial` is set on 247 of 264 live plantings and
-- SERVER-DEFAULTS TO `quantity` (PlantForm.jsx:10, labelled "Initial quantity … Defaults to the
-- quantity above"). It is a PLANT count. Sow 20 seeds, get 14 up, keep 12 after thinning: none of
-- those three numbers is the other two, and overloading qty_initial to mean "seeds" on the rows
-- that happen to come from a packet would make every existing quantity reading ambiguous.
--
-- ── THREE OBJECTS, AND WHY THE VIEW IS ONE OF THEM ──────────────────────────────────────────────
-- lambda/plants reads and writes `public.garden_node`, which is an auto-updatable VIEW over
-- `public.plants` with an explicit column list (no INSTEAD OF triggers — verified). A column added
-- only to the table is invisible to every API path. CREATE OR REPLACE VIEW can only APPEND columns,
-- which is exactly what this does; nothing above is reordered or renamed.
BEGIN;

ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS seeds_sown       integer,
  ADD COLUMN IF NOT EXISTS seeds_germinated integer;

-- Both columns are new and every existing row is NULL, so these validate instantly and cannot
-- reject a write the currently-deployed Lambda makes — it does not know these columns exist.
-- (Contrast the arming-a-CHECK hazard, where VALIDATE breaks a still-deployed old writer.)
-- No cross-column `germinated <= sown` rule, deliberately: volunteers, a miscount, and a packet
-- sown across two flats all produce a legitimate over-count, and a save that refuses Dave's real
-- number is worse than a rate above 100% he can see and correct.
ALTER TABLE public.plants
  ADD CONSTRAINT chk_plants_seeds_sown_positive
    CHECK (seeds_sown IS NULL OR seeds_sown > 0),
  ADD CONSTRAINT chk_plants_seeds_germinated_nonneg
    CHECK (seeds_germinated IS NULL OR seeds_germinated >= 0);

CREATE OR REPLACE VIEW public.garden_node AS
SELECT id,
    project_id AS container_id,
    name AS display_name,
    quantity,
    notes,
    status,
    planted_at,
    created_by,
    created_at,
    updated_at,
    deleted_at,
    location_id,
    featured_image_id,
    variety_id AS cultivar_id,
    source_inventory_item_id,
    metadata,
    featured_photo_id,
    sown_at,
    germinated_at,
    transplanted_at,
    planted_out_at,
    sown_at_approx,
    germinated_at_approx,
    transplanted_at_approx,
    planted_out_at_approx,
    qty_initial,
    qty_current,
    qty_harvested,
    qty_lost,
    loss_cause,
    source_type,
    source_ref,
    source_generation,
    parent_plant_id,
    divergence_type,
    lineage_note,
    succession_group_id,
    succession_order,
    container_type,
    container_size,
    kind,
    workspace_id,
    last_seen_at,
    attr_override,
    version,
    archived_at,
    assignee_user_id,
    rain_exposed,
    rain_exposed_source,
    rain_exposed_set_at,
    acquired_mature,
    acquired_mature_source,
    acquired_mature_set_at,
    seeds_sown,
    seeds_germinated
   FROM plants;

-- ── KEEP THE AUDIT TRAIL HONEST ─────────────────────────────────────────────────────────────────
-- v4-plantingaudit-001 armed trg_audit_plants_upd with a watched set naming 46 columns. That set is
-- baked into the trigger's arguments, so two NEW user-editable columns would be invisible to it —
-- silently, with every gate in that migration still green. A germination count that can be edited
-- without leaving a trace is precisely the gap BUG-NOPLANTINGAUDIT-001 was filed about, reopened
-- one row later. Re-created here with 48.
--
-- Guarded on the arm actually being present: on an environment where v4-plantingaudit-001 has not
-- been applied, this block is a no-op rather than an error, and that migration's own 0a will create
-- the trigger — with the OLD 46-column list. Re-run this file after it, or the two new columns stay
-- unwatched. The 0c gate below is what catches that ordering mistake.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE c.relname = 'plants' AND t.tgname = 'trg_audit_plants_upd') THEN
    DROP TRIGGER trg_audit_plants_upd ON public.plants;
    CREATE TRIGGER trg_audit_plants_upd
      AFTER UPDATE ON public.plants
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT
      EXECUTE FUNCTION public.audit_stmt_update(
        'project_id', 'name', 'status', 'kind', 'location_id', 'variety_id',
        'workspace_id', 'assignee_user_id', 'created_by', 'created_at',
        'planted_at', 'sown_at', 'germinated_at', 'transplanted_at', 'planted_out_at',
        'sown_at_approx', 'germinated_at_approx', 'transplanted_at_approx', 'planted_out_at_approx',
        'quantity', 'qty_initial', 'qty_current', 'qty_harvested', 'qty_lost', 'loss_cause',
        'seeds_sown', 'seeds_germinated',
        'source_inventory_item_id', 'source_type', 'source_ref', 'source_generation',
        'parent_plant_id', 'divergence_type', 'lineage_note',
        'succession_group_id', 'succession_order',
        'container_type', 'container_size',
        'featured_photo_id', 'featured_image_id', 'notes', 'metadata', 'attr_override',
        'rain_exposed', 'rain_exposed_source', 'acquired_mature', 'acquired_mature_source',
        'deleted_at', 'archived_at'
      );
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.56.0-germrate-001',
        'V4-SEEDGERMRATE-001 0a: plants.seeds_sown + plants.seeds_germinated (nullable, CHECKed), exposed on garden_node, added to the plants audit watched set.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
