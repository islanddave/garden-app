# Touch (edit + push to dev) to fire .github/workflows/revert-rehearsal.yml.
# Run pauses at environment:production for Dave's approval before any staging mutation.
# PREREVERT_VERSION omitted on purpose -> harness defaults to a run-unique v0.0.<run_number>.
MODE=dump_path
TARGET_VERSION=v0.0.0
# fire: post-get()-fix (run3)
