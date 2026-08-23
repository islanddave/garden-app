// altText.js — V4-SHAREALTTEXT-001. Derives the `alt_text_custom` each photo carries onto the
// Facebook Page from the RECORD it hangs off: its planting, that planting's cultivar, the cultivar's
// crop type, and the event the photo documents. PURE: no runtime deps (no neon/clerk/aws/fetch), so
// it unit-tests under a root `npm ci` without the handler's dependencies — the same seam as graph.js.
//
// WHY DERIVED RATHER THAN TYPED INTO THE COMPOSER: alt text nobody writes is alt text nobody has.
// Every photo that reaches this Lambda already sits on a planting whose cultivar and crop type the
// database knows, so a description is available on EVERY post for free instead of on the ones
// somebody remembered to annotate. The ledger row's own framing — "the only human-readable text
// bound to the image, which is what makes the archive legible years later" — is an argument for
// coverage, and coverage is what a derivation buys.
//
// WHY NOT photos.caption: named as an explicit non-source on the row, and correctly. It is a
// horticultural observation ("blossom drop after the heat"), not a description of what is in the
// frame, and it is the wrong register for a screen reader. (The row also says caption "already seeds
// the post caption" — that clause is FALSE at this SHA: FacebookShareSheet opens with useState('')
// and nothing seeds it. The instruction still stands on its first, better reason.)
//
// WHY A LAMBDA-LOCAL COPY OF THE NAMING RULES instead of importing src/lib/harvestPost.js: each
// Lambda is zipped from its own directory, so a ../../src import is not packaged (the same
// constraint that produced graph.js and the per-Lambda household.js copies). Only the NAMING subset
// is copied here — uncertainty guard, parenthetical/suffix strip, override table, plural — because
// the batching and post-model half of that module has no meaning for a single photo. altText.test.js
// asserts PARITY against harvestPost.js's exports over a shared corpus rather than byte-equality,
// which is the drift guard its own isUncertainName comment asks for ("a private copy of this
// predicate is exactly how the two metadata strippers diverged").

// Sanity cap, mirroring MAX_CAPTION's rationale in graph.js: the derived string is short by
// construction (a name plus a crop plus a clause), so anything near this bound means a pathological
// display_name, not a real description. Truncation is at a word boundary — chopping mid-name would
// publish a mangled cultivar, which is the one failure mode worse than a long string.
export const MAX_ALT_TEXT = 300;

// Copied from src/lib/harvestPost.js. See the header for why this is a copy and altText.test.js for
// the parity guard that keeps it honest.
const STRIP_SUFFIXES = [' F1', ' (Burpee)', ' Heirloom'];
const NAME_OVERRIDES = {
  'san marzano roma': 'San Marzano',
  "czech's bush": 'Czech Bush',
  'chilly chill': 'Chilly Chills',
};
const UNCERTAIN_NAME = /\b(id pending|unknown variety|unknown|tbd)\b|\(.*\?\s*\)/i;
const INVARIANT_PLURALS = new Set([
  'squash', 'greens', 'lettuce', 'kale', 'spinach', 'chard', 'basil', 'corn', 'garlic', 'broccoli',
]);
const O_TAKES_ES = new Set(['tomato', 'potato', 'hero']);

// What the photo DEPICTS, keyed on the event it documents. DELIBERATELY PARTIAL, and the omissions
// are the point: most event types record an action ON the plant that leaves nothing in the frame —
// a photo attached to `watering`, `fertilizing` or `moisture_check` shows the plant, not the act.
// Asserting "being watered" in alt text would be a fabrication, and a screen-reader user is exactly
// the reader who cannot check it against the image. Only types where the VISIBLE STATE of the
// subject is what changed appear here; every other type contributes no clause and the alt text is
// the subject alone, which is still true.
//
// Every key is a real member of EVENT_TYPES (src/lib/eventTypes.js) — pinned by a test, because a
// typo here fails silently as "no scene clause" rather than as an error.
const EVENT_SCENE = {
  harvest: 'freshly harvested',
  first_harvest: 'the first harvest',
  flowering: 'in flower',
  fruit_set: 'setting fruit',
  germination: 'just germinated',
  sowing: 'newly sown',
  transplant: 'newly transplanted',
  potting_up: 'newly potted up',
  thinning: 'after thinning',
  pruning: 'after pruning',
  deadheaded: 'after deadheading',
  divided: 'after dividing',
  weeded: 'after weeding',
  hilled: 'hilled up',
  mulched: 'newly mulched',
  caged: 'caged',
  staked: 'staked',
  trellised: 'on a trellis',
  mesh_netting: 'under mesh netting',
  cover: 'under cover',
  animal_damage: 'with animal damage',
  frost_damage: 'with frost damage',
  heat_damage: 'with heat damage',
};

// crop and name are user-authored strings that reach `new RegExp` below. harvestPost.js interpolates
// them raw; here they are escaped, because this module runs inside the request path of the ONE
// endpoint that posts outside the household — a cultivar named "Pepper[" would turn a SyntaxError
// into a 500 that takes the whole post with it. Reported rather than fixed upstream: src/lib is
// another lane's file.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strings and numbers only. These columns are `text` so the driver hands back a string or null, but
// a blanket String() turns any other shape into a published artefact — `{}` becomes the literal
// "[object Object]", which would reach the Page as a cultivar name. Non-textual is treated as absent,
// which routes it to the omit path rather than to garbage.
function clean(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function stripParenthetical(s) {
  return clean(s).replace(/\s*\([^()]*\)\s*$/, '').trim();
}

export function isUncertainName(raw) {
  return UNCERTAIN_NAME.test(String(raw || ''));
}

export function pluralizeCrop(word, qty) {
  const w = stripParenthetical(word);
  if (!w || Number(qty) === 1) return w;
  const parts = w.split(/\s+/);
  const head = parts.slice(0, -1);
  const tail = parts[parts.length - 1];
  const lower = tail.toLowerCase();
  let plural;
  if (INVARIANT_PLURALS.has(lower)) plural = tail;
  else if (O_TAKES_ES.has(lower)) plural = `${tail}es`;
  else if (/(s|x|z|ch|sh)$/i.test(tail)) plural = `${tail}es`;
  else if (/[^aeiou]y$/i.test(tail)) plural = `${tail.slice(0, -1)}ies`;
  else plural = `${tail}s`;
  return [...head, plural].join(' ');
}

// Strip-only, never spell-correct or title-case — same rule as the post surface. Dave's own
// idiosyncratic spellings are what read as human, and a resolver that "fixes" him publishes a
// correction he did not ask for.
export function normalizeVarietyName(raw) {
  let n = stripParenthetical(raw);
  if (!n) return '';
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of STRIP_SUFFIXES) {
      if (n.length > suffix.length && n.toLowerCase().endsWith(suffix.toLowerCase())) {
        n = n.slice(0, -suffix.length).trim();
        changed = true;
      }
    }
  }
  return NAME_OVERRIDES[n.toLowerCase().replace(/[‘’]/g, "'")] || n;
}

// The subject phrase: what a sighted reader would say the photo is OF. This is renderLine()'s
// name+crop composition from harvestPost.js with the quantity dropped — same rules, so a photo and
// the post caption above it name the same crop the same way. Plural throughout: a garden photo shows
// a plant bearing several, and "Sun Gold tomatoes" is the register both reference posts use.
export function composeSubject(name, crop) {
  const n = clean(name);
  const c = clean(crop);
  if (!n && !c) return '';
  if (!n) return pluralizeCrop(c, 2);
  if (!c) return n;

  const plural = pluralizeCrop(c, 2).toLowerCase();
  if (n.toLowerCase() === c.toLowerCase()) return pluralizeCrop(c, 2);

  // Multi-word crops ("Onion (bunching / scallion)") are left alone: the suffix/containment rules
  // below only hold for a single crop noun, and harvestPost.js draws the line in the same place.
  const cropIsSingleWord = !/\s/.test(c);
  if (!cropIsSingleWord) return n;

  const tail = new RegExp(`\\s${escapeRe(c)}$`, 'i');
  if (tail.test(n)) return n.replace(tail, ` ${plural}`);
  if (!n.toLowerCase().includes(c.toLowerCase())) return `${n} ${plural}`;
  return n;
}

function capLength(s) {
  if (s.length <= MAX_ALT_TEXT) return s;
  const cut = s.slice(0, MAX_ALT_TEXT - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The alt text for ONE photo, or null when no honest description can be built.
 *
 * Row shape (the columns index.js selects alongside id/storage_path):
 *   { planting_name, variety_name, crop_name, event_type }
 *
 * NULL IS A REAL RETURN VALUE, not an error path. A photo attached to nothing — no planting, so no
 * cultivar, so no crop type — yields no subject, and the caller OMITS the field rather than sending
 * filler. "A photo of a plant" is worse than silence for a screen-reader user: it consumes the one
 * slot a real description would have occupied and tells them nothing, and unlike silence it cannot
 * be distinguished from a description somebody meant. The same reasoning is why an ID-uncertain name
 * degrades to the crop instead of publishing "Onion — scallion-type (thick blue-green, ID pending)":
 * the crop is a smaller claim that is still true.
 */
export function buildPhotoAltText(row) {
  const r = row && typeof row === 'object' ? row : {};
  const crop = clean(r.crop_name);
  const rawName = clean(r.planting_name) || clean(r.variety_name);
  const name = isUncertainName(rawName) ? '' : normalizeVarietyName(rawName);

  const subject = composeSubject(name, crop);
  if (!subject) return null;

  const scene = EVENT_SCENE[clean(r.event_type)] || '';
  return capLength(scene ? `${subject}, ${scene}` : subject);
}

// Exported for the test that pins every key to the real EVENT_TYPES taxonomy.
export const EVENT_SCENE_KEYS = Object.keys(EVENT_SCENE);
