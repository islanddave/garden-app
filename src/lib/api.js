import { useAuth } from '@clerk/react';

// Per-function Lambda URLs — each entity has its own function
const FUNCTION_URLS = {
  '/api/projects':  import.meta.env.VITE_API_PROJECTS  ?? '',
  '/api/plants':    import.meta.env.VITE_API_PLANTS    ?? '',
  '/api/locations': import.meta.env.VITE_API_LOCATIONS ?? '',
  '/api/events':    import.meta.env.VITE_API_EVENTS    ?? '',
  '/api/favorites': import.meta.env.VITE_API_FAVORITES ?? '',
  '/api/photos':    import.meta.env.VITE_API_PHOTOS    ?? '',
  '/api/dashboard': import.meta.env.VITE_API_DASHBOARD ?? '',
};

function resolveUrl(path) {
  for (const [prefix, base] of Object.entries(FUNCTION_URLS)) {
    if (path.startsWith(prefix)) return `${base}${path}`;
  }
  throw new Error(`No Lambda URL configured for path: ${path}`);
}

// Low-level fetch — requires caller to supply a token string.
export async function apiFetch(path, options = {}, token) {
  const url = resolveUrl(path);

  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
  };

  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    let errBody;
    try { errBody = await res.json(); } catch { errBody = { error: res.statusText }; }
    const err = new Error(errBody?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.body = errBody;
    throw err;
  }

  if (res.status === 204) return null;
  return res.json();
}

// React hook — wires Clerk's getToken() automatically.
export function useApiFetch() {
  const { getToken } = useAuth();

  async function fetch(path, options = {}) {
    const token = await getToken();
    return apiFetch(path, options, token);
  }

  return { fetch };
}
