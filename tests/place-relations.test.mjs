import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlaceRelations, destinationExclusion } from '../src/server/place-relations.ts';
const place = (placeId, parentIds = [], childIds = []) => ({
    placeId,
    relations: { parentIds, childIds },
});
test('parses reported IDs, deduplicates them and does not infer relationships from names', () => {
    assert.deepEqual(
        parsePlaceRelations({
            containingPlaces: [
                { id: 'demo-garden', name: 'places/demo-garden' },
                { id: 'demo-garden' },
            ],
            subDestinations: [{ id: 'demo-pavilion' }],
        }),
        { parentIds: ['demo-garden'], childIds: ['demo-pavilion'] },
    );
    assert.deepEqual(parsePlaceRelations({}), { parentIds: [], childIds: [] });
});
for (const raw of [
    { containingPlaces: null },
    { containingPlaces: [{ id: '../bad' }] },
    { subDestinations: [{ id: 'demo', name: 'places/other' }] },
    { containingPlaces: Array.from({ length: 33 }, () => ({ id: 'demo' })) },
]) {
    test('rejects malformed or excessive relationship data: ' + JSON.stringify(raw), () =>
        assert.throws(
            () => parsePlaceRelations(raw),
            (error) => error.code === 'UPSTREAM_UNAVAILABLE',
        ),
    );
}
test('regression: a pavilion reported inside the destination garden is excluded', () => {
    assert.equal(
        destinationExclusion(place('demo-taiwan-pavilion', ['demo-gyoen']), place('demo-gyoen')),
        'DESTINATION_INTERIOR',
    );
    assert.equal(
        destinationExclusion(
            place('demo-taiwan-pavilion'),
            place('demo-gyoen', [], ['demo-taiwan-pavilion']),
        ),
        'DESTINATION_INTERIOR',
    );
});
test('handles known nested sites and a destination gate sharing a containing site', () => {
    assert.equal(
        destinationExclusion(place('demo-pavilion', ['demo-zone']), place('demo-garden'), [
            place('demo-zone', ['demo-garden']),
        ]),
        'DESTINATION_INTERIOR',
    );
    assert.equal(
        destinationExclusion(
            place('demo-pavilion', ['demo-garden']),
            place('demo-gate', ['demo-garden']),
        ),
        'SAME_DESTINATION_SITE',
    );
    assert.equal(
        destinationExclusion(place('demo-garden'), place('demo-gate', ['demo-garden'])),
        'DESTINATION_CONTAINER',
    );
});
test('does not confuse nearby but separate places, and terminates on cyclic data', () => {
    assert.equal(destinationExclusion(place('demo-street-art'), place('demo-garden')), null);
    assert.equal(
        destinationExclusion(place('demo-a', ['demo-b']), place('demo-garden'), [
            place('demo-b', ['demo-a']),
        ]),
        null,
    );
});
