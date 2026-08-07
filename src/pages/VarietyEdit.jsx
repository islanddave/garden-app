// VarietyEdit — route host for V4-EDITCOMPLETE-001 V3.
// Loads one cultivar by id and hands it to VarietyEditor, which owns the fields and the patch.
// Gives useVarieties.updateVariety its first caller since VARIETY-REF Session 2.
import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useVarieties } from '../hooks/useVarieties.js'
import { useCropTypes } from '../hooks/useCropTypes.js'
import { useAuthOptional } from '../context/AuthContext.jsx'
import { useOptionalToast } from '../context/ToastContext.jsx'
import { P } from '../lib/constants.js'
import Spinner from '../components/forms/Spinner.jsx'
import ErrorBanner from '../components/forms/ErrorBanner.jsx'
import VarietyEditor from '../components/forms/VarietyEditor.jsx'

export default function VarietyEdit() {
  const { varietyId } = useParams()
  const navigate = useNavigate()
  const { fetch } = useApiFetch()
  const { updateVariety } = useVarieties()
  const { cropTypes } = useCropTypes()
  const auth = useAuthOptional()
  const { show } = useOptionalToast()

  const [variety, setVariety] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState(null)

  useEffect(() => {
    let mounted = true
    setLoading(true); setLoadErr(null)
    fetch('/api/varieties/' + varietyId)
      .then(v => { if (mounted) { setVariety(v); setLoading(false) } })
      .catch(err => {
        if (!mounted) return
        setLoadErr(err?.status === 404
          ? 'Variety not found — it may have been removed.'
          : (err?.message ?? 'Failed to load variety.'))
        setLoading(false)
      })
    return () => { mounted = false }
  }, [varietyId, fetch])

  async function handleSave(id, payload) {
    return updateVariety(id, payload)
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', paddingTop: 8 }}>
      <div style={{ padding: '0 16px 8px', fontSize: '1.05rem', fontWeight: 700, color: P.green }}>
        {variety ? `Edit ${variety.name}` : 'Edit variety'}
      </div>

      {loading && <div style={{ padding: 16 }}><Spinner /></div>}
      {!loading && loadErr && (
        <div style={{ padding: '0 16px' }}><ErrorBanner>{loadErr}</ErrorBanner></div>
      )}

      {!loading && !loadErr && variety && (
        <VarietyEditor
          variety={variety}
          cropTypes={cropTypes}
          currentUserId={auth?.user?.id ?? null}
          onSave={handleSave}
          onSaved={(updated) => {
            show?.(`Saved ${updated?.name ?? variety.name}`)
            navigate(-1)
          }}
          onCancel={() => navigate(-1)}
        />
      )}
    </div>
  )
}
