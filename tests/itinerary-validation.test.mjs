import assert from 'node:assert/strict';
import test from 'node:test';
import { revalidateItinerary } from '../src/server/itinerary-validation.ts';
import {
    issueOptionToken,
    verifyOptionToken,
    OPTION_TOKEN_TTL_MS,
} from '../src/server/option-token.ts';
import { RouteNotFoundError } from '../src/server/routes.ts';
import { GoogleServiceError } from '../src/server/google-http.ts';
import { apiCapabilities } from '../src/server/api-capabilities.ts';
import { demoAccess } from './helpers/exterior-access.mjs';
const start = Date.parse('2026-11-08T10:00:00+09:00');
const at = (minutes) => new Date(start + minutes * 60000).toISOString();
const secret = 'test-only-signing-secret-32-characters';
const base = () => ({
    requestId: 'demo-validation',
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'demo-destination' },
    arriveBy: at(90),
    travelMode: 'WALK',
    excludedPlaceIds: [],
});
const input = () => ({
    ...base(),
    selectedPlaceId: 'demo-park',
    experienceId: 'public-exterior-v2',
    optionToken: issueOptionToken(
        base(),
        { placeId: 'demo-park', experienceId: 'public-exterior-v2' },
        secret,
        start,
    ).optionToken,
});
const candidate = () => ({
    place: {
        placeId: 'demo-park',
        label: '自動テスト用の架空公園',
        latitude: 35.69,
        longitude: 139.7,
    },
    types: ['park'],
    businessStatus: 'OPERATIONAL',
    retrievedAt: at(0),
    sourceUrl: null,
    attributions: ['Google Maps'],
    accessEvidence: demoAccess('demo-park'),
    opening: {
        status: 'known',
        coverageStart: at(-600),
        coverageEnd: at(600),
        windows: [{ opensAt: at(-60), closesAt: at(120) }],
    },
});
const route = () => ({
    travelMode: 'WALK',
    durationSeconds: 600,
    distanceMeters: 500,
    provider: 'Google Routes',
    warnings: [{ code: 'WALKING_BETA', message: 'テスト用' }],
    attributions: ['Google Maps'],
});
const options = (changes = {}) => ({
    apiKey: 'test-key',
    fetch: async () => Response.json({}, { status: 503 }),
    signingSecret: secret,
    now: () => new Date(start),
    getCandidate: async () => candidate(),
    getDestination: async () => ({
        place: { ...candidate().place, placeId: 'demo-destination' },
        relations: { parentIds: [], childIds: [] },
        attributions: ['Google Maps'],
    }),
    computeRoute: async () => route(),
    ...changes,
});
test('revalidates only the selected place, refreshes all three routes and renews its token', async () => {
    const value = {
        ...input(),
        origin: { latitude: 35.7, longitude: 139.71 },
        requestId: 'new-id',
    };
    const calls = [];
    const result = await revalidateItinerary(
        value,
        options({
            getCandidate: async (id) => {
                assert.equal(id, value.selectedPlaceId);
                return candidate();
            },
            computeRoute: async (request) => {
                calls.push(request);
                return route();
            },
        }),
    );
    assert.equal(result.status, 'VALID');
    assert.equal(result.requestId, 'new-id');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].origin, value.origin);
    assert.deepEqual(calls[1].destination, { placeId: value.selectedPlaceId });
    assert.equal(result.option.place.placeId, value.selectedPlaceId);
    assert.notEqual(result.option.optionToken, value.optionToken);
    assert.equal(
        verifyOptionToken({ ...value, optionToken: result.option.optionToken }, secret, start)
            .status,
        'valid',
    );
});
test('expired or invalid tokens and visited selections make no paid calls', async () => {
    const fail = async () => assert.fail('no paid calls');
    assert.equal(
        (
            await revalidateItinerary(
                input(),
                options({ now: () => new Date(start + OPTION_TOKEN_TTL_MS), getCandidate: fail }),
            )
        ).status,
        'EXPIRED',
    );
    await assert.rejects(
        revalidateItinerary(
            { ...input(), optionToken: 'demo-forged-token' },
            options({ getCandidate: fail }),
        ),
        (error) => error.code === 'INVALID_INPUT',
    );
    assert.equal(
        (
            await revalidateItinerary(
                { ...input(), excludedPlaceIds: ['demo-park'] },
                options({ getCandidate: fail }),
            )
        ).status,
        'NO_LONGER_FEASIBLE',
    );
});
test('confirmed closure prevents routing and never substitutes another option', async () => {
    for (const change of [{ businessStatus: 'CLOSED_PERMANENTLY' }]) {
        const result = await revalidateItinerary(
            input(),
            options({
                getCandidate: async () => ({ ...candidate(), ...change }),
                computeRoute: async () => assert.fail('no route calls'),
            }),
        );
        assert.equal(result.status, 'NO_LONGER_FEASIBLE');
        assert.equal(result.option, null);
    }
});
test('latency, a longer route or an early closing can invalidate the plan', async () => {
    const value = input();
    // Change the signed deadline by issuing another genuine token for this scenario.
    value.arriveBy = at(50);
    value.optionToken = issueOptionToken(
        value,
        { placeId: value.selectedPlaceId, experienceId: value.experienceId },
        secret,
        start,
    ).optionToken;
    let clock = start;
    const result = await revalidateItinerary(
        value,
        options({
            now: () => new Date(clock),
            computeRoute: async () => {
                clock += 1000;
                return route();
            },
        }),
    );
    assert.equal(result.status, 'NO_LONGER_FEASIBLE');
    assert.equal(result.option, null);
    const early = candidate();
    early.opening.windows[0].closesAt = at(29);
    assert.equal(
        (await revalidateItinerary(input(), options({ getCandidate: async () => early }))).status,
        'NO_LONGER_FEASIBLE',
    );
    assert.equal(
        (
            await revalidateItinerary(
                input(),
                options({ computeRoute: async () => ({ ...route(), durationSeconds: 4000 }) }),
            )
        ).status,
        'NO_LONGER_FEASIBLE',
    );
});
test('checks token expiry again after provider work', async () => {
    let clock = start,
        calls = 0;
    const result = await revalidateItinerary(
        input(),
        options({
            now: () => new Date(clock),
            computeRoute: async () => {
                if (++calls === 3) clock += OPTION_TOKEN_TTL_MS;
                return route();
            },
        }),
    );
    assert.equal(result.status, 'EXPIRED');
    assert.equal(result.option, null);
});
test('expiry during a closure lookup still reports EXPIRED', async () => {
    let clock = start;
    const result = await revalidateItinerary(
        input(),
        options({
            now: () => new Date(clock),
            getCandidate: async () => {
                clock += OPTION_TOKEN_TTL_MS;
                return { ...candidate(), businessStatus: 'CLOSED_TEMPORARILY' };
            },
        }),
    );
    assert.equal(result.status, 'EXPIRED');
});
test('missing candidate route is infeasible; provider outage remains an error', async () => {
    for (const error of [
        new RouteNotFoundError(),
        new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', true),
    ]) {
        let calls = 0;
        const work = revalidateItinerary(
            input(),
            options({
                computeRoute: async () => {
                    if (++calls > 1) throw error;
                    return route();
                },
            }),
        );
        if (error instanceof RouteNotFoundError)
            assert.equal((await work).status, 'NO_LONGER_FEASIBLE');
        else await assert.rejects(work, (caught) => caught === error);
    }
});
test('pre-aborted validation does not fetch selected-place data', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        revalidateItinerary(
            input(),
            options({
                signal: controller.signal,
                getCandidate: async () => assert.fail('no call'),
            }),
        ),
        (error) => error.code === 'TIMEOUT',
    );
});
test('capabilities enables walking only with Maps auth, Vertex project and signing secret, without claiming an area boundary', () => {
    assert.deepEqual(apiCapabilities({}).supportedTravelModes, []);
    assert.equal(apiCapabilities({ GOOGLE_MAPS_API_KEY: 'test-key' }).dataMode, 'demo');
    const ready = apiCapabilities({
        GOOGLE_MAPS_API_KEY: 'test-key',
        OPTION_TOKEN_SECRET: secret,
        GOOGLE_CLOUD_PROJECT: 'demo-vertex-project',
    });
    assert.deepEqual(ready.supportedTravelModes, ['WALK']);
    assert.equal(ready.dataMode, 'live');
    assert.equal(ready.areaBoundaryConfigured, false);
});

test('fresh destination containment also rejects previously signed pavilion selections', async () => {
    const result = await revalidateItinerary(
        input(),
        options({
            getDestination: async () => ({
                place: { ...candidate().place, placeId: 'demo-destination' },
                relations: { parentIds: [], childIds: ['demo-park'] },
                attributions: ['Google Maps'],
            }),
            computeRoute: async () => assert.fail('no route calls for destination interior'),
        }),
    );
    assert.equal(result.status, 'NO_LONGER_FEASIBLE');
    assert.ok(result.warnings.some((warning) => warning.code === 'DESTINATION_INTERIOR'));
    assert.equal(result.exclusions[0].source.provider, 'Google Places');
    assert.equal(result.exclusions[0].facts.destinationRelationSource, 'google_places');
});

test('missing admission evidence keeps a signed provisional plan with explicit unknowns', async () => {
    const result = await revalidateItinerary(
        input(),
        options({
            getCandidate: async () => ({ ...candidate(), accessEvidence: undefined }),
        }),
    );
    assert.equal(result.status, 'VALID');
    assert.ok(result.warnings.some((warning) => warning.code === 'UNCONFIRMED_EXTERIOR_ACCESS'));
});

test('old automatically generated exterior experiences are not accepted under the new policy', async () => {
    const value = { ...input(), experienceId: 'exterior-view-v1' };
    value.optionToken = issueOptionToken(
        value,
        { placeId: value.selectedPlaceId, experienceId: value.experienceId },
        secret,
        start,
    ).optionToken;
    const result = await revalidateItinerary(
        value,
        options({ getCandidate: async () => assert.fail('no paid calls') }),
    );
    assert.equal(result.status, 'NO_LONGER_FEASIBLE');
});

test('severe visit weather invalidates the selected outdoor experience without switching places', async () => {
    const result = await revalidateItinerary(
        input(),
        options({
            fetch: async () =>
                Response.json({
                    timeZone: { id: 'Asia/Tokyo' },
                    forecastHours: [
                        {
                            interval: {
                                startTime: '2026-11-08T01:00:00Z',
                                endTime: '2026-11-08T02:00:00Z',
                            },
                            weatherCondition: {
                                type: 'THUNDERSTORM',
                                description: { text: '雷雨' },
                            },
                        },
                    ],
                }),
        }),
    );
    assert.equal(result.status, 'NO_LONGER_FEASIBLE');
    assert.equal(result.option, null);
    assert.ok(result.warnings.some((warning) => warning.code === 'WEATHER_UNSUITABLE'));
});

test('token expiration during the forecast lookup cannot return a fresh VALID option', async () => {
    let clock = start;
    const result = await revalidateItinerary(
        input(),
        options({
            now: () => new Date(clock),
            fetch: async () => {
                clock += OPTION_TOKEN_TTL_MS;
                return Response.json({}, { status: 503 });
            },
        }),
    );
    assert.equal(result.status, 'EXPIRED');
    assert.equal(result.option, null);
});
