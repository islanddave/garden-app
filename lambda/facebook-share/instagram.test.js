import { describe, it, expect } from 'vitest';
import { MAX_CAPTION } from './graph.js';
import {
  IG_GRAPH_VERSION, IG_MAX_CAPTION, IG_MAX_HASHTAGS, IG_MAX_MENTIONS, IG_MAX_BYTES,
  IG_MAX_CAROUSEL, POLL_INTERVAL_MS, POLL_CEILING_MS, STAGING_URL_TTL_SECONDS,
  igMediaUrl, igPublishUrl, igNodeUrl, igLimitUrl, stagingKey,
  countHashtags, countMentions, validateInstagramRequest, checkImageBytes,
  classifyContainerStatus, parsePublishingLimit,
  carouselChildFields, carouselParentFields, singleImageFields,
  igAltField, IG_MAX_ALT_TEXT,
} from './instagram.js';

const fields = (pairs) => Object.fromEntries(pairs);

describe('ig url builders', () => {
  it('uses a well-formed version', () => expect(IG_GRAPH_VERSION).toMatch(/^v\d+\.\d+$/));
  it('igMediaUrl', () => expect(igMediaUrl('17841480663170931'))
    .toBe(`https://graph.facebook.com/${IG_GRAPH_VERSION}/17841480663170931/media`));
  it('igPublishUrl', () => expect(igPublishUrl('9')).toBe(`https://graph.facebook.com/${IG_GRAPH_VERSION}/9/media_publish`));
  it('igNodeUrl', () => expect(igNodeUrl('c1')).toBe(`https://graph.facebook.com/${IG_GRAPH_VERSION}/c1`));
  it('igLimitUrl', () => expect(igLimitUrl('9')).toBe(`https://graph.facebook.com/${IG_GRAPH_VERSION}/9/content_publishing_limit`));
  it('url-encodes the id rather than interpolating it raw', () => {
    expect(igNodeUrl('a/b')).toContain('a%2Fb');
  });
});

describe('IG limits are Instagram\'s, not Facebook\'s', () => {
  // Regression guard for D6: reusing graph.js MAX_CAPTION (5000) would build a container Instagram
  // rejects, and a rejected container still burns quota against the 400/24h creation cap.
  it('caption cap is 2200, strictly below the Facebook cap', () => {
    expect(IG_MAX_CAPTION).toBe(2200);
    expect(IG_MAX_CAPTION).toBeLessThan(MAX_CAPTION);
  });
  it('byte cap is 8MB, below Facebook\'s 10MB', () => {
    expect(IG_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(IG_MAX_BYTES).toBeLessThan(10 * 1024 * 1024);
  });
  it('poll ceiling exceeds the interval so at least one retry can occur', () => {
    expect(POLL_CEILING_MS).toBeGreaterThan(POLL_INTERVAL_MS);
  });
  // The staging URL must not silently adopt the 900s constant that photoModel.js pins against.
  it('staging TTL is its own value, not the 900s photo presign TTL', () => {
    expect(STAGING_URL_TTL_SECONDS).not.toBe(900);
    expect(STAGING_URL_TTL_SECONDS).toBeGreaterThan(60);
  });
});

describe('stagingKey', () => {
  it('segregates under ig-staging/ so a lifecycle rule can sweep leftovers', () => {
    expect(stagingKey('g1', 'p1')).toBe('ig-staging/g1/p1.jpg');
  });
  it('never collides across groups for the same photo', () => {
    expect(stagingKey('g1', 'p1')).not.toBe(stagingKey('g2', 'p1'));
  });
});

describe('countHashtags / countMentions', () => {
  it('counts tags at start and after whitespace', () => expect(countHashtags('#a b #c')).toBe(2));
  it('does not count a mid-word #', () => expect(countHashtags('a#b')).toBe(0));
  it('does not count an email @ as a mention', () => expect(countMentions('mail me at dave@example.com')).toBe(0));
  it('counts a real mention', () => expect(countMentions('hi @gardensatmathews')).toBe(1));
  it('handles empty/null', () => {
    expect(countHashtags('')).toBe(0);
    expect(countMentions(null)).toBe(0);
  });
  it('counts unicode hashtags', () => expect(countHashtags('#jardín #garten')).toBe(2));
});

describe('validateInstagramRequest', () => {
  it('rejects missing photo_ids', () => expect(validateInstagramRequest({}).ok).toBe(false));
  it('rejects empty photo_ids', () => expect(validateInstagramRequest({ photo_ids: [] }).ok).toBe(false));
  it(`rejects more than ${IG_MAX_CAROUSEL}`, () => {
    const ids = Array.from({ length: IG_MAX_CAROUSEL + 1 }, (_, i) => `p${i}`);
    expect(validateInstagramRequest({ photo_ids: ids }).ok).toBe(false);
  });
  it('rejects duplicates', () => expect(validateInstagramRequest({ photo_ids: ['a', 'a'] }).ok).toBe(false));

  it('rejects a caption Facebook would have accepted', () => {
    const caption = 'x'.repeat(IG_MAX_CAPTION + 1);
    expect(caption.length).toBeLessThan(MAX_CAPTION);   // FB would allow this
    expect(validateInstagramRequest({ photo_ids: ['a'], caption }).ok).toBe(false);
  });
  it(`rejects more than ${IG_MAX_HASHTAGS} hashtags`, () => {
    const caption = Array.from({ length: IG_MAX_HASHTAGS + 1 }, (_, i) => `#t${i}`).join(' ');
    expect(validateInstagramRequest({ photo_ids: ['a'], caption }).ok).toBe(false);
  });
  it(`rejects more than ${IG_MAX_MENTIONS} mentions`, () => {
    const caption = Array.from({ length: IG_MAX_MENTIONS + 1 }, (_, i) => `@u${i}`).join(' ');
    expect(validateInstagramRequest({ photo_ids: ['a'], caption }).ok).toBe(false);
  });
  it('accepts exactly at the caption limit', () => {
    expect(validateInstagramRequest({ photo_ids: ['a'], caption: 'x'.repeat(IG_MAX_CAPTION) }).ok).toBe(true);
  });
  it('accepts a valid request and echoes normalized fields', () => {
    const r = validateInstagramRequest({ photo_ids: ['a', 'b'], caption: 'hi #garden', client_request_id: 'req-1' });
    expect(r.ok).toBe(true);
    expect(r.photoIds).toEqual(['a', 'b']);
    expect(r.caption).toBe('hi #garden');
    expect(r.clientRequestId).toBe('req-1');
  });
  it('does not return a caption it rejected', () => {
    const r = validateInstagramRequest({ photo_ids: ['a'], caption: 'x'.repeat(IG_MAX_CAPTION + 1) });
    expect(r.caption).toBeNull();
  });
});

describe('checkImageBytes', () => {
  it('accepts a typical prod photo (~2MB)', () => expect(checkImageBytes(2199787).ok).toBe(true));
  it('accepts exactly at the cap', () => expect(checkImageBytes(IG_MAX_BYTES).ok).toBe(true));
  it('rejects one byte over', () => expect(checkImageBytes(IG_MAX_BYTES + 1).ok).toBe(false));
  it('reports the size in the error so the user can act', () => {
    expect(checkImageBytes(IG_MAX_BYTES + 1).error).toMatch(/8MB/);
  });
});

describe('classifyContainerStatus', () => {
  it('FINISHED is finished and terminal but not published', () => {
    const c = classifyContainerStatus({ status_code: 'FINISHED' });
    expect(c.finished).toBe(true);
    expect(c.terminal).toBe(true);
    expect(c.published).toBe(false);
  });
  it('IN_PROGRESS is neither terminal nor publishable', () => {
    const c = classifyContainerStatus({ status_code: 'IN_PROGRESS' });
    expect(c.inProgress).toBe(true);
    expect(c.terminal).toBe(false);
    expect(c.finished).toBe(false);
  });
  // D5: collapsing ERROR and EXPIRED makes the retry path either useless or an infinite loop.
  it('ERROR is retryable with a fresh url', () => {
    const c = classifyContainerStatus({ status_code: 'ERROR', status: 'fetch failed' });
    expect(c.errored).toBe(true);
    expect(c.retryable).toBe(true);
    expect(c.terminal).toBe(true);
  });
  it('EXPIRED is terminal and NOT retryable', () => {
    const c = classifyContainerStatus({ status_code: 'EXPIRED' });
    expect(c.expired).toBe(true);
    expect(c.retryable).toBe(false);
    expect(c.terminal).toBe(true);
  });
  it('surfaces the status detail so an ERROR is diagnosable', () => {
    expect(classifyContainerStatus({ status_code: 'ERROR', status: 'media download failed' }).detail)
      .toBe('media download failed');
  });
  it('an unknown/absent code is non-terminal rather than falsely finished', () => {
    const c = classifyContainerStatus({});
    expect(c.finished).toBe(false);
    expect(c.terminal).toBe(false);
  });
});

describe('parsePublishingLimit', () => {
  it('reads usage and cap from the response rather than hardcoding 50 or 100', () => {
    const r = parsePublishingLimit({ data: [{ quota_usage: 7, config: { quota_total: 100 } }] });
    expect(r).toEqual({ known: true, used: 7, cap: 100 });
  });
  it('handles a missing config without inventing a cap', () => {
    expect(parsePublishingLimit({ data: [{ quota_usage: 3 }] })).toEqual({ known: true, used: 3, cap: null });
  });
  it('handles an empty response', () => {
    expect(parsePublishingLimit({}).known).toBe(false);
  });
});

describe('container field builders', () => {
  it('single image carries image_url and caption', () => {
    const f = fields(singleImageFields('https://s3/x.jpg', 'hello', 'TOK'));
    expect(f.image_url).toBe('https://s3/x.jpg');
    expect(f.caption).toBe('hello');
    expect(f.access_token).toBe('TOK');
    expect(f.is_carousel_item).toBeUndefined();
  });
  it('single image sends an empty caption rather than omitting it', () => {
    expect(fields(singleImageFields('u', null, 'TOK')).caption).toBe('');
  });

  // D3: a caption on a child is silently ignored by Instagram; it belongs on the parent. Asserting
  // its ABSENCE is what stops a future edit from "helpfully" adding it and losing the caption.
  it('carousel child sets is_carousel_item and carries NO caption', () => {
    const f = fields(carouselChildFields('https://s3/x.jpg', 'TOK'));
    expect(f.is_carousel_item).toBe('true');
    expect(f.image_url).toBe('https://s3/x.jpg');
    expect(f).not.toHaveProperty('caption');
  });
  it('carousel parent declares CAROUSEL, comma-joined children in order, and the caption', () => {
    const f = fields(carouselParentFields(['c1', 'c2', 'c3'], 'cap', 'TOK'));
    expect(f.media_type).toBe('CAROUSEL');
    expect(f.children).toBe('c1,c2,c3');
    expect(f.caption).toBe('cap');
    expect(f.image_url).toBeUndefined();  // the parent references children, it has no image of its own
  });
  it('carousel parent preserves child order (display order is children order)', () => {
    expect(fields(carouselParentFields(['b', 'a'], null, 'T')).children).toBe('b,a');
  });
});

// ── alt_text (V4-IGSHARE-001) ────────────────────────────────────────────────────────────────────
// Meta's parameter reference for POST /{ig-user-id}/media: "For image posts only. Alternative text,
// up to 1000 character, for an image. Only supported on a single image or image media in a
// carousel." So it belongs on the single container and on each carousel CHILD — never the parent.
describe('igAltField', () => {
  const kv = (pairs) => Object.fromEntries(pairs);

  it('emits alt_text when there is a real description', () => {
    expect(kv(igAltField('Tie-Dye tomatoes, freshly harvested')).alt_text)
      .toBe('Tie-Dye tomatoes, freshly harvested');
  });

  it('OMITS the field entirely rather than sending an empty one', () => {
    // An empty alt_text is a stored, deliberate-looking "this image has no description" that
    // suppresses the platform's own handling. Absent is the correct state, not ''.
    for (const v of [null, undefined, '', '   ', 42, {}]) {
      expect(igAltField(v), `igAltField(${JSON.stringify(v)}) must omit`).toEqual([]);
    }
  });

  it('trims, so whitespace padding does not become the description', () => {
    expect(kv(igAltField('  ripe squash  ')).alt_text).toBe('ripe squash');
  });

  it('OMITS rather than truncating past the 1000-character cap', () => {
    // This text is a short DERIVED phrase, so anything near the cap means something upstream is
    // wrong. Truncating would hide that and could end mid-word; sending it would fail container
    // creation and burn a slot of the 400/24h quota.
    expect(igAltField('x'.repeat(IG_MAX_ALT_TEXT))).toHaveLength(1);
    expect(igAltField('x'.repeat(IG_MAX_ALT_TEXT + 1))).toEqual([]);
  });

  it('rides on a single image container and on a carousel CHILD, never the parent', () => {
    const single = kv(singleImageFields('https://s3/x.jpg', 'cap', 'TOK', 'a tomato'));
    expect(single.alt_text).toBe('a tomato');
    const child = kv(carouselChildFields('https://s3/x.jpg', 'TOK', 'a tomato'));
    expect(child.alt_text).toBe('a tomato');
    expect(child.is_carousel_item).toBe('true');
    // The parent takes no alt argument at all — it references children and holds no image.
    expect(kv(carouselParentFields(['c1'], 'cap', 'TOK'))).not.toHaveProperty('alt_text');
  });

  it('leaves the pre-alt call shapes unchanged when no alt is passed', () => {
    expect(kv(singleImageFields('u', 'c', 'T'))).not.toHaveProperty('alt_text');
    expect(kv(carouselChildFields('u', 'T'))).not.toHaveProperty('alt_text');
  });
});
