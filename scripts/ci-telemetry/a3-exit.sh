#!/usr/bin/env bash
# The A3 trial's two exit checks at the current checkout (THE A3 TRIAL in .github/workflows/ci-next.yml):
#   E1  every node-project test makes the same number of assertions under jsdom as under node;
#   E2  the statements, functions and branch arms covered in every module those tests load are the same.
#
# Run: scripts/ci-telemetry/a3-exit.sh OUT_DIR        (OUT_DIR: empty or not there yet, and outside the checkout)
#
# Seven vitest runs of ./a3-exit.config.mjs, one after another, each into OUT_DIR/<run> with its output in
# OUT_DIR/<run>.log:
#   e1-jsdom  e1-node                             no coverage: tests.jsonl, one line per test
#   e2-jsdom-a  e2-jsdom-b  e2-node-a  e2-node-b  coverage on: coverage/coverage-final.json. Twice per environment
#                                                 because v8 does not count every file the same twice (one file
#                                                 moved 176 branch arms between two node runs of one tree), so
#                                                 only what both runs of an environment agree on is compared
#   e2-setup                                      the control: what the repo setup file alone loads under jsdom
# then ./a3-exit.py e1 and e2 on them (OUT_DIR/e1.txt, OUT_DIR/e2.txt) and the two verdict lines.
#
# Exit 0 only when the verdicts are E1-SAME and E2-SAME and every vitest run exited 0. A run with a failing test is
# still compared (a test that fails the same way on both sides is not a difference) but is not a clean measurement,
# so it is said (RUNS-RED) and the exit is 1. Needs node_modules (npm ci) and python3; uses no network.
set -uo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: a3-exit.sh OUT_DIR" >&2
  exit 2
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "${here}/../.." && pwd -P)"
mkdir -p "$1" || exit 2
out="$(cd "$1" && pwd -P)"
case "${out}/" in
  "${repo}/"*) echo "a3-exit.sh: OUT_DIR ${out} is inside the checkout: give a directory outside it" >&2; exit 2 ;;
esac
if [ -n "$(ls -A "${out}")" ]; then
  echo "a3-exit.sh: OUT_DIR ${out} is not empty: runs of two trees must not mix" >&2
  exit 2
fi
if [ ! -x "${repo}/node_modules/.bin/vitest" ]; then
  echo "a3-exit.sh: no ${repo}/node_modules/.bin/vitest: run npm ci first" >&2
  exit 2
fi

{
  echo "sha $(git -C "${repo}" rev-parse HEAD)"
  echo "uncommitted $(git -C "${repo}" status --porcelain | wc -l | tr -d ' ') paths"
  echo "node $(node --version), .nvmrc $(cat "${repo}/.nvmrc" 2>/dev/null || echo none)"
  echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "${out}/meta.txt"
if [ "$(node --version)" != "v$(cat "${repo}/.nvmrc" 2>/dev/null)" ]; then
  echo "NOTE: this is not the Node of .nvmrc and CI: the result is for $(node --version)" | tee -a "${out}/meta.txt"
fi

red=0
# run NAME ENV [VAR=value …]
run() {
  local name="$1" mode="$2" began code
  shift 2
  began="$(date +%s)"
  (cd "${repo}" && env TZ=UTC A3_EXIT_ENV="${mode}" A3_EXIT_OUT="${out}/${name}" "$@" \
    node_modules/.bin/vitest run --config scripts/ci-telemetry/a3-exit.config.mjs) >"${out}/${name}.log" 2>&1
  code=$?
  [ "${code}" -eq 0 ] || red=$((red + 1))
  echo "run ${name}: vitest exit ${code}, $(($(date +%s) - began))s" | tee -a "${out}/meta.txt"
}

run e1-jsdom jsdom
run e1-node node
run e2-jsdom-a jsdom A3_EXIT_WIDE=1
run e2-jsdom-b jsdom A3_EXIT_WIDE=1
run e2-node-a node A3_EXIT_WIDE=1
run e2-node-b node A3_EXIT_WIDE=1
run e2-setup jsdom A3_EXIT_WIDE=1 A3_EXIT_CONTROL=1

final() { echo "${out}/$1/coverage/coverage-final.json"; }
python3 "${here}/a3-exit.py" e1 "${out}/e1-jsdom/tests.jsonl" "${out}/e1-node/tests.jsonl" >"${out}/e1.txt" 2>&1
e1=$?
python3 "${here}/a3-exit.py" e2 "$(final e2-jsdom-a)" "$(final e2-jsdom-b)" "$(final e2-node-a)" "$(final e2-node-b)" \
  --setup-loads "$(final e2-setup)" >"${out}/e2.txt" 2>&1
e2=$?

echo
echo "E1 (${out}/e1.txt), exit ${e1}:"
tail -n 1 "${out}/e1.txt"
echo "E2 (${out}/e2.txt), exit ${e2}:"
tail -n 1 "${out}/e2.txt"
if [ "${red}" -ne 0 ]; then
  echo "RUNS-RED: ${red} of the 7 vitest runs exited non-zero: read their .log files in ${out}"
fi
[ "${e1}" -eq 0 ] && [ "${e2}" -eq 0 ] && [ "${red}" -eq 0 ]
