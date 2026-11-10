import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleServiceError } from '../src/server/google-http.ts';
import { computeWalkingRoute, RouteNotFoundError } from '../src/server/routes.ts';

const input = () => ({
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'demo-destination' },
    travelMode: 'WALK',
});
const route = () => ({ duration: '600s', distanceMeters: 700, warnings: ['架空の経路注意'] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const run = (value) =>
    computeWalkingRoute(input(), { apiKey: 'test-only-key', fetch: async () => json(value) });

test('requests only walking duration, distance and warnings, with no traffic assumptions', async () => {
    let calls = 0;
    const result = await computeWalkingRoute(input(), {
        apiKey: 'test-only-key',
        fetch: async (url, init) => {
            calls++;
            assert.equal(url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
            assert.equal(
                new Headers(init.headers).get('X-Goog-FieldMask'),
                'routes.duration,routes.distanceMeters,routes.warnings',
            );
            assert.equal(new Headers(init.headers).get('X-Goog-Api-Key'), 'test-only-key');
            assert.equal(init.redirect, 'error');
            assert.equal(init.cache, 'no-store');
            assert.deepEqual(JSON.parse(init.body), {
                origin: { location: { latLng: { latitude: 35.69, longitude: 139.7 } } },
                destination: { placeId: 'demo-destination' },
                travelMode: 'WALK',
                computeAlternativeRoutes: false,
                languageCode: 'ja',
                units: 'METRIC',
            });
            return json({ routes: [route()] });
        },
    });
    assert.equal(calls, 1);
    assert.equal(result.durationSeconds, 600);
    assert.equal(result.distanceMeters, 700);
    assert.equal(result.provider, 'Google Routes');
    assert.equal(result.warnings[0].code, 'WALKING_BETA');
    assert.equal(result.warnings[1].message, '架空の経路注意');
    assert.equal(result.attributions[0].provider, 'Google Maps');
});

test('supports place IDs and coordinates for either endpoint', async () => {
    const value = {
        origin: { placeId: 'demo-origin' },
        destination: { latitude: 0, longitude: 0 },
        travelMode: 'WALK',
    };
    await computeWalkingRoute(value, {
        apiKey: 'test',
        fetch: async (_url, init) => {
            const body = JSON.parse(init.body);
            assert.deepEqual(body.origin, { placeId: 'demo-origin' });
            assert.deepEqual(body.destination, {
                location: { latLng: { latitude: 0, longitude: 0 } },
            });
            return json({ routes: [route()] });
        },
    });
});

for (const [value, expected] of [
    ['600s', 600],
    ['600.000000000s', 600],
    ['600.000000001s', 601],
    ['600.5s', 601],
    ['0s', 0],
    ['0.1s', 1],
    ['315575999999.000000001s', 315576000000],
]) {
    test(`normalizes ${value} to ${expected} conservative integer seconds`, async () => {
        assert.equal(
            (await run({ routes: [{ ...route(), duration: value }] })).durationSeconds,
            expected,
        );
    });
}

for (const duration of [
    undefined,
    '',
    '600',
    '-1s',
    'NaNs',
    'Infinitys',
    '1e3s',
    '1.1234567890s',
    '315576000001s',
]) {
    test(`rejects an invalid duration: ${String(duration)}`, async () => {
        await assert.rejects(run({ routes: [{ ...route(), duration }] }), GoogleServiceError);
    });
}

test('distinguishes no route from a successful zero-duration route', async () => {
    for (const value of [{}, { routes: [] }]) {
        await assert.rejects(
            run(value),
            (error) =>
                error instanceof RouteNotFoundError &&
                error.code === 'UPSTREAM_UNAVAILABLE' &&
                !error.retryable,
        );
    }
    const result = await run({ routes: [{ duration: '0s', distanceMeters: 0 }] });
    assert.equal(result.durationSeconds, 0);
    assert.equal(result.distanceMeters, 0);
});

for (const payload of [
    null,
    [],
    { routes: null },
    { routes: {} },
    { routes: [null] },
    { routes: [route(), route()] },
    { routes: [{ ...route(), distanceMeters: -1 }] },
    { routes: [{ ...route(), distanceMeters: 0.5 }] },
    { routes: [{ ...route(), distanceMeters: undefined }] },
    { routes: [{ ...route(), warnings: [null] }] },
    { routes: [{ ...route(), warnings: 'unexpected' }] },
    { error: { message: 'private data' } },
]) {
    test(`rejects malformed route data: ${JSON.stringify(payload)}`, async () => {
        await assert.rejects(run(payload), GoogleServiceError);
    });
}

test('deduplicates provider warnings while retaining the mandatory beta warning', async () => {
    const result = await run({ routes: [{ ...route(), warnings: ['注意', '注意'] }] });
    assert.equal(result.warnings.length, 2);
    assert.equal(result.warnings[1].message, '注意');
});

test('invalid and unsupported input fails before any paid call', async () => {
    const options = { apiKey: 'test', fetch: async () => assert.fail('must not call Google') };
    for (const travelMode of ['DRIVE', 'TRANSIT', 'BICYCLE']) {
        await assert.rejects(
            computeWalkingRoute({ ...input(), travelMode }, options),
            (error) => error.status === 422 && error.code === 'UNSUPPORTED_MODE',
        );
    }
    for (const change of [
        { travelMode: 'FLY' },
        { origin: null },
        { origin: { latitude: 91, longitude: 139.7 } },
        { origin: { latitude: 35.69, longitude: NaN } },
        { destination: { placeId: '' } },
        { destination: { placeId: 'demo', latitude: 35.69, longitude: 139.7 } },
    ]) {
        await assert.rejects(
            computeWalkingRoute({ ...input(), ...change }, options),
            (error) => error.status === 400,
        );
    }
});

test('maps provider failures and does not expose input coordinates or a raw cause', async () => {
    for (const [status, expected] of [
        [403, 502],
        [429, 429],
        [503, 502],
        [504, 504],
    ]) {
        await assert.rejects(
            computeWalkingRoute(input(), {
                apiKey: 'test-only-key',
                fetch: async () =>
                    json({ error: { message: 'test-only-key 35.69 139.7' } }, status),
            }),
            (error) => {
                assert.equal(error.status, expected);
                assert.ok(!JSON.stringify(error).includes('35.69'));
                assert.ok(!String(error.stack).includes('test-only-key'));
                return true;
            },
        );
    }
});

test('the route transport also bounds time and response size', async () => {
    await assert.rejects(
        computeWalkingRoute(input(), {
            apiKey: 'test',
            fetch: async () => new Response(' '.repeat(1024 * 1024 + 1)),
        }),
        GoogleServiceError,
    );
    await assert.rejects(
        computeWalkingRoute(input(), {
            apiKey: 'test',
            timeoutMs: 10,
            fetch: async (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => reject(new Error('abort')), {
                        once: true,
                    });
                }),
        }),
        (error) => error.code === 'TIMEOUT',
    );
});
