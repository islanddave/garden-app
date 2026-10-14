// V5-WXCOLDBAND-001 — tonight's forecast cold range, read for the Today card.
//
// public.weather_cold_range is written each morning by ONE job on the owner's Mac (WeatherNext 3
// ensemble, INSERT only; migrations/v5-wxcoldband-001). Nothing in AWS writes it, so "the job did not
// run" is the steady state, not an edge case: no row, a partial row, or yesterday's row all serve
// null and the card shows nothing. Display only — nothing alerts off this.
//
// Its own module and its own statement, never a JOIN onto the plan read: index.test.js reads
// index.js's tagged templates BY POSITION, and a missing or unreadable table must blank the range,
// not Today. The caller wraps this in try/catch as well; readColdRange itself throws on a DB error so
// a test can tell "no row" from "the read failed".
//
// Dependency-free (sql is injected) so the unit suite can EXECUTE it.

// The row the read accepts (migrations/v5-wxcoldband-001/README.md "For the two lanes that follow"):
//   * the place is one of the household's spaces (spaces.created_by, as loadOwnedSpace does);
//   * night_date is tonight in America/New_York — the same clock plan_date is served on;
//   * leads_read = leads_expected — a partial night is refused without trusting the job;
//   * init_time is not in the future and is before the night began (18:00 ET on night_date);
//   * newest init_time wins; created_at is served as the range's own freshness stamp.
export async function readColdRange(sql, householdIds) {
  if (!Array.isArray(householdIds) || householdIds.length === 0) return null;
  const rows = await sql`
    SELECT to_char(w.night_date, 'YYYY-MM-DD') AS night_date,
           w.init_time  AS init_time,
           w.p10_min_f  AS p10_min_f,
           w.p50_min_f  AS p50_min_f,
           w.created_at AS created_at
    FROM weather_cold_range w
    JOIN spaces s ON s.id = w.space_id
    WHERE s.created_by = ANY(${householdIds})
      AND w.night_date = (now() AT TIME ZONE 'America/New_York')::date
      AND w.leads_read = w.leads_expected
      AND w.init_time <= now()
      AND w.init_time < ((w.night_date + time '18:00') AT TIME ZONE 'America/New_York')
    ORDER BY w.init_time DESC, w.created_at DESC
    LIMIT 1
  `;
  return shapeColdRange(rows[0]);
}

const iso = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// numeric(5,2) arrives as a string from the driver. Anything that is not a finite number, or a pair
// out of order, is refused whole: the CHECKs make it impossible, and a wrong number on the card is
// worse than none.
export function shapeColdRange(row) {
  if (!row) return null;
  const low = Number(row.p10_min_f);
  if (row.p10_min_f == null || !Number.isFinite(low)) return null;
  let mid = null;
  if (row.p50_min_f != null) {
    mid = Number(row.p50_min_f);
    if (!Number.isFinite(mid) || mid < low) return null;
  }
  const nightDate = typeof row.night_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.night_date)
    ? row.night_date : null;
  const generatedAt = iso(row.created_at);
  if (!nightDate || !generatedAt) return null;
  return {
    night_date: nightDate,
    low_f: low,
    mid_f: mid,
    init_time: iso(row.init_time),
    wn3_generated_at: generatedAt,
  };
}
