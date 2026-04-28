// Alias target for use-sync-external-store/shim — redirects to React 18's native implementation.
// Avoids CJS/ESM interop failure when @clerk/* imports the shim under Vite 8 / Rolldown.
export { useSyncExternalStore } from 'react';
