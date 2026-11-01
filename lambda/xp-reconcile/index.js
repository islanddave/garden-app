// /api/xp-reconcile: daily reconciliation Lambda. Invoked by EventBridge (rule: garden-xp-reconcile-daily,
// cron 0 4 * * ? *). NOT a Function URL endpoint; EventBridge target only.
//
// Compares user_stats.xp vs SUM(xp_events.amount) per user and heals drift. DRY_RUN=true logs drift only;
// DRY_RUN=false applies the UPDATE. Initial deploy sets DRY_RUN=true; after one clean run (CloudWatch logs),
// flip it with:
//   scripts/lambda-env-set.sh garden-xp-reconcile DRY_RUN false
// NOT a bare `--environment Variables='{DRY_RUN=false}'`: that REPLACES the whole Variables map and would
// drop SECRET_REFRESH. The helper read-merges, guards on RevisionId, and verifies the key set after the write.
//
// Kill-switch: aws events disable-rule --name garden-xp-reconcile-daily

import { neon } from '@neondatabase/serverless';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

export const handler = async (event) => {
  const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  const startedAt = new Date().toISOString();
  console.log(JSON.stringify({ event: 'xp_reconcile_start', dry_run: dryRun, startedAt, source: event?.source ?? 'manual' }));

  const secrets = await getSecrets();
  const sql = neon(secrets.NEON_DATABASE_URL);

  try {
    const drift = await sql`
      SELECT
        us.user_id,
        us.xp AS user_stats_xp,
        COALESCE(SUM(xe.amount), 0)::int AS xp_events_sum,
        (us.xp - COALESCE(SUM(xe.amount), 0))::int AS drift
      FROM user_stats us
      LEFT JOIN xp_events xe ON xe.user_id = us.user_id
      GROUP BY us.user_id, us.xp
      HAVING us.xp <> COALESCE(SUM(xe.amount), 0)
    `;

    const totalAbsDrift = drift.reduce((s, r) => s + Math.abs(r.drift), 0);

    if (drift.length === 0) {
      console.log(JSON.stringify({ event: 'xp_reconcile_no_drift', dry_run: dryRun }));
      return { ok: true, dry_run: dryRun, users_with_drift: 0, total_abs_drift: 0 };
    }

    console.log(JSON.stringify({
      event: 'xp_reconcile_drift_detected',
      dry_run: dryRun,
      users_with_drift: drift.length,
      total_abs_drift: totalAbsDrift,
      sample: drift.slice(0, 20),
    }));

    if (dryRun) {
      console.log(JSON.stringify({ event: 'xp_reconcile_dry_run_complete', users_with_drift: drift.length, total_abs_drift: totalAbsDrift }));
      return { ok: true, dry_run: true, users_with_drift: drift.length, total_abs_drift: totalAbsDrift };
    }

    // BUG-XPPROGRESSION-001: `level` is deliberately NOT in this SET list; it is maintained by the
    // trg_user_stats_level trigger. This function rewrites xp at 04:00 daily, so a write-time level would
    // go stale whenever a reconciliation moved xp across a threshold. The trigger re-derives level from the
    // healed xp with no edit here. `level` is in RETURNING so a reconciliation that moved someone's level is
    // visible in CloudWatch.
    const updated = await sql`
      UPDATE user_stats us
      SET xp = COALESCE((SELECT SUM(amount)::int FROM xp_events xe WHERE xe.user_id = us.user_id), 0),
          updated_at = NOW()
      WHERE us.xp <> COALESCE((SELECT SUM(amount)::int FROM xp_events xe WHERE xe.user_id = us.user_id), 0)
      RETURNING user_id, xp, level
    `;

    console.log(JSON.stringify({
      event: 'xp_reconcile_applied',
      rows_updated: updated.length,
      total_abs_drift: totalAbsDrift,
    }));

    return { ok: true, dry_run: false, rows_updated: updated.length, total_abs_drift: totalAbsDrift };
  } catch (err) {
    console.error(JSON.stringify({ event: 'xp_reconcile_error', message: err?.message ?? String(err) }));
    throw err;
  }
};
