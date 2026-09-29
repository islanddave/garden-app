// SourceEdit — /sources/:id. V5-SOURCECONTACT-001.
//
// Dave: "a source add/edit should include optional fields for website, IG, FB, physical address for
// me to enter". SourcePicker's mint panel covers ADD; this is EDIT — the first screen that can change
// a source after it exists (before it, a source minted with a name alone kept only that forever).
//
// Loads one live source (GET /api/varieties/sources/:id), saves through useSources.updateSource
// (PATCH). The PATCH is partial, so only fields that CHANGED are sent: an untouched field can never
// overwrite a concurrent edit to it, and an untouched soft-deleted kind is not re-validated.
//
// No delete control, on purpose: plants and seed lots point at sources, and removing one is a merge
// question the app does not answer yet. The route answers DELETE with 405 for the same reason.
//
// NOT routed here. App.jsx belongs to the coordinator lane; it mounts this at /sources/:id.
import React, { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useSources, useSourceKinds } from '../hooks/useSources.js'
import { useOptionalToast } from '../context/ToastContext.jsx'
import { normalizeWebsiteUrl, normalizeSocialUrl, isBadLinkError, BAD_LINK_MESSAGE } from '../lib/sourceLinks.js'
import { P, T } from '../lib/tokens.js'
import PageShell from '../components/forms/PageShell.jsx'
import Field from '../components/forms/Field.jsx'
import Input from '../components/forms/Input.jsx'
import Textarea from '../components/forms/Textarea.jsx'
import Select from '../components/forms/Select.jsx'
import Button from '../components/forms/Button.jsx'

// Form state keys, in display order. Every one maps 1:1 to a column the PATCH accepts.
const FIELDS = ['name', 'kind', 'locality', 'address', 'website_url', 'instagram_url', 'facebook_url', 'notes']

function toForm(source) {
  return Object.fromEntries(FIELDS.map(k => [k, source?.[k] ?? '']))
}

// What the server would store for a form value: links normalised to full https URLs, every other
// optional field trimmed, blank -> null. Name is trimmed and never null (it cannot be cleared).
function normalise(key, value) {
  if (key === 'website_url') return normalizeWebsiteUrl(value)
  if (key === 'instagram_url') return normalizeSocialUrl('instagram', value)
  if (key === 'facebook_url') return normalizeSocialUrl('facebook', value)
  const t = String(value ?? '').trim()
  if (key === 'name') return t
  return t === '' ? null : t
}

// The partial patch: only keys whose stored value would change.
export function sourcePatch(original, form) {
  const patch = {}
  for (const k of FIELDS) {
    const next = normalise(k, form[k])
    const prev = original?.[k] ?? (k === 'name' ? '' : null)
    if (next !== prev) patch[k] = next
  }
  return patch
}

// Plain words for each way a save can fail. The 409 names the other source, because "that name is
// taken" is useless without saying by what.
export function saveErrorMessage(res) {
  if (res?.reason === 'exists' && res.existing?.name) {
    return `“${res.existing.name}” is already another source. Use a different name, or open that one and edit it instead.`
  }
  if (res?.status === 403) return 'You can only edit sources you added.'
  if (res?.status === 404) return 'This source was not found. It may have been removed.'
  if (isBadLinkError(res)) return BAD_LINK_MESSAGE
  return res?.error || 'Could not save. Check your connection and try again.'
}

export default function SourceEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  // A deep link or a fresh window opens here with no page behind it in this app, and navigate(-1)
  // would leave the app (or do nothing). The router's first entry is keyed 'default' — its own
  // "history.length <= 1", and unlike window.history.length it is also true under MemoryRouter.
  const goBack = () => (location.key === 'default' ? navigate('/season-stats', { replace: true }) : navigate(-1))
  const { fetch } = useApiFetch()
  // The list is not needed here; updateSource is. `enabled: false` keeps this page from fetching it.
  const { updateSource } = useSources({ enabled: false })
  const { sourceKinds } = useSourceKinds()
  const { show } = useOptionalToast()

  const [source, setSource] = useState(null)
  const [form, setForm] = useState(toForm(null))
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState(null)
  const [nameErr, setNameErr] = useState(null)

  useEffect(() => {
    let alive = true
    setLoading(true); setLoadErr(null)
    Promise.resolve(fetch(`/api/varieties/sources/${encodeURIComponent(id)}`))
      .then(s => {
        if (!alive) return
        setSource(s); setForm(toForm(s)); setLoading(false)
      })
      .catch(err => {
        if (!alive) return
        setLoadErr(err?.status === 404
          ? 'This source was not found. It may have been removed.'
          : (err?.message ?? 'Could not load this source.'))
        setLoading(false)
      })
    return () => { alive = false }
  }, [id, fetch])

  const patch = useMemo(() => (source ? sourcePatch(source, form) : {}), [source, form])
  const dirty = Object.keys(patch).length > 0

  const set = (key) => (e) => {
    const v = e.target.value
    setForm(f => ({ ...f, [key]: v }))
    setSaveErr(null)
    if (key === 'name') setNameErr(null)
  }

  async function save(e) {
    e?.preventDefault?.()
    if (saving) return
    const name = form.name.trim()
    if (name.length < 2) { setNameErr('Give it a name of at least two letters.'); return }
    if (!dirty) { goBack(); return }
    setSaving(true); setSaveErr(null)
    const res = await updateSource(source.id, patch)
    setSaving(false)
    if (res?.error) { setSaveErr({ message: saveErrorMessage(res), existing: res.reason === 'exists' ? res.existing : null }); return }
    setSource(res.source); setForm(toForm(res.source))
    show?.(`Saved ${res.source.name}`)
    goBack()
  }

  const fid = (k) => `source-edit-${k}`
  const kindOptions = useMemo(
    () => sourceKinds.map(k => ({ value: k.slug, label: k.display_name })), [sourceKinds])

  return (
    <PageShell
      title={source ? `Edit ${source.name}` : 'Edit source'}
      loading={loading}
      error={loadErr}
      data-testid="source-edit"
    >
      {source && (
        <form onSubmit={save} noValidate>
          <Field label="Name" htmlFor={fid('name')} required error={nameErr}>
            <Input id={fid('name')} type="text" value={form.name} onChange={set('name')}
              autoComplete="off" data-testid="source-edit-name" />
          </Field>

          <Field label="What kind of place" htmlFor={fid('kind')} optional>
            {/* `options`, not children: the primitive then appends a stored kind that is no longer
                live, so a retired kind shows as itself instead of as "not set". */}
            <Select id={fid('kind')} value={form.kind} onChange={set('kind')} placeholder="— not set —"
              options={kindOptions} data-testid="source-edit-kind" />
          </Field>

          <Field label="Town" htmlFor={fid('locality')} optional
            help="Town and state, so two places with the same name can be told apart.">
            <Input id={fid('locality')} type="text" value={form.locality} onChange={set('locality')}
              placeholder="e.g. Hadley, MA" autoComplete="off" data-testid="source-edit-locality" />
          </Field>

          <Field label="Address" htmlFor={fid('address')} optional>
            <Input id={fid('address')} type="text" value={form.address} onChange={set('address')}
              placeholder="e.g. 397 Greenfield Rd, Deerfield" autoComplete="off"
              data-testid="source-edit-address" />
          </Field>

          <Field label="Website" htmlFor={fid('website_url')} optional>
            <Input id={fid('website_url')} type="text" inputMode="url" value={form.website_url}
              onChange={set('website_url')} placeholder="e.g. rareseeds.com" autoComplete="off"
              data-testid="source-edit-website" />
          </Field>

          <Field label="Instagram" htmlFor={fid('instagram_url')} optional help="@name or a link — either works.">
            <Input id={fid('instagram_url')} type="text" inputMode="url" value={form.instagram_url}
              onChange={set('instagram_url')} placeholder="@name" autoComplete="off"
              data-testid="source-edit-instagram" />
          </Field>

          <Field label="Facebook" htmlFor={fid('facebook_url')} optional help="Page name or a link.">
            <Input id={fid('facebook_url')} type="text" inputMode="url" value={form.facebook_url}
              onChange={set('facebook_url')} placeholder="Page name" autoComplete="off"
              data-testid="source-edit-facebook" />
          </Field>

          <Field label="Notes" htmlFor={fid('notes')} optional>
            <Textarea id={fid('notes')} value={form.notes} onChange={set('notes')} rows={3}
              data-testid="source-edit-notes" />
          </Field>

          {saveErr && (
            <div role="alert" style={errBox} data-testid="source-edit-error">
              <div>{saveErr.message}</div>
              {saveErr.existing && (
                <Button type="button" variant="secondary" style={{ marginTop: T.space.sm }}
                  data-testid="source-edit-open-existing"
                  onClick={() => navigate(`/sources/${saveErr.existing.id}`)}>
                  Open “{saveErr.existing.name}”
                </Button>
              )}
            </div>
          )}

          <div style={actions}>
            <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…"
              data-testid="source-edit-save" style={{ flex: 1 }}>
              Save
            </Button>
            <Button type="button" variant="secondary" onClick={goBack}
              data-testid="source-edit-cancel" style={{ flex: 1 }}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </PageShell>
  )
}

const errBox = {
  color: P.terra, fontSize: T.type.sm, marginTop: T.space.sm, marginBottom: T.space.sm,
}

const actions = { display: 'flex', gap: 10, marginTop: T.space.md }
