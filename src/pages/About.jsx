// V3-RELEASENOTES-001 — About tab. Replaces the global <Footer/> (removed app-wide);
// the app version + copyright now live here. Reads the __APP_VERSION__ global injected
// by vite.config.js at build time (footer==tag convention preserved, just relocated).
import React from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'

const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null) || '0.0.0'

export default function About() {
  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px' }}>
      <h1 style={{ fontSize: '1.4rem', color: P.green, margin: '0 0 4px' }}>Gardens at Mathews Ridge</h1>
      <p style={{ color: P.mid, fontSize: '0.95rem', margin: '0 0 20px' }}>
        A home garden tracker — plantings, projects, critters, and Doctor Gardener care guidance.
      </p>

      <div style={{
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
        padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <Row label="Version" value={`v${APP_VERSION}`} />
        <Row label="Maker" value="FutureisHere.NET" />
        <Row label="Copyright" value={`© ${new Date().getFullYear()} FutureisHere.NET`} />
      </div>

      <Link to="/releases" style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 18,
        color: P.green, fontWeight: 600, textDecoration: 'none', fontSize: '0.95rem',
      }}>
        <span aria-hidden="true">📋</span> See what's new
      </Link>
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.9rem' }}>
      <span style={{ color: P.light }}>{label}</span>
      <span style={{ color: P.dark, fontWeight: 500 }}>{value}</span>
    </div>
  )
}
