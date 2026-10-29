// new-file: no integration test existed for app-events
// TEMPORARY catalog probe: prints the constraints and columns the C6 pins need. Replaced by the real file.
import { describe, it } from 'vitest'
import { directSql } from './_harness.js'

const TABLES = ['app_events', 'ux_events', 'weather_cue_impression', 'user_notification_prefs', 'critter_species_prefs',
  'critter_state', 'daily_plan', 'user_achievements', 'achievements', 'rate_limit_buckets', 'user_stats', 'xp_events',
  'weather_cold_range']

describe('catalog probe', () => {
  it('prints constraints, columns and seed counts', async () => {
    const cons = await directSql`
      SELECT c.conrelid::regclass::text AS tbl, c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
       WHERE c.conrelid::regclass::text = ANY(${TABLES.map((t) => t)})
          OR c.conrelid::regclass::text = ANY(${TABLES.map((t) => 'public.' + t)})
       ORDER BY 1, 2`
    console.log('C6PROBE constraints\n' + cons.map((r) => `${r.tbl}|${r.conname}|${r.contype}|${r.def}`).join('\n'))
    const cols = await directSql`
      SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY(${TABLES})
       ORDER BY table_name, ordinal_position`
    console.log('C6PROBE columns\n' + cols.map((r) => `${r.table_name}|${r.column_name}|${r.data_type}|${r.is_nullable}|${r.column_default}`).join('\n'))
    const trg = await directSql`
      SELECT event_object_table AS tbl, trigger_name, action_timing, event_manipulation
        FROM information_schema.triggers
       WHERE event_object_schema = 'public' AND event_object_table = ANY(${TABLES})
       ORDER BY 1, 2`
    console.log('C6PROBE triggers\n' + trg.map((r) => `${r.tbl}|${r.trigger_name}|${r.action_timing}|${r.event_manipulation}`).join('\n'))
    const ach = await directSql`
      SELECT is_active, is_secret, COUNT(*)::int AS n FROM achievements GROUP BY 1, 2 ORDER BY 1, 2`
    console.log('C6PROBE achievements ' + JSON.stringify(ach))
    const kinds = await directSql`
      SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY(${['garden_node', 'container', 'plants', 'plant_projects', 'tasks']})`
    console.log('C6PROBE relkinds ' + JSON.stringify(kinds))
    try {
      await directSql`SELECT ${'a\u0000b'}::text AS x`
      console.log('C6PROBE nul: accepted')
    } catch (e) {
      console.log('C6PROBE nul: ' + e.code + ' ' + e.message)
    }
  })
})
