# seed-load-dataset-V1.json — not yet in-repo

The 105-packet load dataset (~162KB) could not ride the API-based push channel that landed
this migration dir (2026-07-10 Cowork session; git-proxy source gate blocked normal `git push`,
and the file exceeds the MCP per-call size). It is NOT required by CI or any test — only by
`0b-load-seeds.mjs`, and the load has ALREADY been applied:

- 2026-07-10: 0a+0c applied to STAGING + PROD; loader `--apply` run on PROD
  (104 inserted / 81 varieties created / 23 matched / 1 SKIP "Amaranth Edible Red Leaf" —
  ambiguous vs two live varieties named "Red Leaf"; re-run is a no-op).

Canonical copies of the dataset:
- `~/AI/Claude/Projects/Gardening/seeds/seed-load-dataset-V1.json` (authoritative)
- inside the git bundle `~/AI/Claude/Projects/Gardening/seeds/v4-seedinv-ship-b2ea44d.bundle`
  (commit 8e0b9d3 carries it at this path)

First session with a working `git push` to this repo: commit the file here and delete this note.
