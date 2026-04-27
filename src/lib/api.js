import { useAuth } from '@clerk/react';
import { useCallback } from 'react';

const FUNCTION_URLS = {
  '/api/projects': import.meta.env.VITE_API_PROJECTS ?? '',
  '/api/plants':   import.meta.env.VITE_API_PLANTS ?? '',
  '/api/locations':import.meta.env.VITE_API_LOCATIONS ?? '',
  '/api/events':   import.meta.env.VITE_API_EVENTS ?? '',
  '/api/favorites':import.meta.env.VITE_API_FAVORITES ?? '',
  '/api/photos':   import.meta.env.VITE_API_PHOTOS ?? '',
  '/api/dashboard':import.meta.env.VITE_API_DASHBOARD ?? '',
};

function resolveUrl(path) {
  for (const [prefix, base] of Object.entries(FUNCTION_URLS)) {
    if (path.startsWith(prefix)) return `${base}${path}`;
  }
  throw new Error(`No Lambda URL configured for path: ${path}`);
}

export async function apiFetch(path, options = {}, token) {
  const url = resolveUrl(path);
  const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let errBody;
    try { errBody = await res.json(); } catch { errBody = { error: res.statusText }; }
    const e = new Error(errBody?.error ?? `HTTP ${res.status}`);
    e.status = res.status;
    e.body = errBody;
    throw e;
  }
  if (res.status === 204) return null;
  return res.json();
}

export function useApiFetch() {
  const { getToken } = useAuth();
  const fetch = useCallback(async (path, options = {}) => {
    const token = await getToken();
    return apiFetch(path, options, token);
  }, [getToken]);
  return { fetch };
}
