import { describe, it, expect } from 'vitest';
import h from './handler.js';
const { resolveInvokeOptions } = h;

// A0.2-EVENT-OVERRIDES safety contract. The keystone assertions are (a) an EventBridge nightly
// payload is byte-identical to pre-A0.2 behavior, and (b) the payload can NEVER force a live run.
const EVENTBRIDGE = {
  version: '0', id: 'abc-123', 'detail-type': 'Scheduled Event', source: 'aws.events',
  account: '123456789012', time: '2026-07-22T06:00:00Z', region: 'us-east-1',
  resources: ['arn:aws:events:us-east-1:123456789012:rule/garden-daily-plan-nightly'], detail: {},
};
const D = '2026-07-22';

describe('A0.2 resolveInvokeOptions', () => {
  it('EventBridge nightly payload + env live -> live run, default date (byte-identical nightly)', () => {
    expect(resolveInvokeOptions(EVENTBRIDGE, { envDryRun: 'false', todayDefault: D }))
      .toEqual({ dryRun: false, today: D, ping: false });
  });
  it('EventBridge nightly payload + env dry -> dry run', () => {
    expect(resolveInvokeOptions(EVENTBRIDGE, { envDryRun: 'true', todayDefault: D }).dryRun).toBe(true);
  });
  it('env unset -> dry (fail-safe default)', () => {
    expect(resolveInvokeOptions(undefined, { envDryRun: undefined, todayDefault: D }).dryRun).toBe(true);
    expect(resolveInvokeOptions(null, { envDryRun: undefined, todayDefault: D }).dryRun).toBe(true);
  });
  it('event dryRun:true forces DRY even when env is live', () => {
    expect(resolveInvokeOptions({ dryRun: true }, { envDryRun: 'false', todayDefault: D }).dryRun).toBe(true);
  });
  it('event can NEVER force live: dryRun:false payload + env dry stays DRY (kill switch wins)', () => {
    expect(resolveInvokeOptions({ dryRun: false }, { envDryRun: 'true', todayDefault: D }).dryRun).toBe(true);
  });
  it('non-boolean dryRun values are ignored (fall back to env)', () => {
    expect(resolveInvokeOptions({ dryRun: 'true' }, { envDryRun: 'false', todayDefault: D }).dryRun).toBe(false);
    expect(resolveInvokeOptions({ dryRun: 1 }, { envDryRun: 'false', todayDefault: D }).dryRun).toBe(false);
    expect(resolveInvokeOptions({ dryRun: 'false' }, { envDryRun: 'true', todayDefault: D }).dryRun).toBe(true);
  });
  it('valid today override is honored; invalid shapes fall back to default', () => {
    expect(resolveInvokeOptions({ today: '2026-07-21' }, { envDryRun: 'true', todayDefault: D }).today).toBe('2026-07-21');
    for (const bad of ['07/21/2026', '2026-7-1', '2026-07-21T00:00:00Z', 20260721, null, '']) {
      expect(resolveInvokeOptions({ today: bad }, { envDryRun: 'true', todayDefault: D }).today).toBe(D);
    }
  });
  it('ping:true only on strict boolean true', () => {
    expect(resolveInvokeOptions({ ping: true }, { envDryRun: 'false', todayDefault: D }).ping).toBe(true);
    expect(resolveInvokeOptions({ ping: 'true' }, { envDryRun: 'false', todayDefault: D }).ping).toBe(false);
    expect(resolveInvokeOptions(EVENTBRIDGE, { envDryRun: 'false', todayDefault: D }).ping).toBe(false);
  });
});
