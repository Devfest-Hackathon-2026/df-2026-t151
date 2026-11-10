import assert from 'node:assert/strict';
import test from 'node:test';
import { getRecommendations } from '../src/server/recommendations.ts';
import { verifyOptionToken } from '../src/server/option-token.ts';
import { searchNearbyCandidates } from '../src/server/nearby-candidates.ts';
import { demoAccess } from './helpers/exterior-access.mjs';
const start = Date.parse('2026-11-08T10:00:00+09:00');
const input = () => ({
    requestId: 'demo',
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'demo-destination' },
    arriveBy: '2026-11-08T12:00:00+09:00',
    travelMode: 'WALK',
    excludedPlaceIds: [],
});
const secret = 'test-only-signing-secret-32-characters';
const rawPlace = (id) => ({
    id,
    displayName: { text: '自動テスト用の架空地点' },
    location: { latitude: 35.69, longitude: 139.7 },
    types: ['park'],
    businessStatus: 'OPERATIONAL',
    utcOffsetMinutes: 540,
    currentOpeningHours: {
        periods: [
            {
                open: { date: { year: 2026, month: 11, day: 8 }, hour: 9 },
                close: { date: { year: 2026, month: 11, day: 8 }, hour: 18 },
            },
        ],
    },
});
const connection = (changes = {}) => ({
    apiKey: 'test-key',
    signingSecret: secret,
    now: () => new Date(start),
    searchNearby: async (origin, options) =>
        (await searchNearbyCandidates(origin, options)).map((candidate) => ({
            ...candidate,
            accessEvidence: demoAccess(candidate.place.placeId),
        })),
    fetch: async (url) => {
        if (url.includes('/places/demo-destination'))
            return Response.json(rawPlace('demo-destination'));
        if (url.endsWith(':searchNearby'))
            return Response.json({ places: [rawPlace('demo-park')] });
        if (url.endsWith(':computeRoutes'))
            return Response.json({ routes: [{ duration: '600s', distanceMeters: 500 }] });
        if (url.startsWith('https://weather.googleapis.com/'))
            return Response.json({
                timeZone: { id: 'Asia/Tokyo' },
                forecastHours: [
                    {
                        interval: {
                            startTime: '2026-11-08T01:00:00Z',
                            endTime: '2026-11-08T02:00:00Z',
                        },
                        weatherCondition: { type: 'RAIN', description: { text: '雨' } },
                    },
                ],
            });
        assert.fail('unexpected service');
    },
    ...changes,
});
test('returns the public contract with a resolved destination, live data and verifiable token', async () => {
    const result = await getRecommendations(input(), connection());
    assert.equal(result.dataMode, 'live');
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(result.destination.placeId, 'demo-destination');
    assert.equal(result.options.length, 1);
    assert.equal('diagnostics' in result, false);
    const option = result.options[0];
    assert.equal(
        verifyOptionToken(
            {
                ...input(),
                selectedPlaceId: option.place.placeId,
                experienceId: option.experienceId,
                optionToken: option.optionToken,
            },
            secret,
            start,
        ).status,
        'valid',
    );
    assert.equal(result.context.weather.status, 'available');
    assert.match(result.context.weather.summary, /雨/);
    assert.ok(!result.warnings.some(({ code }) => code.startsWith('WEATHER_')));
    assert.ok(
        result.attributions.some((value) => value.providerUri === 'https://jp.weathernews.com/'),
    );
});
test('weather failure preserves signed recommendations and returns a weather warning', async () => {
    const initial = connection();
    let calls = 0;
    const result = await getRecommendations(
        input(),
        connection({
            fetch: async (url, request) => {
                if (!url.startsWith('https://weather.googleapis.com/'))
                    return initial.fetch(url, request);
                calls++;
                return Response.json({ message: 'private provider error' }, { status: 503 });
            },
        }),
    );
    assert.equal(calls, 1);
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(result.options.length, 1);
    assert.equal(result.context.weather.status, 'unavailable');
    assert.ok(result.warnings.some(({ code }) => code === 'WEATHER_UNAVAILABLE'));
    assert.doesNotMatch(JSON.stringify(result), /private provider error/);
});
test('a deadline that passes during destination lookup becomes DIRECT_LATE instead of input error', async () => {
    let clock = start;
    const initial = connection();
    const result = await getRecommendations(
        { ...input(), arriveBy: new Date(start + 1000).toISOString() },
        connection({
            now: () => new Date(clock),
            fetch: async (url, request) => {
                if (url.includes('/places/demo-destination')) clock += 2000;
                assert.ok(!url.endsWith(':searchNearby'));
                assert.ok(!url.startsWith('https://weather.googleapis.com/'));
                return initial.fetch(url, request);
            },
        }),
    );
    assert.equal(result.outcome, 'DIRECT_LATE');
    assert.deepEqual(result.options, []);
});
test('missing signing configuration fails before any paid call', async () => {
    await assert.rejects(
        getRecommendations(
            input(),
            connection({ signingSecret: undefined, fetch: async () => assert.fail('no call') }),
        ),
        (error) => error.code === 'INTERNAL_ERROR',
    );
});
test('the whole operation times out and cancels provider requests', async () => {
    let signal;
    await assert.rejects(
        getRecommendations(
            input(),
            connection({
                workTimeoutMs: 20,
                fetch: async (_url, init) => {
                    signal = init.signal;
                    return new Promise((_resolve, reject) =>
                        signal.addEventListener('abort', () => reject(new Error('aborted')), {
                            once: true,
                        }),
                    );
                },
            }),
        ),
        (error) => error.code === 'TIMEOUT',
    );
    assert.equal(signal.aborted, true);
});

test('Places-only candidates without access evidence remain provisional', async () => {
    const result = await getRecommendations(
        input(),
        connection({ searchNearby: searchNearbyCandidates }),
    );
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(result.options.length, 1);
    assert.ok(result.options[0].warnings.some((w) => w.code === 'UNCONFIRMED_EXTERIOR_ACCESS'));
});
