# Touch (edit + push to dev) to fire .github/workflows/revert-rehearsal.yml.
# NO APPROVAL PAUSE (verified 2026-09-10). environment:production has ZERO required reviewers -- a
# branch/tag ref policy only, since 2026-06-22 -- so the run does NOT stop for Dave and staging is mutated
# as soon as this file is pushed. (environment:production-destructive, used by revert-gate.yml, DOES
# require islanddave; this rehearsal is not that.) Push only when you mean to fire it.
# PREREVERT_VERSION omitted on purpose -> harness defaults to a run-unique v0.0.<run_number>.
MODE=abort
TARGET_VERSION=v0.0.0
# fire: abort-path rehearsal (run4)
