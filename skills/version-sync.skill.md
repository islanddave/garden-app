# version-sync.skill.md
# Garden App — Version Sync Skill
# Directly executable. No proc.md. Run when bumping app version.
#
# USAGE: "run version-sync skill, bump to X.Y.Z"
# REPO: islanddave/garden-app
# BRANCH TARGET: dev (never main)
# CREDENTIALS: /Users/davenichols/AI/Claude/Projects/Gardening/.env.local

## What This Skill Does

1. Reads current version from package.json on dev branch
2. Bumps "version" field to the specified target version
3. Updates sprint-tracker.md — replaces version references
4. Commits both files to dev branch
5. Reports commit SHAs for both files

---

## Execution Steps

### Step 1 — Read credentials
Read GITHUB_PAT from `/Users/davenichols/AI/Claude/Projects/Gardening/.env.local`.

### Step 2 — Fetch current state (parallel)

```js
const PAT = '<from .env.local>';
const REPO = 'islanddave/garden-app';
const h = { Authorization: `token ${PAT}`, Accept: 'application/vnd.github.v3+json' };
const [pkgRes, trackerRes] = await Promise.all([
  fetch(`https://api.github.com/repos/${REPO}/contents/package.json?ref=dev`, { headers: h }).then(r => r.json()),
  fetch(`https://api.github.com/repos/${REPO}/contents/sprint-tracker.md?ref=dev`, { headers: h }).then(r => r.json()),
]);
const pkg = JSON.parse(atob(pkgRes.content));
const tracker = new TextDecoder().decode(Uint8Array.from(atob(trackerRes.content), c => c.charCodeAt(0)));
return { currentVersion: pkg.version, pkgSHA: pkgRes.sha, trackerSHA: trackerRes.sha };
```

### Step 3 — Patch both files

```js
const TARGET_VERSION = '<specified by caller>';
const pkgObj = JSON.parse(atob(pkgRes.content));
pkgObj.version = TARGET_VERSION;
const pkgPatched = JSON.stringify(pkgObj, null, 2) + '\n';
const trackerPatched = tracker
  .replace(/v\d+\.\d+\.\d+/g, `v${TARGET_VERSION}`)
  .replace(/version: [\d.]+/g, `version: ${TARGET_VERSION}`);
```

### Step 4 — Commit both files to dev (parallel)

```js
const encode = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const [pkgCommit, trackerCommit] = await Promise.all([
  fetch(`https://api.github.com/repos/${REPO}/contents/package.json`, {
    method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `chore: bump version to ${TARGET_VERSION}`, content: encode(pkgPatched), sha: pkgRes.sha, branch: 'dev' })
  }).then(r => r.json()),
  fetch(`https://api.github.com/repos/${REPO}/contents/sprint-tracker.md`, {
    method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `docs: update sprint-tracker version to ${TARGET_VERSION}`, content: encode(trackerPatched), sha: trackerRes.sha, branch: 'dev' })
  }).then(r => r.json()),
]);
```

### Step 5 — Verify
Re-fetch package.json from dev, confirm version matches TARGET_VERSION. Report both commit SHAs.

---

## Error Handling
- 409 on commit: re-fetch blob SHA, retry once. Stop on second 409.
- Version already at target: report "already at X.Y.Z, no change" and exit.
- sprint-tracker.md not found: commit package.json only, warn tracker not updated.

---

## Notes
- Never commits to main. All commits target dev branch only.
- PAT expiry: Jun 25 2026.
- NETLIFY_SITE_ID: 80a25a40-fd45-4748-b729-5e8a9c639d60
