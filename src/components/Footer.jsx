import { P } from '../lib/constants.js'

// ── App version injected by vite.config.js at build time ──
// Falls back to '0.1.0' in dev if define hasn't been configured yet.
const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0'

// I10-timestamp fix (2026-05-18, V1.2a-3 Increment C / PR-C2):
// dropped "Loaded HH:MM:SS" — raw page-load wall-clock looked like dev debug output to users.
// fmtTime + FetchedAt remain available for per-page data-freshness indicators where relevant.

function fmtTime(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

// ── Global footer ────────────────────────────────────────────
export default function Footer() {
  return (
    <footer style={{
      borderTop: `1px solid ${P.border}`,
      backgroundColor: P.white,
      padding: '10px 20px',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 12,
      fontSize: '0.72rem',
      color: P.light,
      flexWrap: 'wrap',
    }}>
      <span>© {new Date().getFullYear()} FutureisHere.NET</span>
      <Dot />
      <span>v{APP_VERSION}</span>
    </footer>
  )
}

// ── Per-page data-freshness indicator ────────────────────────
// Usage in any page that fetches data:
//
//   const [fetchedAt, setFetchedAt] = useState(null)
//   // after data loads: setFetchedAt(new Date())
//   // at bottom of page content: <FetchedAt time={fetchedAt} />
//
export function FetchedAt({ time }) {
  if (!time) return null
  return (
    <div style={{
      textAlign: 'right',
      fontSize: '0.72rem',
      color: P.light,
      padding: '8px 0 0',
      opacity: 0.8,
    }}>
      Data fetched {fmtTime(time instanceof Date ? time : new Date(time))}
    </div>
  )
}

function Dot() {
  return <span style={{ opacity: 0.4 }}>·</span>
}
