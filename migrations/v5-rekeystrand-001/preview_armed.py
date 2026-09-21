#!/usr/bin/env python3
"""preview_armed.py — what v5-rekeystrand-001's gates WOULD say on a real environment if 0a were applied.

READ-ONLY. Every standing gate here is self-armed on its own receipt, so before 0a runs the shipped gates
are vacuously green and cannot tell you whether arming will turn gate-invariants.yml red on day one. This
derives an armed copy of the shipped gates.yml by deleting exactly the receipt conjunct (asserted to occur
three times, else it refuses), runs the three standing post gates through gate_runner's own read-only
connection (conn.read_only = True, owner DSN, RLS-exempt), and lists every row the guard would count —
from the guard's own SQL with only its SELECT list widened, so the list is exactly what the gate counts.

  export NEON_DATABASE_URL="$(/usr/bin/grep -m1 '^NEON_DATABASE_URL=' <garden-app>/.env.local | cut -d= -f2-)"
  python3 migrations/v5-rekeystrand-001/preview_armed.py --env prod      # NEON_STAGING_URL for --env staging

Exit 0 = ARM-SAFE (every armed gate would pass). Exit 1 = arming now reds the job; the rows are printed.
Exit 2 = could not evaluate (derivation mismatch, unreachable database, query error) — never a pass.
"""
import argparse
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "scripts"))
import gate_runner as gr  # noqa: E402

ARM = ("         AND EXISTS (SELECT 1 FROM public.schema_version\n"
       "                      WHERE version = '5.0.0-rekeystrand-20260908')\n")
GUARD = "post_no_rekey_stranded_care_profile"
DETAIL = ("SELECT r.old_v::text, coalesce(pv.name, '<no variety row>'), cp.profile->>'_source', "
          "cp.profile->>'_basis', (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(cp.profile) AS k) "
          "FROM rekeyed r LEFT JOIN public.plant_varieties pv ON pv.id = r.old_v")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--env", required=True, choices=("prod", "staging"))
    args = ap.parse_args(argv)

    shipped = (HERE / "gates.yml").read_text()
    if shipped.count(ARM) != 3:
        print(f"FATAL: expected 3 receipt conjuncts in gates.yml, found {shipped.count(ARM)} — "
              "the armed copy would not be the shipped gates", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d) / "gates.armed-preview.yml"
        tmp.write_text(shipped.replace(ARM, ""))
        gates = [g for g in gr.load_gate_file(tmp) if g["phase"] == "post" and g["continuous"]]
    if sorted(g["name"] for g in gates) != sorted([GUARD, "post_rekey_audit_trigger_still_feeds_the_guard",
                                                   "post_retained_marker_states_a_reason"]):
        print("FATAL: the standing post gates changed; update this preview", file=sys.stderr)
        return 2
    guard_sql = next(g["sql"] for g in gates if g["name"] == GUARD)
    detail_sql, n = re.subn(r"SELECT 1\s+FROM rekeyed r\b", DETAIL, guard_sql)
    if n != 1:
        print("FATAL: the guard's SELECT list changed shape; refusing to guess the detail query", file=sys.stderr)
        return 2
    detail_sql = gr.validate_sql_readonly(detail_sql, "detail")

    try:
        url, _ = gr.resolve_url(args.env)
        conn = gr.connect(url)
    except SystemExit as exc:  # gate_runner's FATAL (unset URL, unreachable) exits 1; here it is a 2
        print(exc, file=sys.stderr)
        return 2
    try:
        results = gr.run_gates(conn, gates, args.env, strict_env=False)
        try:
            with conn.cursor() as cur:
                cur.execute(detail_sql)
                rows = cur.fetchall()
        except Exception as exc:
            code = getattr(exc, "sqlstate", None) or type(exc).__name__
            print(f"FATAL: detail query failed ({code}): {str(exc).strip().splitlines()[0][:200]}", file=sys.stderr)
            return 2
    finally:
        conn.close()

    print(f"ARMED PREVIEW ({args.env}) — shipped gates.yml minus the receipt conjunct, read-only")
    for r in results:
        print(f"  {r['status']:<5} {r['name']}: {r['detail']}")
    for v, name, src, basis, keys in rows:
        print(f"    would count: {v}  {name}  _source={src or '-'}  _basis={basis or '-'}  keys=[{keys}]")
    if any(r["status"] == "ERROR" for r in results):
        return 2
    bad = sum(r["status"] != "PASS" for r in results)
    print("ARM-SAFE" if not bad else f"NOT ARM-SAFE: arming now reds gate-invariants.yml ({bad} gate(s))")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
