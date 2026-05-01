/**
 * tests/contracts/api.ts
 * TypeScript contract interfaces for garden-app Lambda API responses.
 *
 * These are the source of truth for what the frontend and smoke tests should expect.
 * Update here when Lambda response shapes change — breaking changes surface in TS compilation.
 * NOT compiled at runtime. Referenced by unit tests and smoke test validators.
 */

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  location?: string;
  created_at: string;
  updated_at?: string;
}

export interface Plant {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  species?: string;
  variety?: string;
  notes?: string;
  germination_date?: string;
  transplant_date?: string;
  created_at: string;
  updated_at?: string;
}

export interface Location {
  id: string;
  project_id?: string;
  user_id: string;
  name: string;
  type?: string; // e.g. "indoor", "outdoor", "greenhouse"
  notes?: string;
  created_at: string;
}

export interface GardenEvent {
  id: string;
  plant_id?: string;
  location_id?: string;
  user_id: string;
  type: string; // e.g. "watered", "fertilized", "transplanted", "harvested"
  notes?: string;
  event_date: string;
  created_at: string;
}

export interface Favorite {
  id: string;
  user_id: string;
  plant_id: string;
  created_at: string;
}

export interface PlantPhoto {
  id: string;
  plant_id: string;
  user_id: string;
  s3_key: string;
  url?: string;
  caption?: string;
  created_at: string;
}

export interface DashboardResponse {
  projects_count: number;
  plants_count: number;
  locations_count?: number;
  recent_events?: GardenEvent[];
  favorites_count?: number;
}

// Generic list response shape (Lambda returns array directly or wrapped)
export type ApiListResponse<T> = T[] | { items: T[]; count?: number };
export type ApiCreateResponse<T> = T;
export type ApiUpdateResponse<T> = T;
export type ApiDeleteResponse = { deleted: true; id: string } | { success: true };
export type ApiErrorResponse = { error: string; message?: string; status?: number };

// Type guard helpers
export const isApiError = (r: unknown): r is ApiErrorResponse =>
  typeof r === 'object' && r !== null && 'error' in r;

export const isProject = (r: unknown): r is Project =>
  typeof r === 'object' && r !== null && 'id' in r && 'user_id' in r && 'name' in r;
