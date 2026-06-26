import { describe, it, expect } from 'vitest';
import { assembleBulkEntities } from './bulk.js';

const tag = (entity_id, facet, slug) => ({ entity_id, id: `${facet}-${slug}-${entity_id}`, facet, label: slug, slug, source: 'derived', owner_id: 'system', visibility: 'shared', created_by: 'system', created_at: 't', updated_at: 't' });

describe('assembleBulkEntities', () => {
  it('returns {} for empty inputs', () => {
    expect(assembleBulkEntities([], [])).toEqual({});
    expect(assembleBulkEntities()).toEqual({});
  });
  it('groups by entity_id and strips the entity_id column off each tag', () => {
    const out = assembleBulkEntities([tag('p1','group','herbs')], [tag('p1','type','basil'), tag('p1','lifecycle','annual')]);
    expect(Object.keys(out)).toEqual(['p1']);
    expect(out.p1.direct).toHaveLength(1);
    expect(out.p1.projected.map(t => `${t.facet}:${t.slug}`)).toEqual(['type:basil','lifecycle:annual']);
    expect(out.p1.direct[0]).not.toHaveProperty('entity_id');
    expect(out.p1.projected[0]).not.toHaveProperty('entity_id');
  });
  it('separates direct vs projected and keeps multiple plantings distinct', () => {
    const out = assembleBulkEntities([tag('p1','group','herbs')], [tag('p2','type','pepper')]);
    expect(out.p1).toEqual({ direct: [expect.objectContaining({ facet: 'group' })], projected: [] });
    expect(out.p2).toEqual({ direct: [], projected: [expect.objectContaining({ facet: 'type' })] });
  });
});
