import test from 'node:test';
import assert from 'node:assert/strict';
import { selectForWeather } from '../src/server/weather-selection.ts';
import { classifyWeather } from '../src/server/weather-policy.ts';

const at = '2026-11-09T03:10:00.000Z';
const option = (id, seconds) => ({
    place: { placeId: id },
    recommendationReasons: [],
    sources: [],
    time: {
        experienceStartAt: at,
        legToStopSeconds: 60,
        legToDestinationSeconds: 60,
        experienceSeconds: seconds,
    },
});
const forecast = (id, type, percent = null) => ({
    placeId: id,
    forecast: {
        weather: {
            status: 'available',
            validAt: '2026-11-09T03:00:00.000Z',
            summary: type,
            provider: 'Google Weather API',
        },
        assessment: classifyWeather(type, percent),
        attributions: ['Google Weather'],
    },
});

test('rain favors less outdoor time while dry weather preserves the original time ranking', () => {
    const options = [option('long', 900), option('short', 300)];
    assert.deepEqual(
        selectForWeather(options, [
            forecast('long', 'RAIN'),
            forecast('short', 'RAIN'),
        ]).options.map((x) => x.place.placeId),
        ['short', 'long'],
    );
    assert.deepEqual(
        selectForWeather(options, [
            forecast('long', 'CLEAR'),
            forecast('short', 'CLEAR'),
        ]).options.map((x) => x.place.placeId),
        ['long', 'short'],
    );
    assert.deepEqual(
        options.map((x) => x.place.placeId),
        ['long', 'short'],
    );
});
test('prefers a dry visit hour over a wet one and does not compare an unavailable forecast as dry', () => {
    const options = [option('wet', 100), option('dry', 900)];
    const result = selectForWeather(options, [forecast('wet', 'RAIN'), forecast('dry', 'CLEAR')]);
    assert.equal(result.options[0].place.placeId, 'dry');
    assert.equal(result.weather.summary, 'CLEAR');
    const partial = selectForWeather(options, [forecast('wet', 'RAIN')]);
    assert.deepEqual(
        partial.options.map((x) => x.place.placeId),
        ['wet', 'dry'],
    );
    assert.ok(partial.warnings.some((x) => x.code === 'WEATHER_COMPARISON_UNKNOWN'));
});
test('severe weather excludes outdoor experiences and can leave no options', () => {
    const result = selectForWeather([option('storm', 300)], [forecast('storm', 'THUNDERSTORM')]);
    assert.deepEqual(result.options, []);
    assert.equal(result.excludedCount, 1);
    assert.ok(result.warnings.some((x) => x.code === 'WEATHER_UNSUITABLE'));
    assert.deepEqual(result.attributions, ['Google Weather']);
});
test('hour rollover discards the earlier forecast instead of applying its severe conditions', () => {
    const value = option('next-hour', 300);
    value.time.experienceStartAt = '2026-11-09T04:00:00.000Z';
    const result = selectForWeather([value], [forecast('next-hour', 'THUNDERSTORM')]);
    assert.equal(result.options.length, 1);
    assert.equal(result.weather, null);
    assert.ok(result.warnings.some((x) => x.code === 'WEATHER_UNKNOWN'));
});
