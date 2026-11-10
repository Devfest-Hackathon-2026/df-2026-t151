import assert from 'node:assert/strict';
import test from 'node:test';
import { getDirectJourney } from '../src/server/direct-journey.ts';
import { GoogleServiceError } from '../src/server/google-http.ts';
import { RouteNotFoundError } from '../src/server/routes.ts';

const start = Date.parse('2026-11-08T14:00:00+09:00');
const at = (seconds) => new Date(start + seconds * 1000).toISOString();
const input = () => ({
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'demo-destination' },
    arriveBy: at(1800),
    travelMode: 'WALK',
});
const route = () => ({
    durationSeconds: 600,
    distanceMeters: 700,
    travelMode: 'WALK',
    provider: 'Google Routes',
    warnings: [{ code: 'WALKING_BETA', message: '徒歩経路の注意（テスト用）' }],
    attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com/' }],
});
const options = (changes = {}) => ({
    apiKey: 'test-only-key',
    now: () => new Date(start),
    computeRoute: async () => route(),
    ...changes,
});

test('uses the route provider and preserves provenance, warnings and input', async () => {
    const value = input();
    const before = structuredClone(value);
    const result = await getDirectJourney(
        value,
        options({
            computeRoute: async (request, config) => {
                assert.deepEqual(request, {
                    origin: value.origin,
                    destination: value.destination,
                    travelMode: 'WALK',
                });
                assert.equal(config.apiKey, 'test-only-key');
                return route();
            },
        }),
    );
    assert.equal(result.outcome, 'ON_TIME');
    assert.deepEqual(result.direct, { durationSeconds: 600, arrivalAt: at(600) });
    assert.equal(result.route.distanceMeters, 700);
    assert.equal(result.route.provider, 'Google Routes');
    assert.equal(result.route.retrievedAt, at(0));
    assert.equal(result.slackSeconds, 1200);
    assert.equal(result.warnings[0].code, 'WALKING_BETA');
    assert.equal(result.attributions[0].provider, 'Google Maps');
    assert.deepEqual(value, before);
});

for (const [seconds, expected] of [
    [600, 'ON_TIME'],
    [601, 'ON_TIME'],
    [599, 'DIRECT_LATE'],
]) {
    test(`a ${seconds}-second deadline yields ${expected} for a 600-second route`, async () => {
        assert.equal(
            (await getDirectJourney({ ...input(), arriveBy: at(seconds) }, options())).outcome,
            expected,
        );
    });
}

test('one millisecond short is late without rounding the deadline', async () => {
    const arriveBy = new Date(start + 600000 - 1).toISOString();
    const result = await getDirectJourney({ ...input(), arriveBy }, options());
    assert.equal(result.outcome, 'DIRECT_LATE');
    assert.equal(result.slackSeconds, -1);
});

test('bases departure on the server time after provider latency, without adding a hidden buffer', async () => {
    let calls = 0;
    const result = await getDirectJourney(
        { ...input(), arriveBy: at(601) },
        options({ now: () => new Date(start + (calls++ === 0 ? 0 : 2) * 1000) }),
    );
    assert.equal(result.calculatedAt, at(2));
    assert.equal(result.direct.arrivalAt, at(602));
    assert.equal(result.outcome, 'DIRECT_LATE');
    assert.equal(result.direct.durationSeconds, 600);
});

test('a deadline that passes during the provider call produces DIRECT_LATE', async () => {
    let calls = 0;
    const result = await getDirectJourney(
        { ...input(), arriveBy: at(1) },
        options({ now: () => new Date(start + (calls++ === 0 ? 0 : 2) * 1000) }),
    );
    assert.equal(result.outcome, 'DIRECT_LATE');
});

test('a backwards server clock cannot create more slack', async () => {
    let calls = 0;
    const result = await getDirectJourney(
        input(),
        options({ now: () => new Date(start + (calls++ === 0 ? 0 : -60) * 1000) }),
    );
    assert.equal(result.calculatedAt, at(0));
    assert.equal(result.slackSeconds, 1200);
});

test('ignores client time and rejects invalid input before a paid request', async () => {
    let calls = 0;
    const config = options({
        computeRoute: async () => {
            calls++;
            return route();
        },
    });
    await getDirectJourney({ ...input(), calculatedAt: '1900-01-01T00:00:00Z' }, config);
    assert.equal(calls, 1);
    for (const changes of [
        { arriveBy: at(0) },
        { arriveBy: '2026-11-08T15:00:00' },
        { arriveBy: '2026-02-30T15:00:00Z' },
        { origin: null },
        { origin: { latitude: 100, longitude: 139.7 } },
        { destination: { placeId: '' } },
        { travelMode: 'FLY' },
    ]) {
        await assert.rejects(
            getDirectJourney({ ...input(), ...changes }, config),
            (error) => error.status === 400,
        );
    }
    for (const travelMode of ['DRIVE', 'TRANSIT', 'BICYCLE']) {
        await assert.rejects(
            getDirectJourney({ ...input(), travelMode }, config),
            (error) => error.code === 'UNSUPPORTED_MODE',
        );
    }
    assert.equal(calls, 1);
});

test('no route and provider errors propagate instead of fabricating a successful direct time', async () => {
    for (const error of [new RouteNotFoundError(), new GoogleServiceError(504, 'TIMEOUT', true)]) {
        await assert.rejects(
            getDirectJourney(
                input(),
                options({
                    computeRoute: async () => {
                        throw error;
                    },
                }),
            ),
            (actual) => actual === error,
        );
    }
});

test('supports the same instant across timezones and midnight', async () => {
    const config = options({ now: () => new Date('2026-11-08T23:55:00+09:00') });
    const result = await getDirectJourney({ ...input(), arriveBy: '2026-11-08T15:05:00Z' }, config);
    assert.equal(result.outcome, 'ON_TIME');
    assert.equal(result.direct.arrivalAt, '2026-11-08T15:05:00.000Z');
});

test('zero-duration routes remain valid while invalid or overflowing durations fail', async () => {
    assert.equal(
        (
            await getDirectJourney(
                input(),
                options({ computeRoute: async () => ({ ...route(), durationSeconds: 0 }) }),
            )
        ).direct.arrivalAt,
        at(0),
    );
    for (const durationSeconds of [-1, NaN, 0.5, Number.MAX_SAFE_INTEGER]) {
        await assert.rejects(
            getDirectJourney(
                input(),
                options({ computeRoute: async () => ({ ...route(), durationSeconds }) }),
            ),
            GoogleServiceError,
        );
    }
});
