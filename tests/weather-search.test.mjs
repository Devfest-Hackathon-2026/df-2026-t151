import test from 'node:test';
import assert from 'node:assert/strict';
import { findDetourCandidates } from '../src/server/detour-search.ts';
import { loadVisitForecasts } from '../src/server/visit-forecasts.ts';
import { classifyWeather } from '../src/server/weather-policy.ts';
import { demoAccess } from './helpers/exterior-access.mjs';

const start = Date.parse('2026-11-08T10:00:00+09:00');
const at = (ms) => new Date(ms).toISOString();
const request = () => ({
    requestId: 'weather-search',
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'demo-destination' },
    arriveBy: at(start + 90 * 60000),
    travelMode: 'WALK',
    excludedPlaceIds: [],
});
const candidate = (id) => ({
    place: { placeId: id, label: '架空の公園', latitude: 35.69, longitude: 139.7 },
    types: ['park'],
    businessStatus: 'OPERATIONAL',
    retrievedAt: at(start),
    sourceUrl: null,
    attributions: ['Google Maps'],
    accessEvidence: demoAccess(id),
    opening: {
        status: 'known',
        coverageStart: at(start - 86400000),
        coverageEnd: at(start + 86400000),
        windows: [{ opensAt: at(start - 3600000), closesAt: at(start + 7200000) }],
    },
});
const route = () => ({
    travelMode: 'WALK',
    durationSeconds: 600,
    distanceMeters: 500,
    provider: 'Google Routes',
    warnings: [],
    attributions: ['Google Maps'],
});
const forecast = (option, type) => ({
    placeId: option.place.placeId,
    forecast: {
        weather: {
            status: 'available',
            provider: 'Google Weather API',
            retrievedAt: at(start),
            validAt: at(Math.floor(Date.parse(option.time.experienceStartAt) / 3600000) * 3600000),
            summary: type,
            sourceUrl: null,
        },
        assessment: classifyWeather(type, null),
        attributions: ['Google Weather'],
    },
});

test('weather is applied before truncation so a fourth eligible option survives three storm exclusions', async () => {
    let count = 0;
    const result = await findDetourCandidates(request(), {
        apiKey: 'test-key',
        now: () => new Date(start),
        searchNearby: async () => ['a', 'b', 'c', 'd'].map(candidate),
        computeRoute: async () => route(),
        loadWeather: async (options) => {
            count = options.length;
            return options.map((option) =>
                forecast(option, option.place.placeId === 'd' ? 'CLEAR' : 'THUNDERSTORM'),
            );
        },
    });
    assert.equal(count, 4);
    assert.equal(result.outcome, 'OPTIONS');
    assert.deepEqual(
        result.options.map((option) => option.place.placeId),
        ['d'],
    );
    assert.equal(result.context.weather.summary, 'CLEAR');
    assert.equal(result.diagnostics.excludedCounts.WEATHER_UNSUITABLE, 3);
});
test('forecast latency removes an option that fit the deadline before the optional lookup', async () => {
    let clock = start;
    const result = await findDetourCandidates(
        { ...request(), arriveBy: at(start + 50 * 60000) },
        {
            apiKey: 'test-key',
            now: () => new Date(clock),
            searchNearby: async () => [candidate('a')],
            computeRoute: async () => route(),
            loadWeather: async (options) => {
                clock++;
                return options.map((option) => forecast(option, 'CLEAR'));
            },
        },
    );
    assert.equal(result.outcome, 'NO_OPTIONS');
    assert.equal(result.calculatedAt, at(clock));
});
test('clock crossing the visit hour ignores the now mismatched storm forecast', async () => {
    let clock = start + 49 * 60000 + 59000;
    const result = await findDetourCandidates(
        { ...request(), arriveBy: at(clock + 90 * 60000) },
        {
            apiKey: 'test-key',
            now: () => new Date(clock),
            searchNearby: async () => [
                {
                    ...candidate('a'),
                    retrievedAt: at(clock),
                    accessEvidence: { ...demoAccess('a'), checkedAt: at(clock) },
                },
            ],
            computeRoute: async () => route(),
            loadWeather: async (options) => {
                const old = options.map((option) => forecast(option, 'THUNDERSTORM'));
                clock += 2000;
                return old;
            },
        },
    );
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(result.context.weather.status, 'unknown');
    assert.ok(result.warnings.some((warning) => warning.code === 'WEATHER_UNKNOWN'));
});

const visits = () =>
    Array.from({ length: 6 }, (_, index) => ({
        place: candidate(`demo-${index}`).place,
        visitAt: at(start + 600000),
    }));
test('forecast collection caps paid lookups at four and concurrent calls at two', async () => {
    let active = 0,
        maximum = 0,
        calls = 0;
    const results = await loadVisitForecasts(visits(), {
        remainingMs: () => 5000,
        now: () => new Date(start),
        connection: () => ({
            apiKey: 'test-key',
            fetch: async () => {
                calls++;
                active++;
                maximum = Math.max(maximum, active);
                await new Promise((resolve) => setTimeout(resolve, 2));
                active--;
                return Response.json({
                    timeZone: { id: 'Asia/Tokyo' },
                    forecastHours: [
                        {
                            interval: { startTime: at(start), endTime: at(start + 3600000) },
                            weatherCondition: { type: 'CLEAR', description: { text: '晴れ' } },
                        },
                    ],
                });
            },
        }),
    });
    assert.equal(calls, 4);
    assert.equal(maximum, 2);
    assert.equal(results.length, 4);
});
test('optional forecast work preserves response time and labels timed out requests unavailable', async () => {
    let calls = 0;
    const signals = [];
    const connection = () => ({
        apiKey: 'test-key',
        fetch: async (_url, init) => {
            calls++;
            signals.push(init.signal);
            return new Promise(() => {});
        },
    });
    assert.deepEqual(
        await loadVisitForecasts(visits(), {
            remainingMs: () => 500,
            now: () => new Date(start),
            connection,
        }),
        [],
    );
    assert.equal(calls, 0);
    const result = await loadVisitForecasts(visits(), {
        remainingMs: () => 530,
        now: () => new Date(start),
        connection,
    });
    assert.equal(calls, 2);
    assert.equal(result.length, 2);
    assert.ok(result.every((item) => item.forecast.weather.status === 'unavailable'));
    assert.ok(signals.every((signal) => signal.aborted));
});
