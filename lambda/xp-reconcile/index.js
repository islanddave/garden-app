// /api/xp-reconcile — V1.2a-1 Session 4
// Daily reconciliation Lambda. Invoked by EventBridge (rule: garden-xp-reconcile-daily, cron 0 4 * * ? *).
// NOT a Function URL endpoint — no HTTP entry; only EventBridge target.
//
// Behavior: compares user_stats.xp vs SUM(xp_events.amount) per user; heals drift.
// DRY_RUN=true → log drift only.
// DRY_RUN=false → apply UPDATE.
//
// First-run safety: initial deploy sets DRY_RUN=true. After one clean run (visible in CloudWatch logs),
// flip DRY_RUN=false via:
//   aws lambda update-function-configuration --function-name garden-xp-reconcile \
//     --environment Variables='{DRY_RUN=false}'
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

    // BUG-XPPROGRESSION-001 — `level` is deliberately NOT in this SET list, and that is the whole
    // argument for having made it a trigger rather than a caller obligation. This function rewrites
    // xp behind the Lambda's back at 04:00 daily; if level were computed at write time by the six
    // XP writers in lambda/events, every reconciliation that moved xp across a threshold would
    // leave level stale until the user happened to log again. trg_user_stats_level fires on this
    // UPDATE like any other and re-derives level from the healed xp, for free and with no edit to
    // this file's logic. `level` is added to RETURNING so a reconciliation that also moved someone's
    // level is visible in the CloudWatch log rather than silent.
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
