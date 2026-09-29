-- view-parity.sql — V5-FERMENTPATH-001, 06-ferment-path §5.1 (b). READ-ONLY.
-- Run IMMEDIATELY before and IMMEDIATELY after 0a on the same database (the Neon branch of prod at the
-- sitting, and staging), and compare the two output lines byte for byte. 0a re-creates
-- v_kitchen_batch_current with nine columns appended; this proves the 31 columns every shipped reader
-- sees (and the two counts) did not move for any live batch.
--   psql "$URL" -X -At -v ON_ERROR_STOP=1 -f view-parity.sql > before.txt
--   ... apply 0a ...
--   psql "$URL" -X -At -v ON_ERROR_STOP=1 -f view-parity.sql > after.txt
--   cmp before.txt after.txt && echo identical
SELECT count(*) AS batches,
       md5(COALESCE(string_agg(
         concat_ws('|', v.id, v.user_id, v.label, v.kind, v.kind_other, v.started_at, v.start_precision,
                   v.start_anchor_kind, v.start_anchor_id, v.first_recorded_at, v.expected_days_min,
                   v.expected_days_max, v.brine_note, v.suspended_at, v.closed_at, v.outcome,
                   v.outcome_note, v.cover_photo_id, v.notes, v.created_at, v.updated_at, v.deleted_at,
                   v.current_stage_kind, v.current_stage_label, v.current_stage_entered_at,
                   v.current_storage_location_id, v.input_count, v.output_count, v.last_ph_reading,
                   v.last_ph_read_at, v.idempotency_key),
         E'\n' ORDER BY v.id), '')) AS cols_1_31_md5,
       sum(v.input_count) AS input_count_total,
       sum(v.output_count) AS output_count_total
  FROM public.v_kitchen_batch_current v;
