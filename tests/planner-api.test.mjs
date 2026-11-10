import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    loadRecommendations,
    validateItinerary,
    PlannerApiError,
} from '../src/lib/client/planner-api.ts';

const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/search-success.json', import.meta.url), 'utf8'),
);
const input = {
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'test-destination' },
    arriveBy: '2026-11-09T03:00:00Z',
    travelMode: 'WALK',
    excludedPlaceIds: [],
};
function mockFetch(t, handler) {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    t.after(() => {
        globalThis.fetch = original;
    });
}
test('live search uses the API and accepts the correlated live response', async (t) => {
    mockFetch(t, async (url, init) => {
        assert.equal(url, '/api/v1/recommendations');
        assert.equal(init.method, 'POST');
        assert.equal(init.cache, 'no-store');
        const body = JSON.parse(init.body);
        assert.deepEqual(body.origin, input.origin);
        return Response.json({ ...fixture, dataMode: 'live', requestId: body.requestId });
    });
    const result = await loadRecommendations(input, new AbortController().signal);
    assert.equal(result.dataMode, 'live');
});
test('demo data from an API response is rejected instead of displayed as a search result', async (t) => {
    mockFetch(t, async (_url, init) =>
        Response.json({ ...fixture, requestId: JSON.parse(init.body).requestId }),
    );
    await assert.rejects(loadRecommendations(input, new AbortController().signal), PlannerApiError);
});
test('API failure remains an error and never falls back to fabricated options', async (t) => {
    mockFetch(t, async () => Response.json({}, { status: 503 }));
    await assert.rejects(
        loadRecommendations(input, new AbortController().signal),
        (error) => error instanceof PlannerApiError && error.retryable,
    );
});
test('selected-only validation keeps its selected experience and server calculation time', async (t) => {
    const selected = fixture.options[0];
    const query = {
        ...input,
        selectedPlaceId: selected.place.placeId,
        experienceId: selected.experienceId,
        optionToken: 'test-only-token',
    };
    mockFetch(t, async (url, init) => {
        assert.equal(url, '/api/v1/itineraries/validate');
        const body = JSON.parse(init.body);
        assert.equal(body.selectedPlaceId, query.selectedPlaceId);
        assert.equal(body.experienceId, query.experienceId);
        return Response.json({
            requestId: body.requestId,
            status: 'VALID',
            calculatedAt: '2026-11-09T02:00:00Z',
            option: selected,
            warnings: [],
            attributions: [],
        });
    });
    const result = await validateItinerary(query, new AbortController().signal);
    assert.equal(result.status, 'VALID');
    assert.equal(result.calculatedAt, '2026-11-09T02:00:00Z');
});
test('a timed out live API response retains the timeout error', async (t) => {
    mockFetch(t, async () => Response.json({}, { status: 504 }));
    await assert.rejects(loadRecommendations(input, new AbortController().signal), {
        name: 'TimeoutError',
    });
});
