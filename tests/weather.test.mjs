import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisitWeather } from '../src/server/weather.ts';

const place = { placeId: 'demo-stop', label: '架空の寄り道先', latitude: 35.69, longitude: 139.7 };
const now = () => new Date('2026-11-08T10:40:00+09:00');
const visitAt = '2026-11-08T11:15:00+09:00';
const options = { now, apiKey: 'test-only-key' };
const hour = (startTime, endTime, text, percent) => ({
    interval: { startTime, endTime },
    weatherCondition: { description: { text } },
    precipitation: { probability: { percent } },
});
const clear = hour('2026-11-08T01:00:00Z', '2026-11-08T02:00:00Z', '晴れ', 0);
const rain = hour('2026-11-08T02:00:00Z', '2026-11-08T03:00:00Z', '雨', 70);
const forecast = (...forecastHours) =>
    Response.json({ timeZone: { id: 'Asia/Tokyo' }, forecastHours });

test('requests one bounded page and uses the visit hour instead of the current hour', async () => {
    let calls = 0;
    const result = await getVisitWeather(place, visitAt, {
        ...options,
        fetch: async (url, init) => {
            calls++;
            const target = new URL(url);
            assert.equal(target.origin, 'https://weather.googleapis.com');
            assert.equal(target.pathname, '/v1/forecast/hours:lookup');
            assert.equal(target.searchParams.get('hours'), '2');
            assert.equal(target.searchParams.get('pageSize'), '2');
            assert.equal(target.searchParams.get('languageCode'), 'ja');
            assert.equal(target.searchParams.get('location.latitude'), '35.69');
            assert.equal(target.searchParams.get('location.longitude'), '139.7');
            assert.equal(target.searchParams.has('key'), false);
            assert.equal(init.headers['X-Goog-Api-Key'], 'test-only-key');
            assert.equal(init.method, 'GET');
            assert.equal(init.cache, 'no-store');
            return forecast(clear, rain);
        },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.weather, {
        status: 'available',
        provider: 'Google Weather API',
        retrievedAt: '2026-11-08T01:40:00.000Z',
        validAt: '2026-11-08T02:00:00.000Z',
        summary: '架空の寄り道先の訪問時間帯の予報　雨・降水確率70%',
        sourceUrl: null,
    });
    assert.equal(result.attributions[1].providerUri, 'https://jp.weathernews.com/');
});

test('does not substitute another hour and leaves missing precipitation out of the summary', async () => {
    const atBoundary = '2026-11-08T11:00:00+09:00';
    const missing = await getVisitWeather(place, atBoundary, {
        ...options,
        fetch: async () => forecast(clear),
    });
    assert.equal(missing.weather.status, 'unknown');
    assert.equal(missing.weather.validAt, null);
    assert.deepEqual(missing.attributions, []);
    const noProbability = await getVisitWeather(place, atBoundary, {
        ...options,
        fetch: async () => forecast({ ...rain, precipitation: undefined }),
    });
    assert.equal(noProbability.weather.status, 'available');
    assert.doesNotMatch(noProbability.weather.summary, /降水確率/);
});

test('skips out-of-range or invalid inputs before spending a provider call', async () => {
    let calls = 0;
    const unused = {
        ...options,
        fetch: async () => {
            calls++;
            return forecast(clear);
        },
    };
    for (const at of ['2026-11-08T09:59:59+09:00', '2026-11-09T10:00:00+09:00', 'invalid']) {
        assert.equal((await getVisitWeather(place, at, unused)).weather.status, 'unknown');
    }
    assert.equal(
        (await getVisitWeather({ ...place, latitude: 91 }, visitAt, unused)).weather.status,
        'unknown',
    );
    assert.equal(calls, 0);
});

test('does not use data for an unsupported time zone or an invalid condition', async () => {
    const outsideJapan = await getVisitWeather(place, visitAt, {
        ...options,
        fetch: async () => Response.json({ timeZone: { id: 'Asia/Seoul' }, forecastHours: [rain] }),
    });
    assert.equal(outsideJapan.weather.status, 'unknown');
    assert.deepEqual(outsideJapan.attributions, []);
    const malformed = await getVisitWeather(place, visitAt, {
        ...options,
        fetch: async () =>
            forecast({ ...rain, weatherCondition: { description: { text: '\ninvalid' } } }),
    });
    assert.equal(malformed.weather.status, 'unknown');
});

test('provider failures, malformed responses and timeouts are unavailable without exposing raw data', async () => {
    for (const fetch of [
        async () => Response.json({ error: 'private provider details' }, { status: 403 }),
        async () => Response.json({ forecastHours: 'private provider details' }),
    ]) {
        const result = await getVisitWeather(place, visitAt, { ...options, fetch });
        assert.equal(result.weather.status, 'unavailable');
        assert.doesNotMatch(JSON.stringify(result), /private provider details/);
    }
    let signal;
    const timedOut = await getVisitWeather(place, visitAt, {
        ...options,
        workTimeoutMs: 20,
        fetch: async (_url, init) => {
            signal = init.signal;
            return new Promise(() => {});
        },
    });
    assert.equal(timedOut.weather.status, 'unavailable');
    assert.equal(signal.aborted, true);
});
