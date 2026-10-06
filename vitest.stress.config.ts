// vitest.stress.config.ts — the unit run with a 20ms-late React scheduler (OPS-RTLEVENTPRIORITY-001).
// Used only by hand; the two commands and how to read them are in src/__tests__/helpers/stressSetup.ts.
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default defineConfig({
  ...base,
  test: { ...base.test, setupFiles: ['./src/__tests__/helpers/stressSetup.ts'] },
});
