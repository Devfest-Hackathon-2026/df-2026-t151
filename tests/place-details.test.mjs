import assert from 'node:assert/strict';
import test from 'node:test';
import { getDestination, getCandidateDetails } from '../src/server/place-details.ts';
const now = () => new Date('2026-11-08T10:00:00+09:00');
const raw = () => ({
    id: 'demo-place',
    displayName: { text: '架空の公園' },
    location: { latitude: 35.69, longitude: 139.7 },
    types: ['park'],
    businessStatus: 'OPERATIONAL',
    utcOffsetMinutes: 540,
    currentOpeningHours: { periods: [] },
});
test('gets the exact destination by ID with bounded fields and attribution', async () => {
    const result = await getDestination('demo-place', {
        apiKey: 'test-key',
        fetch: async (url, request) => {
            assert.equal(url, 'https://places.googleapis.com/v1/places/demo-place?languageCode=ja');
            assert.equal(request.method, 'GET');
            assert.equal(request.body, undefined);
            assert.equal(
                request.headers['X-Goog-FieldMask'],
                'id,displayName,location,attributions,containingPlaces,subDestinations',
            );
            assert.equal(request.cache, 'no-store');
            assert.equal(request.redirect, 'error');
            return Response.json(raw());
        },
    });
    assert.equal(result.place.label, '架空の公園');
    assert.equal(result.attributions[0].provider, 'Google Maps');
});
test('refreshes the selected place with hours rather than nearby-search membership', async () => {
    const candidate = await getCandidateDetails('demo-place', {
        apiKey: 'test-key',
        now,
        fetch: async (_url, request) => {
            assert.ok(request.headers['X-Goog-FieldMask'].includes('currentOpeningHours'));
            assert.ok(!request.headers['X-Goog-FieldMask'].includes('*'));
            return Response.json(raw());
        },
    });
    assert.equal(candidate.opening.status, 'known');
    assert.equal(candidate.retrievedAt, now().toISOString());
});
test('rejects invalid resource paths before making any paid request', async () => {
    for (const id of ['..', '../other', 'https://example.com', 'a?key=x', 'a/b', '']) {
        await assert.rejects(
            getDestination(id, { apiKey: 'test-key', fetch: async () => assert.fail('no call') }),
            (error) => error.code === 'INVALID_INPUT',
        );
    }
});
test('does not accept another place, missing essentials, or a raw provider error', async () => {
    for (const payload of [
        { ...raw(), id: 'other' },
        { id: 'demo-place' },
        { error: { message: 'secret raw data' } },
    ]) {
        await assert.rejects(
            getDestination('demo-place', {
                apiKey: 'test-key',
                fetch: async () => Response.json(payload),
            }),
            (error) => error.code === 'UPSTREAM_UNAVAILABLE' && !error.message.includes('secret'),
        );
    }
});
