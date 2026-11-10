import assert from 'node:assert/strict';
import test from 'node:test';
import { searchNearbyCandidates } from '../src/server/nearby-candidates.ts';

const origin = { latitude: 35.69, longitude: 139.7 };
const now = () => new Date('2026-11-08T10:00:00+09:00');
const place = () => ({
    id: 'demo-park',
    displayName: { text: '架空の公園' },
    location: origin,
    types: ['park'],
    businessStatus: 'OPERATIONAL',
    utcOffsetMinutes: 540,
    googleMapsUri: 'https://maps.google.com/?cid=example',
    currentOpeningHours: {
        periods: [
            {
                open: { date: { year: 2026, month: 11, day: 8 }, hour: 9 },
                close: { date: { year: 2026, month: 11, day: 8 }, hour: 18 },
            },
        ],
    },
});
const run = (body) =>
    searchNearbyCandidates(origin, { apiKey: 'test', now, fetch: async () => Response.json(body) });

test('requests a bounded nearby search with current hours and provenance', async () => {
    const result = await searchNearbyCandidates(origin, {
        apiKey: 'test',
        now,
        radiusMeters: 800,
        fetch: async (url, init) => {
            assert.equal(url, 'https://places.googleapis.com/v1/places:searchNearby');
            const body = JSON.parse(init.body);
            assert.equal(body.maxResultCount, 6);
            assert.equal(body.rankPreference, 'DISTANCE');
            assert.deepEqual(body.locationRestriction.circle, { center: origin, radius: 800 });
            assert.ok(
                new Headers(init.headers)
                    .get('X-Goog-FieldMask')
                    .includes('places.currentOpeningHours'),
            );
            return Response.json({ places: [place()] });
        },
    });
    assert.equal(result[0].place.placeId, 'demo-park');
    assert.equal(result[0].opening.status, 'known');
    assert.equal(result[0].sourceUrl, 'https://maps.google.com/?cid=example');
    assert.equal(result[0].attributions[0].provider, 'Google Maps');
});

test('handles empty searches and caps results while retaining unknown hours', async () => {
    assert.deepEqual(await run({}), []);
    const result = await run({
        places: Array.from({ length: 8 }, () => ({ ...place(), currentOpeningHours: undefined })),
    });
    assert.equal(result.length, 6);
    assert.equal(result[0].opening.status, 'unknown');
});

test('validates input before a paid request', async () => {
    const options = { apiKey: 'test', fetch: async () => assert.fail('must not call provider') };
    for (const center of [
        null,
        { latitude: 91, longitude: 139.7 },
        { latitude: 35.69, longitude: NaN },
    ]) {
        await assert.rejects(
            searchNearbyCandidates(center, options),
            (error) => error.status === 400,
        );
    }
    for (const radiusMeters of [0, 3001, 1.5])
        await assert.rejects(
            searchNearbyCandidates(origin, { ...options, radiusMeters }),
            (error) => error.status === 400,
        );
});

for (const body of [
    null,
    [],
    { places: null },
    { error: {} },
    { places: [{ ...place(), location: {} }] },
    { places: [{ ...place(), types: [null] }] },
    { places: [{ ...place(), googleMapsUri: 'javascript:bad' }] },
]) {
    test(`rejects malformed nearby data: ${JSON.stringify(body)}`, async () => {
        await assert.rejects(run(body), (error) => error.code === 'UPSTREAM_UNAVAILABLE');
    });
}
