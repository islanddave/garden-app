#!/usr/bin/env node
// DEPRECATED shim. The canonical drift guard is `npm run check:event-types`, which runs
// `node scripts/gen-lambda-event-types.mjs --check` (regenerate to a temp file, diff
// against the committed lambda/events/eventTypes.generated.js, exit non-zero on drift).
// This file is retained only so any stray reference keeps working; it delegates to the
// canonical script. Do NOT wire CI to this shim — wire it to `npm run check:event-types`.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const gen = resolve(here, 'gen-lambda-event-types.mjs')
const r = spawnSync(process.execPath, [gen, '--check'], { stdio: 'inherit' })
process.exit(r.status ?? 1)
