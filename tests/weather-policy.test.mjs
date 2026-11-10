import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWeather } from '../src/server/weather-policy.ts';

test('outdoor policy distinguishes dry, exposure and conditions to avoid', () => {
    assert.equal(classifyWeather('CLEAR', 0).kind, 'dry');
    for (const type of ['RAIN', 'LIGHT_SNOW', 'WINDY'])
        assert.equal(classifyWeather(type, 0).kind, 'exposed');
    for (const type of ['HEAVY_RAIN', 'THUNDERSTORM', 'HAIL', 'BLOWING_SNOW'])
        assert.equal(classifyWeather(type, 0).kind, 'avoid');
});
test('precipitation threshold is application policy and does not treat missing data as dry', () => {
    assert.equal(classifyWeather('CLEAR', 49).kind, 'dry');
    assert.equal(classifyWeather('CLEAR', 50).kind, 'exposed');
    assert.equal(classifyWeather('NEW_PROVIDER_TYPE', null).kind, 'unknown');
    assert.equal(classifyWeather(null, null).kind, 'unknown');
    assert.equal(classifyWeather('雨', null).kind, 'unknown');
    assert.equal(classifyWeather(null, 101).kind, 'unknown');
});
