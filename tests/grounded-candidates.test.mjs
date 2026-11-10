import assert from 'node:assert/strict';
import test from 'node:test';
import {
    loadGroundedCandidates,
    refreshGroundedCandidate,
} from '../src/server/grounded-candidates.ts';
import { demoAccess } from './helpers/exterior-access.mjs';
import { GoogleServiceError } from '../src/server/google-http.ts';
const at = '2026-11-08T01:00:00.000Z';
const input = () => ({
    request: {
        requestId: 'demo',
        origin: { latitude: 35.69, longitude: 139.7 },
        destination: { placeId: 'demo-destination' },
        arriveBy: '2026-11-08T03:00:00.000Z',
        travelMode: 'WALK',
        excludedPlaceIds: [],
    },
    destination: {
        placeId: 'demo-destination',
        label: '架空の目的地',
        latitude: 35.69,
        longitude: 139.71,
    },
});
const proposal = (placeId) => ({
    placeId,
    sourceTitle: '架空の彫刻',
    sourceUrl: 'https://maps.google.com/?cid=demo',
    title: '意匠を眺める',
    description: '自動テスト用',
    accessEvidence: demoAccess(placeId),
    sources: [{ title: '架空の彫刻', url: 'https://maps.google.com/?cid=demo' }],
});
const candidate = (placeId) => ({
    place: { placeId, label: '架空の彫刻', latitude: 35.69, longitude: 139.7 },
    types: ['tourist_attraction'],
    businessStatus: 'OPERATIONAL',
    opening: { status: 'unknown' },
    retrievedAt: at,
    relations: { parentIds: [], childIds: [] },
    attributions: ['Google Maps'],
    sourceUrl: null,
});
const options = (changes = {}) => ({
    connection: () => ({
        apiKey: 'test-maps-key',
        vertexAuthentication: {
            projectId: 'demo-vertex-project',
            location: 'global',
            getAccessToken: async () => 'test-vertex-token',
        },
    }),
    remainingMs: () => 20000,
    now: () => new Date(at),
    discover: async () => ({ candidates: [proposal('demo-art')], warnings: [], attributions: [] }),
    getDetails: async (id) => candidate(id),
    ...changes,
});
test('uses separate credentials and hydrates grounded IDs through Places', async () => {
    const result = await loadGroundedCandidates(
        input(),
        options({
            discover: async (_input, connection) => {
                assert.equal(connection.vertexAuthentication.projectId, 'demo-vertex-project');
                assert.equal(connection.timeoutMs, 18000);
                return { candidates: [proposal('demo-art')], warnings: [], attributions: [] };
            },
            getDetails: async (id, connection) => {
                assert.equal(connection.apiKey, 'test-maps-key');
                return candidate(id);
            },
        }),
    );
    assert.equal(result.candidates[0].accessEvidence.placeId, 'demo-art');
    assert.equal(result.candidates[0].groundedExperience.title, '意匠を眺める');
});
test('hydrates with two workers and restores the model order', async () => {
    let active = 0,
        maximum = 0;
    const proposals = ['demo-a', 'demo-b', 'demo-c', 'demo-d'].map(proposal);
    const result = await loadGroundedCandidates(
        input(),
        options({
            discover: async () => ({ candidates: proposals, warnings: [], attributions: [] }),
            getDetails: async (id) => {
                active++;
                maximum = Math.max(maximum, active);
                await new Promise((resolve) => setTimeout(resolve, id === 'demo-a' ? 5 : 1));
                active--;
                return candidate(id);
            },
        }),
    );
    assert.equal(maximum, 2);
    assert.deepEqual(
        result.candidates.map((item) => item.place.placeId),
        proposals.map((item) => item.placeId),
    );
});
test('filters AI proposals beyond the spatial bound without inventing a walking route', async () => {
    const result = await loadGroundedCandidates(
        input(),
        options({
            getDetails: async (id) => ({
                ...candidate(id),
                place: { ...candidate(id).place, latitude: 36 },
            }),
        }),
    );
    assert.deepEqual(result.candidates, []);
    assert.equal(result.warnings[0].code, 'AI_CANDIDATE_OUTSIDE_SEARCH');
});
test('revalidation requests only the selected place and discards stale evidence when unsupported', async () => {
    const selected = { ...candidate('demo-art'), accessEvidence: demoAccess('demo-art') };
    const result = await refreshGroundedCandidate(
        selected,
        input(),
        options({
            discover: async (value) => {
                assert.equal(value.selectedPlace.placeId, selected.place.placeId);
                return { candidates: [], warnings: [], attributions: [] };
            },
        }),
    );
    assert.equal(result.candidate.accessEvidence, undefined);
});

const discoverIds =
    (...ids) =>
    async () => ({
        candidates: ids.map(proposal),
        warnings: [],
        attributions: [],
    });

test('keeps valid candidates in proposal order after a non-retryable details failure', async () => {
    const result = await loadGroundedCandidates(
        input(),
        options({
            discover: discoverIds('demo-gone', 'demo-a', 'demo-b'),
            getDetails: async (id) => {
                if (id === 'demo-gone')
                    throw new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', false);
                return candidate(id);
            },
        }),
    );
    assert.deepEqual(
        result.candidates.map((item) => item.place.placeId),
        ['demo-a', 'demo-b'],
    );
    assert.deepEqual(result.exclusions, [
        {
            stage: 'discovery',
            placeLabel: '架空の彫刻',
            reason: 'DETAILS_UNAVAILABLE',
            source: { provider: 'Google Places', url: null },
            facts: { retryable: false },
        },
    ]);
    assert.equal(
        result.warnings.filter((item) => item.code === 'AI_CANDIDATE_DETAILS_UNAVAILABLE').length,
        1,
    );
});

test('keeps a valid candidate when another details request has a retryable failure', async () => {
    const result = await loadGroundedCandidates(
        input(),
        options({
            discover: discoverIds('demo-good', 'demo-failed'),
            getDetails: async (id) => {
                if (id === 'demo-failed')
                    throw new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', true);
                return candidate(id);
            },
        }),
    );
    assert.equal(result.candidates[0].place.placeId, 'demo-good');
    assert.equal(result.exclusions[0].facts.retryable, true);
});

test('returns exclusions when every proposal has a non-retryable details failure', async () => {
    const result = await loadGroundedCandidates(
        input(),
        options({
            discover: discoverIds('demo-gone-a', 'demo-gone-b'),
            getDetails: async () => {
                throw new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', false);
            },
        }),
    );
    assert.deepEqual(result.candidates, []);
    assert.equal(result.exclusions.length, 2);
    assert.equal(result.warnings.length, 1);
});

test('preserves an all-candidate retryable details outage as an error', async () => {
    const failure = new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', true);
    await assert.rejects(
        loadGroundedCandidates(
            input(),
            options({
                discover: discoverIds('demo-failed-a', 'demo-failed-b'),
                getDetails: async () => {
                    throw failure;
                },
            }),
        ),
        (error) => error === failure,
    );
});

test('returns the retryable failure when a non-retryable failure occurred first', async () => {
    const retryable = new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', true);
    await assert.rejects(
        loadGroundedCandidates(
            input(),
            options({
                discover: discoverIds('demo-gone', 'demo-failed'),
                getDetails: async (id) => {
                    if (id === 'demo-gone')
                        throw new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', false);
                    throw retryable;
                },
            }),
        ),
        (error) => error === retryable,
    );
});

test('does not hide retryable failures when the hydrated candidate is outside the search area', async () => {
    const failure = new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', true);
    await assert.rejects(
        loadGroundedCandidates(
            input(),
            options({
                discover: discoverIds('demo-outside', 'demo-failed'),
                getDetails: async (id) => {
                    if (id === 'demo-failed') throw failure;
                    return { ...candidate(id), place: { ...candidate(id).place, latitude: 36 } };
                },
            }),
        ),
        (error) => error === failure,
    );
});

for (const failure of [
    new GoogleServiceError(504, 'TIMEOUT', true),
    new GoogleServiceError(429, 'RATE_LIMITED', true),
    new GoogleServiceError(500, 'INTERNAL_ERROR', false),
    new DOMException('Cancelled', 'AbortError'),
    new Error('Unexpected failure'),
]) {
    test(`does not suppress ${failure.code ?? failure.name} from details`, async () => {
        await assert.rejects(
            loadGroundedCandidates(
                input(),
                options({
                    discover: discoverIds('demo-good', 'demo-failed'),
                    getDetails: async (id) => {
                        if (id === 'demo-failed') throw failure;
                        return candidate(id);
                    },
                }),
            ),
            (error) => error === failure,
        );
    });
}
