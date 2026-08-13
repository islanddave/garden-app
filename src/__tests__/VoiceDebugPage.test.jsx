// BUG-VOICEDUPE-002 — /admin/voice-debug, the surface Dave reads the raw capture from.
// RENDER assertions only. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

import VoiceDebug from '../pages/VoiceDebug.jsx'
import {
  isVoiceDebugEnabled,
  setVoiceDebugEnabled,
  recordVoiceEvent,
  recordVoiceMark,
  readVoiceDebugLog,
} from '../lib/voiceDebug.js'

function seedCapture() {
  setVoiceDebugEnabled(true)
  recordVoiceMark('EventNew:notes', 'start')
  recordVoiceEvent('EventNew:notes', {
    resultIndex: 0,
    results: [Object.assign([{ transcript: 'watered the tomatoes' }], { isFinal: true })],
  })
  recordVoiceMark('EventNew:notes', 'end')
}

beforeEach(() => { localStorage.clear() })

const text   = () => screen.getByTestId('voice-debug-text').value
const toggle = () => screen.getByTestId('voice-debug-toggle')

describe('VoiceDebug page', () => {
  it('starts OFF and says so, with an empty capture', () => {
    render(<VoiceDebug />)
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(toggle().textContent).toMatch(/Capture OFF/)
    expect(text()).toBe('(no events captured)')
  })

  it('the toggle flips the persisted flag both ways', () => {
    render(<VoiceDebug />)
    fireEvent.click(toggle())
    expect(isVoiceDebugEnabled()).toBe(true)
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(toggle().textContent).toMatch(/Capture ON/)
    fireEvent.click(toggle())
    expect(isVoiceDebugEnabled()).toBe(false)
  })

  it('renders a captured sequence as copyable text with resultIndex, length and per-result rows', () => {
    seedCapture()
    render(<VoiceDebug />)
    const out = text()
    expect(out).toContain('EventNew:notes  start')
    expect(out).toContain('resultIndex=0 len=1')
    expect(out).toContain('[0] FINAL')
    expect(out).toContain('"watered the tomatoes"')
    expect(out).toContain('EventNew:notes  end')
  })

  it('the text block is read-only so a stray tap cannot corrupt the evidence', () => {
    seedCapture()
    render(<VoiceDebug />)
    expect(screen.getByTestId('voice-debug-text').readOnly).toBe(true)
  })

  it('reports entry and result-event counts', () => {
    seedCapture()
    render(<VoiceDebug />)
    const label = screen.getByTestId('voice-debug-count').textContent
    expect(label).toMatch(/3 entries/)
    expect(label).toMatch(/1 result event\b/)
  })

  it('Clear empties the log and the displayed text', () => {
    seedCapture()
    render(<VoiceDebug />)
    fireEvent.click(screen.getByTestId('voice-debug-clear'))
    expect(readVoiceDebugLog()).toEqual([])
    expect(text()).toBe('(no events captured)')
  })

  it('Refresh picks up events recorded while the user was on another route', () => {
    setVoiceDebugEnabled(true)
    render(<VoiceDebug />)
    expect(text()).toBe('(no events captured)')
    recordVoiceMark('EventNew:notes', 'start')      // as if dictated on /log
    fireEvent.click(screen.getByTestId('voice-debug-refresh'))
    expect(text()).toContain('EventNew:notes  start')
  })

  it('Copy writes the same text to the clipboard and acknowledges inline (no toast, no modal)', async () => {
    seedCapture()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<VoiceDebug />)
    const expected = text()
    await act(async () => { fireEvent.click(screen.getByTestId('voice-debug-copy')) })
    expect(writeText).toHaveBeenCalledWith(expected)
    expect(screen.getByTestId('voice-debug-copy').textContent).toMatch(/Copied/)
  })

  it('a blocked clipboard does not throw — the selectable text block is the fallback', async () => {
    seedCapture()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true,
    })
    render(<VoiceDebug />)
    await act(async () => { fireEvent.click(screen.getByTestId('voice-debug-copy')) })
    expect(screen.getByTestId('voice-debug-copy').textContent).toBe('Copy')
    expect(text()).toContain('watered the tomatoes')
  })

  it('carries the on-device instructions Dave follows (no external doc needed)', () => {
    render(<VoiceDebug />)
    const steps = screen.getByTestId('voice-debug-steps').textContent
    expect(steps).toMatch(/Log an event/)
    expect(steps).toMatch(/Clear/)
    expect(steps).toMatch(/Copy/)
  })
})
