// V5-HARVESTVOICEFLOW-001 C4 — real-browser look at the probe's controls at Dave's geometry.
// jsdom proves the round-trip toggle EXISTS, defaults off, and locks mid-run; it cannot show whether
// two stacked 44px checkbox rows plus a five-line verdict panel leave the Start button reachable on a
// 375px phone — and this page is only ever operated outdoors, on that phone, one-handed.
// No mic here: SpeechRecognition is absent in the harness, so the probe renders and reports
// 'no SpeechRecognition'. Layout is the whole question.
import React from 'react'
import { createRoot } from 'react-dom/client'
import ContinuousVoiceProbe from '../../src/components/ContinuousVoiceProbe.jsx'
createRoot(document.getElementById('root')).render(<ContinuousVoiceProbe />)
