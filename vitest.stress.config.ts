// vitest.stress.config.ts — the unit run with a 20ms-late React scheduler (OPS-RTLEVENTPRIORITY-001).
// Used only by hand; the two commands and how to read them are in src/__tests__/helpers/stressSetup.ts.
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';
import { withSetupReplaced } from './scripts/ci-telemetry/vitest-side-config.mjs';

// The stress setup takes the place of src/__tests__/setup.ts wherever that is listed, and imports it after delaying
// setImmediate. With the A3 trial key set (vitest.config.ts) that is the dom project only: the node project has no
// DOM, no React scheduler and no setup file, and runs as it does in the unit run.
export default defineConfig({
  ...base,
  test: withSetupReplaced(base.test, './src/__tests__/setup.ts', './src/__tests__/helpers/stressSetup.ts'),
});
