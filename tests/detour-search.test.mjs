import assert from 'node:assert/strict';
import test from 'node:test';
import { findDetourCandidates } from '../src/server/detour-search.ts';
import { GoogleServiceError, googlePostJson } from '../src/server/google-http.ts';
import { RouteNotFoundError } from '../src/server/routes.ts';
import { demoAccess } from './helpers/exterior-access.mjs';

const start = Date.parse('2026-11-08T10:00:00+09:00');
const at = (minutes) => new Date(start + minutes * 60000).toISOString();
const input = () => ({
    requestId: 'search-test',
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'demo-destination' },
    arriveBy: at(90),
    travelMode: 'WALK',
    excludedPlaceIds: [],
});
const candidate = (placeId = 'demo-park') => ({
    place: { placeId, label: '架空の公園', latitude: 35.69, longitude: 139.7 },
    types: ['park'],
    businessStatus: 'OPERATIONAL',
    retrievedAt: at(0),
    sourceUrl: null,
    attributions: ['Google Maps'],
    accessEvidence: demoAccess(placeId),
    opening: {
        status: 'known',
        coverageStart: at(-600),
        coverageEnd: at(600),
        windows: [{ opensAt: at(-60), closesAt: at(120) }],
    },
});
const route = (seconds = 600) => ({
    travelMode: 'WALK',
    durationSeconds: seconds,
    distanceMeters: 500,
    provider: 'Google Routes',
    warnings: [{ code: 'WALKING_BETA', message: '自動テスト用の注意' }],
    attributions: ['Google Maps'],
});
const options = (changes = {}) => ({
    apiKey: 'test-key',
    now: () => new Date(start),
    searchNearby: async () => [candidate()],
    computeRoute: async () => route(),
    ...changes,
});

test('combines real-provider boundaries and conservative estimates into unsigned options', async () => {
    const result = await findDetourCandidates(input(), options());
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(result.requestId, 'search-test');
    assert.equal(result.options.length, 1);
    const option = result.options[0];
    assert.equal(option.time.requiredSeconds, 50 * 60);
    assert.equal(option.time.arrivalAt, at(40));
    assert.equal(option.experienceDuration.sourceType, 'estimate');
    assert.match(option.experienceDuration.conditions, /実測値や施設公表値ではありません/);
    assert.equal('optionToken' in option, false);
    assert.equal('optionId' in option, false);
    assert.equal(result.context.weather.status, 'unknown');
    assert.equal(result.context.crowd.status, 'unknown');
});

test('does not pay for nearby searches when direct travel or its buffer misses the deadline', async () => {
    for (const [minutes, outcome] of [
        [9, 'DIRECT_LATE'],
        [15, 'NO_OPTIONS'],
    ]) {
        const result = await findDetourCandidates(
            { ...input(), arriveBy: at(minutes) },
            options({
                searchNearby: async () => {
                    assert.fail('nearby must not run');
                },
            }),
        );
        assert.equal(result.outcome, outcome);
        assert.equal(result.diagnostics.discoveredCount, 0);
    }
});

test('filters destinations, visited places, duplicates, closed businesses before routing, retaining unknown hours', async () => {
    const closed = { ...candidate('closed'), businessStatus: 'CLOSED_TEMPORARILY' };
    const unknown = { ...candidate('unknown'), opening: { status: 'unknown' } };
    let calls = 0;
    const result = await findDetourCandidates(
        { ...input(), excludedPlaceIds: ['visited'] },
        options({
            searchNearby: async () => [
                candidate('demo-destination'),
                candidate('visited'),
                closed,
                unknown,
                candidate(),
                candidate(),
            ],
            computeRoute: async () => {
                calls++;
                return route();
            },
        }),
    );
    assert.equal(calls, 5);
    assert.deepEqual(
        result.options.map((option) => option.place.placeId),
        ['demo-park', 'unknown'],
    );
    assert.deepEqual(result.diagnostics.excludedCounts, {
        EXCLUDED_OR_DUPLICATE: 3,
        NOT_OPERATIONAL: 1,
    });
});

test('caps discovered candidates, route work, parallelism and returned options', async () => {
    let calls = 0,
        active = 0,
        maximum = 0;
    const result = await findDetourCandidates(
        input(),
        options({
            searchNearby: async () =>
                Array.from({ length: 6 }, (_, index) => candidate(`demo-${index}`)),
            computeRoute: async () => {
                calls++;
                active++;
                maximum = Math.max(maximum, active);
                await new Promise((resolve) => setTimeout(resolve, 2));
                active--;
                return route();
            },
        }),
    );
    assert.equal(calls, 9);
    assert.equal(maximum, 2);
    assert.equal(result.diagnostics.evaluatedCount, 4);
    assert.equal(result.diagnostics.excludedCounts.SEARCH_LIMIT, 2);
    assert.deepEqual(
        result.options.map((option) => option.place.placeId),
        ['demo-0', 'demo-1', 'demo-2'],
    );
});

test('uses one post-fetch clock for both direct and candidate arrival estimates', async () => {
    let clock = start;
    const result = await findDetourCandidates(
        input(),
        options({
            now: () => new Date(clock),
            computeRoute: async () => {
                clock += 1000;
                return route();
            },
        }),
    );
    assert.equal(result.calculatedAt, new Date(start + 3000).toISOString());
    assert.equal(result.direct.arrivalAt, new Date(start + 603000).toISOString());
    assert.equal(result.options[0].time.stopArrivalAt, result.direct.arrivalAt);
});

test('provider latency can remove a previously exact-fit detour', async () => {
    let clock = start;
    const result = await findDetourCandidates(
        { ...input(), arriveBy: at(50) },
        options({
            now: () => new Date(clock),
            computeRoute: async () => {
                clock += 1000;
                return route();
            },
        }),
    );
    assert.equal(result.outcome, 'NO_OPTIONS');
    assert.equal(result.diagnostics.excludedCounts.TIME_LIMIT, 1);
});

test('rechecks direct lateness after all provider work', async () => {
    let calls = 0,
        clock = start;
    const result = await findDetourCandidates(
        { ...input(), arriveBy: at(30) },
        options({
            now: () => new Date(clock),
            computeRoute: async () => {
                if (++calls === 3) clock += 31 * 60000;
                return route();
            },
        }),
    );
    assert.equal(result.outcome, 'DIRECT_LATE');
    assert.deepEqual(result.options, []);
});

test('selects applicable registered duration before the provisional category estimate', async () => {
    const result = await findDetourCandidates(
        input(),
        options({
            durationEvidence: [
                {
                    placeId: 'demo-park',
                    experienceId: 'public-exterior-v2',
                    validFrom: at(-60),
                    validUntil: at(120),
                    conditionsMatched: true,
                    duration: {
                        minSeconds: 180,
                        maxSeconds: 300,
                        sourceType: 'registered',
                        sourceUrl: null,
                        checkedAt: at(-1),
                        includesWait: false,
                        conditions: '自動テスト用の登録済み条件',
                    },
                },
            ],
        }),
    );
    assert.equal(result.options[0].experienceDuration.sourceType, 'registered');
    assert.equal(result.options[0].time.experienceSeconds, 300);
});

test('only a missing candidate route is filtered; outages and rate limits remain errors', async () => {
    for (const error of [
        new RouteNotFoundError(),
        new GoogleServiceError(429, 'RATE_LIMITED', true),
        new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', true),
    ]) {
        let calls = 0;
        const work = findDetourCandidates(
            input(),
            options({
                computeRoute: async () => {
                    if (++calls > 1) throw error;
                    return route();
                },
            }),
        );
        if (error instanceof RouteNotFoundError) {
            const result = await work;
            assert.equal(result.outcome, 'NO_OPTIONS');
            assert.equal(result.diagnostics.excludedCounts.NO_ROUTE, 1);
        } else await assert.rejects(work, (caught) => caught === error);
    }
});

test('overall timeout aborts in-flight work and prevents further requests', async () => {
    let calls = 0,
        signal;
    await assert.rejects(
        findDetourCandidates(
            input(),
            options({
                workTimeoutMs: 30,
                computeRoute: async (_request, connection) => {
                    if (++calls === 1) return route();
                    signal = connection.signal;
                    return new Promise((_resolve, reject) =>
                        signal.addEventListener(
                            'abort',
                            () => reject(new GoogleServiceError(504, 'TIMEOUT', true)),
                            { once: true },
                        ),
                    );
                },
            }),
        ),
        (error) => error.code === 'TIMEOUT',
    );
    assert.equal(signal.aborted, true);
    assert.equal(calls, 2);
});

test('unsupported mode and pre-aborted search make no provider calls', async () => {
    const fail = async () => assert.fail('provider must not run');
    await assert.rejects(
        findDetourCandidates({ ...input(), travelMode: 'DRIVE' }, options({ computeRoute: fail })),
        (error) => error.code === 'UNSUPPORTED_MODE',
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        findDetourCandidates(input(), options({ signal: controller.signal, computeRoute: fail })),
        (error) => error.code === 'TIMEOUT',
    );
});

test(
    'parent cancellation reaches the HTTP request instead of waiting for its own timeout',
    { timeout: 1000 },
    async () => {
        const controller = new AbortController();
        let requestSignal;
        let requestStarted;
        const started = new Promise((resolve) => {
            requestStarted = resolve;
        });
        const work = googlePostJson(
            'nearby',
            {},
            {
                apiKey: 'test-key',
                signal: controller.signal,
                fetch: async (_url, request) => {
                    requestSignal = request.signal;
                    requestStarted();
                    return new Promise((_resolve, reject) =>
                        request.signal.addEventListener(
                            'abort',
                            () => reject(new Error('aborted')),
                            {
                                once: true,
                            },
                        ),
                    );
                },
            },
        );
        await started;
        controller.abort();
        await assert.rejects(work, (error) => error.code === 'TIMEOUT');
        assert.equal(requestSignal.aborted, true);
    },
);

test('regression: rejects destination garden facilities before requesting detour routes', async () => {
    let calls = 0;
    const pavilion = {
        ...candidate('demo-taiwan-pavilion'),
        relations: { parentIds: ['demo-destination'], childIds: [] },
    };
    const result = await findDetourCandidates(
        input(),
        options({
            searchNearby: async () => [pavilion, candidate('demo-street-art')],
            computeRoute: async () => {
                calls++;
                return route();
            },
        }),
    );
    assert.equal(result.diagnostics.excludedCounts.DESTINATION_INTERIOR, 1);
    assert.deepEqual(
        result.options.map((option) => option.place.placeId),
        ['demo-street-art'],
    );
    assert.equal(calls, 3);
});

test('unknown admission remains a provisional exterior without claiming verified access', async () => {
    let calls = 0;
    const unknown = { ...candidate(), accessEvidence: undefined };
    const result = await findDetourCandidates(
        input(),
        options({
            searchNearby: async () => [unknown],
            computeRoute: async () => {
                calls++;
                return route();
            },
        }),
    );
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(calls, 3);
    assert.ok(result.options[0].warnings.some((w) => w.code === 'UNCONFIRMED_EXTERIOR_ACCESS'));
    assert.ok(!result.options[0].warnings.some((w) => w.code === 'ACCESS_SOURCE'));
});

test('fresh discovery evidence is checked against the updated discovery clock', async () => {
    let clock = start;
    const result = await findDetourCandidates(
        input(),
        options({
            now: () => new Date(clock),
            searchNearby: async () => {
                clock += 5000;
                const value = candidate();
                value.retrievedAt = new Date(clock).toISOString();
                value.accessEvidence.checkedAt = new Date(clock).toISOString();
                return [value];
            },
        }),
    );
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(result.options.length, 1);
    assert.equal(result.calculatedAt, new Date(clock).toISOString());
});

test('a provisional first occurrence still excludes later duplicates before routing', async () => {
    let calls = 0;
    const result = await findDetourCandidates(
        input(),
        options({
            searchNearby: async () => [
                { ...candidate('demo-repeated'), opening: { status: 'unknown' } },
                candidate('demo-repeated'),
            ],
            computeRoute: async () => {
                calls++;
                return route();
            },
        }),
    );
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(calls, 3);
    assert.equal(result.diagnostics.evaluatedCount, 1);
    assert.deepEqual(result.diagnostics.excludedCounts, {
        EXCLUDED_OR_DUPLICATE: 1,
    });
});

test('discovery cap applies before filtering even when a seventh candidate is eligible', async () => {
    let calls = 0;
    const result = await findDetourCandidates(
        input(),
        options({
            searchNearby: async () => [
                ...Array.from({ length: 6 }, (_, index) => ({
                    ...candidate(`demo-closed-${index}`),
                    businessStatus: 'CLOSED_TEMPORARILY',
                })),
                candidate('demo-seventh'),
            ],
            computeRoute: async () => {
                calls++;
                return route();
            },
        }),
    );
    assert.equal(result.outcome, 'NO_OPTIONS');
    assert.equal(calls, 1);
    assert.equal(result.diagnostics.discoveredCount, 7);
    assert.equal(result.diagnostics.evaluatedCount, 0);
    assert.deepEqual(result.diagnostics.excludedCounts, { NOT_OPERATIONAL: 6 });
    assert.ok(result.warnings.some((warning) => warning.code === 'CANDIDATES_FILTERED'));
});
