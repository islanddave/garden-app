// extract.js — SEEDINV seed-packet extractor helpers (V4-SEEDINV-001).
//
// Dep-free PURE module: zero imports, no side effects. index.js owns transport
// (secrets, global fetch to the Anthropic Messages API, HTTP statuses); this
// module owns request validation, Messages-API payload construction, and
// FULL server-side validation of the model's response. Unit tests import THIS
// file directly (extract.test.js) — index.js can't be imported in unit tests
// because it pulls @neondatabase/@clerk/@aws-sdk at module load (same
// constraint that forces static-source guards, see sow-routes.test.js).
//
// NEVER trust model output: unknown top-level keys are dropped, numerics are
// coerced, strings are capped, and metadata is size-bounded before anything
// reaches the caller.

const VALID_MODES = ['text', 'image'];
const VALID_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_TEXT_CHARS = 50_000;
const MAX_PACKETS = 40;
const MAX_FIELD_CHARS = 2000;
// inventory_items CHECK caps metadata at 8192 bytes; validate under 8000 to
// leave headroom for keys the save path merges in (sku/vendor/needs_confirmation).
const MAX_METADATA_BYTES = 8000;

const EXTRACT_PROMPT = `You are extracting a seed inventory from a seed vendor source (an order confirmation email or page, a packing slip, or a photo of one or more seed packets).

Extract EVERY seed packet / line item into a JSON array. Each array element must match this schema exactly:

{
  "name": string,                          // display name, e.g. "Tomato Black Krim"
  "crop": string,                          // crop common name, e.g. "Tomato"
  "variety": string,                       // variety name, e.g. "Black Krim"
  "quantity_on_hand": integer,             // packets purchased; default 1 if not stated
  "vendor": string,                        // vendor/company name
  "source": string,                        // where this came from, e.g. vendor name or "seed packet photo"
  "source_url": string,                    // product or order URL if visible, else null
  "purchase_date": "YYYY-MM-DD" or null,
  "price_usd": number or null,
  "sku": string or null,
  "metadata": {
    "seeds_per_packet": integer or null,
    "organic": boolean or null,
    "heirloom": boolean or null,
    "item_category": string or null
  },
  "crop_type_slug_guess": string or null,  // snake_case crop slug guess, e.g. "tomato", "pepper"
  "sow_profile": {
    "life_cycle": string or null,          // e.g. "annual", "biennial grown as annual"
    "season": string or null,              // e.g. "cool", "warm", "cool/warm"
    "sun": string or null,                 // e.g. "full sun", "full sun to part shade"
    "start_method": string or null,        // e.g. "start indoors", "direct sow", "both"
    "start_indoor_weeks_before_lastfrost": string or null,  // e.g. "6-8"
    "direct_sow_timing": string or null,   // verbatim timing text from the source
    "sow_depth_in": string or null,        // e.g. "0.25" or "0.5-1"
    "seed_spacing_in": string or null,
    "row_spacing_in": string or null,
    "days_to_germ": string or null,        // e.g. "7-14"
    "days_to_maturity": string or null,    // e.g. "80-90"
    "zone_notes": string or null,
    "packet_notes": string or null
  } or null,
  "needs_confirmation": string[]           // names of fields you could not read confidently
}

Only include sow_profile fields that are actually legible from the source — use null for anything you cannot read (never guess), and list uncertain fields in needs_confirmation. If the source has no sowing information at all, set sow_profile to null.

Respond with ONLY the JSON array — no prose, no markdown fences.`;

export function validateExtractRequest(body) {
  const bad = (error) => ({ ok: false, status: 400, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body required');
  if (!VALID_MODES.includes(body.mode)) return bad(`mode must be one of: ${VALID_MODES.join(', ')}`);
  if (body.mode === 'text') {
    if (typeof body.text !== 'string' || !body.text.trim()) return bad('text mode requires non-empty text');
    if (body.text.length > MAX_TEXT_CHARS) return bad(`text exceeds ${MAX_TEXT_CHARS} characters`);
    return { ok: true };
  }
  // image mode
  if (typeof body.image_base64 !== 'string' || !body.image_base64) return bad('image mode requires image_base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.image_base64)) return bad('image_base64 must be raw base64 (no data: URL prefix)');
  if (!VALID_MEDIA_TYPES.includes(body.media_type)) return bad(`media_type must be one of: ${VALID_MEDIA_TYPES.join(', ')}`);
  return { ok: true };
}

export function buildAnthropicRequest(body) {
  const content = body.mode === 'image'
    ? [
        { type: 'image', source: { type: 'base64', media_type: body.media_type, data: body.image_base64 } },
        { type: 'text', text: EXTRACT_PROMPT },
      ]
    : [
        { type: 'text', text: `${EXTRACT_PROMPT}\n\n--- PASTED ORDER TEXT ---\n\n${body.text}` },
      ];
  return {
    model: 'claude-sonnet-4-5',
    max_tokens: 8192,
    messages: [{ role: 'user', content }],
  };
}

// ---------- response parsing / sanitization ----------

function stripFences(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/^```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/);
  if (fence) t = fence[1].trim();
  return t;
}

// string -> trimmed + capped; finite number -> stringified; everything else -> null.
function capString(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    return s ? s.slice(0, MAX_FIELD_CHARS) : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

// keep scalar as-is (capped string / finite number / boolean); everything else -> null.
function keepScalar(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    return s ? s.slice(0, MAX_FIELD_CHARS) : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  return null;
}

function sanitizeMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[String(k).slice(0, 200)] = keepScalar(v);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  if (bytes >= MAX_METADATA_BYTES) return {}; // inventory_items metadata CHECK headroom
  return out;
}

const SOW_PROFILE_FIELDS = [
  'life_cycle', 'season', 'sun', 'start_method',
  'start_indoor_weeks_before_lastfrost', 'direct_sow_timing',
  'sow_depth_in', 'seed_spacing_in', 'row_spacing_in',
  'days_to_germ', 'days_to_maturity', 'zone_notes', 'packet_notes',
];

function sanitizeSowProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let any = false;
  for (const k of SOW_PROFILE_FIELDS) {
    const v = keepScalar(raw[k]);
    out[k] = v;
    if (v != null) any = true;
  }
  return any ? out : null;
}

const PACKET_STRING_FIELDS = ['name', 'crop', 'variety', 'vendor', 'source', 'source_url', 'sku', 'crop_type_slug_guess'];

// Whitelist rebuild: ONLY known keys survive; unknown model-invented keys are dropped.
function sanitizePacket(raw, idx) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `packet ${idx} is not an object` };
  }
  const p = {};
  for (const f of PACKET_STRING_FIELDS) p[f] = capString(raw[f]);
  if (!p.name) return { error: `packet ${idx} is missing a name` };

  const pd = capString(raw.purchase_date);
  p.purchase_date = pd && /^\d{4}-\d{2}-\d{2}$/.test(pd) ? pd : null;

  const q = Number(raw.quantity_on_hand);
  p.quantity_on_hand = Number.isFinite(q) && q >= 0 ? Math.floor(q) : 1;

  const price = Number(raw.price_usd);
  p.price_usd = raw.price_usd != null && Number.isFinite(price) && price >= 0 ? price : null;

  p.metadata = sanitizeMetadata(raw.metadata);
  p.sow_profile = sanitizeSowProfile(raw.sow_profile);
  p.needs_confirmation = Array.isArray(raw.needs_confirmation)
    ? raw.needs_confirmation
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim().slice(0, MAX_FIELD_CHARS))
        .slice(0, 50)
    : [];
  return { packet: p };
}

export function parseExtractResponse(modelText) {
  const t = stripFences(modelText);
  let parsed;
  try {
    parsed = JSON.parse(t);
  } catch {
    // Salvage pass: model occasionally wraps the array in prose despite the
    // "ONLY the JSON array" instruction — try the outermost [...] once.
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(t.slice(start, end + 1));
      } catch {
        return { ok: false, error: 'model output was not valid JSON' };
      }
    } else {
      return { ok: false, error: 'model output was not valid JSON' };
    }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'model output was not a JSON array' };
  if (parsed.length > MAX_PACKETS) return { ok: false, error: `too many packets (${parsed.length} > ${MAX_PACKETS})` };

  const packets = [];
  for (let i = 0; i < parsed.length; i++) {
    const r = sanitizePacket(parsed[i], i);
    if (r.error) return { ok: false, error: r.error };
    packets.push(r.packet);
  }
  return { ok: true, packets };
}
