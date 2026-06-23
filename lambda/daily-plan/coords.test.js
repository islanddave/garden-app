// DRG-WXROLL-001 — coordsForSpace resolution (embedded in the plan so the client can live-refresh precip).
import { describe, it, expect } from 'vitest';
import handler from './handler.js';
const { coordsForSpace } = handler;

describe('coordsForSpace', () => {
  it('uses cached weather_lat/lng without geocoding', async () => {
    const c = await coordsForSpace(
      { weather_lat: 42.508812, weather_lng: -72.646627, postal_code: '01341' },
      { geocodeZip: async () => { throw new Error('should not geocode'); } });
    expect(c).toEqual({ lat: 42.508812, lng: -72.646627 });
  });
  it('geocodes the postal_code when coords are null', async () => {
    const c = await coordsForSpace(
      { weather_lat: null, weather_lng: null, postal_code: '01341' },
      { geocodeZip: async () => ({ lat: 1.1, lng: 2.2 }) });
    expect(c).toEqual({ lat: 1.1, lng: 2.2 });
  });
  it('returns null when there is no location at all (engine still runs)', async () => {
    expect(await coordsForSpace({ weather_lat: null, weather_lng: null, postal_code: null }, {})).toBeNull();
  });
  it('returns null (no throw) when geocoding fails', async () => {
    const c = await coordsForSpace({ postal_code: '01341' }, { geocodeZip: async () => { throw new Error('down'); } });
    expect(c).toBeNull();
  });
});
