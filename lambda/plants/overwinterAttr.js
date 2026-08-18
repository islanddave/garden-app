// V4-OVERWINTERCARE-001 — the WRITER for the overwintering care attribute.
//
// v4.34.0 shipped the whole READ half of overwintering (lambda/daily-plan/overwinter.js: four
// regimes, a reduced-cadence moisture check, a daylength-computed window that expires by itself)
// and it is completely INERT in prod: zero care_profile rows carry the key, because nothing in the
// app could write one. This module is the missing half. It does not redesign anything — the key
// shape below is exactly what overwinterProfile() already parses.
//
// WHY A DEDICATED SUB-ROUTE AND NOT A COLUMN ON THE PUT. The attribute does not live on the
// planting row at all; it lives in care_profile at scope='leaf', keyed scope_id = the planting id.
// Folding it into PUT /api/plants/:id would make one request write two tables through two entirely
// different idioms (a COALESCE-merge UPDATE and a jsonb upsert), and the PUT's "omitted key means
// unchanged" contract has no way to express "delete this key" — which is the clear path, i.e. the
// half that makes the feature reversible. PATCH /api/plants/:id/overwinter is modelled on the
// /archive sub-route immediately above it in index.js: same ownership predicate, same 404 shape,
// same set/clear symmetry in one verb.
//
// THE WRITE IS A KEY-LEVEL MERGE, NEVER A ROW REPLACE. A leaf care_profile row may already carry
// other keys (a per-planting water_interval_days override is the designed use of leaf scope, and
// is the ONLY thing that puts 'leaf' into v_resolved_care.cadence_scopes). Writing the profile
// wholesale would silently delete that override the first time anyone marked a plant overwintering
// — a cadence regression disguised as a feature. So SET is `profile || {overwintering:…}` and
// CLEAR is `profile - 'overwintering'`, both key-scoped.
//
// AND CLEAR DROPS A ROW THAT BECOMES EMPTY. v_resolved_care.resolved_scopes reports 'leaf' whenever
// a leaf ROW EXISTS, empty profile or not. Leaving `{}` behind would make a cleared planting
// permanently indistinguishable from one carrying a real leaf profile in the one column that exists
// to answer that question. Clearing has to be a true undo of setting, including at the row level.

// The regime allowlist. Deliberately a LOCAL constant rather than a require of
// lambda/daily-plan/overwinter.js: deploy-lambda.yml zips each lambda/<fn> directory on its own
// (`cd lambda/${fn} && zip -r ../${fn}.zip .`), so a cross-Lambda require resolves in the repo and
// is MISSING in the deployed artifact — green tests, 500 in prod. The two lists are held together
// by overwinter-writer.test.js, which cross-imports the daily-plan module (a test may reach across;
// a runtime may not) and asserts the key sets are identical.
export const REGIMES = ['protected_productive', 'protected_quiescent', 'field_hardy', 'tender_indoors'];

// The free-text override that replaces the regime's stock guidance in the emitted care row. Capped
// rather than rejected on length: the value is rendered into a task row, and a runaway paste should
// truncate a card, not fail a save Dave is making with a plant already under cover.
export const MAX_NOTE = 400;

// 'MM-DD' or a full ISO date. overwinterProfile() slices the last 5 chars off whatever it finds, so
// both forms already work downstream; validating here keeps '3/15' and 'March' out of the column.
function normDate(v, label) {
  if (v == null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: `${label} must be a string` };
  const s = v.trim();
  const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { ok: false, error: `${label} must be MM-DD or YYYY-MM-DD` };
  const mo = Number(m[1]), d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false, error: `${label} is not a real date` };
  return { ok: true, value: s };
}

// Body -> intent. Two shapes are accepted because two callers exist: the picker sends
// {regime:'…'} / {regime:null}, and a script or a future bulk surface may send the attribute as it
// is stored, {overwintering:{…}} / {overwintering:false}. `false` and `null` both mean CLEAR, which
// matches readAttr()'s treatment of a stored `false` as absent — the two ends agree on what "off"
// is rather than each inventing it.
//
// AN UNKNOWN REGIME IS REJECTED HERE even though overwinterState() already fails SAFE on one
// (unknown -> protected_productive, with the offending value reported as unknown_regime). The eval
// path is lenient so a bad row still gets checked rather than silently dropped; that is not a
// reason to STORE a bad row. The writer is the last point at which a typo is still attached to the
// human who can fix it — past here the planting runs on a regime nobody chose, indefinitely, with
// the evidence buried in a jsonb blob nothing in the app displays.
export function parseOverwinterBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const hasOw = Object.prototype.hasOwnProperty.call(b, 'overwintering');
  if (hasOw && (b.overwintering === false || b.overwintering === null)) return { ok: true, clear: true };
  if (Object.prototype.hasOwnProperty.call(b, 'regime') && b.regime === null) return { ok: true, clear: true };

  const src = hasOw && b.overwintering && typeof b.overwintering === 'object' ? b.overwintering : b;
  const regime = src.regime;
  if (typeof regime !== 'string' || !REGIMES.includes(regime)) {
    return { ok: false, error: `regime must be one of: ${REGIMES.join(', ')}` };
  }
  const from = normDate(src.from, 'from');
  if (!from.ok) return { ok: false, error: from.error };
  const until = normDate(src.until, 'until');
  if (!until.ok) return { ok: false, error: until.error };
  if (src.note != null && typeof src.note !== 'string') return { ok: false, error: 'note must be a string' };
  const note = typeof src.note === 'string' ? src.note.trim().slice(0, MAX_NOTE) : '';

  // Only non-null keys are stored. An absent `from`/`until` is what makes the window fall back to
  // the computed Persephone dates, which is the automatic exit — writing explicit nulls would be
  // equivalent, but a sparse object keeps "Dave chose this date" visibly distinct from "the model
  // chose it" when anyone reads the row.
  const attr = { regime };
  if (from.value) attr.from = from.value;
  if (until.value) attr.until = until.value;
  if (note) attr.note = note;
  return { ok: true, attr };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH /api/plants/:id/overwinter. Returns {status, body} for the caller to hand to resp().
export async function setOverwinterCore(sql, { plantId, householdIds, body }) {
  if (!UUID_RE.test(String(plantId))) return { status: 404, body: { error: 'Not found' } };

  const parsed = parseOverwinterBody(body);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  // Ownership + liveness preflight. Same predicate as /archive and the PUT — the container arm with
  // the V4-SOFTDEL-001 F4 deleted-container gate, plus the BUG-PLANTLESSWRITE-001 project-less arm.
  // Aliased `gn`, not `p`, following the /restore preflight: this is a state check, not a
  // client-facing plant read, and select-columns.test.js scopes its every-column guard to
  // `FROM public.garden_node p` blocks for exactly that reason.
  const [owned] = await sql`
    SELECT gn.id
      FROM public.garden_node gn
      LEFT JOIN public.container pp ON pp.id = gn.container_id
     WHERE gn.id = ${plantId}
       AND gn.deleted_at IS NULL
       AND (( pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL )
            OR (gn.container_id IS NULL AND gn.created_by = ANY(${householdIds})))
  `;
  if (!owned) return { status: 404, body: { error: 'Not found' } };

  if (parsed.clear) {
    // Two statements in ONE transaction. The neon serverless client issues a request per tagged
    // call, so a bare sequence of awaits is a sequence of transactions and a failure between them
    // leaves a `{}` row behind — the exact resolved_scopes lie this branch exists to prevent.
    // DELETE runs FIRST and tests the POST-removal value: a row whose only key is `overwintering`
    // goes away entirely, and a row with other keys survives to be edited by the UPDATE. Ordering
    // them the other way would need the UPDATE's result to be visible to the DELETE, which inside a
    // single statement it is not.
    await sql.transaction([
      sql`DELETE FROM care_profile
           WHERE scope = 'leaf' AND scope_id = ${plantId}::uuid
             AND (profile - 'overwintering') = '{}'::jsonb`,
      sql`UPDATE care_profile
             SET profile = profile - 'overwintering', updated_at = now()
           WHERE scope = 'leaf' AND scope_id = ${plantId}::uuid
             AND profile ? 'overwintering'`,
    ]);
    // Idempotent by construction: clearing a planting that was never set matches zero rows in both
    // statements and still answers 200 with null, like the /restore route's already_restored arm.
    return { status: 200, body: { id: plantId, overwintering: null } };
  }

  // ON CONFLICT infers the partial unique index care_profile (scope, scope_id) WHERE scope<>'system'
  // — the same conflict target migrations/care-cadence-001-seed.sql upserts 159 cultivar rows
  // through. `||` is a shallow right-wins merge, so only the overwintering key is replaced.
  // workspace_id is left to the column DEFAULT sentinel (never set by hand — see the seen_event
  // INSERT in index.js). scope_id needs the explicit ::uuid: the parameter arrives as text and
  // Postgres cannot infer the type across the ON CONFLICT arm (L-086 class).
  const rows = await sql`
    INSERT INTO care_profile (scope, scope_id, profile, model_version)
    VALUES ('leaf', ${plantId}::uuid, jsonb_build_object('overwintering', ${JSON.stringify(parsed.attr)}::jsonb), 1)
    ON CONFLICT (scope, scope_id) WHERE scope <> 'system'
    DO UPDATE SET profile = care_profile.profile || excluded.profile, updated_at = now()
    RETURNING profile -> 'overwintering' AS overwintering
  `;
  return { status: 200, body: { id: plantId, overwintering: rows[0]?.overwintering ?? parsed.attr } };
}
