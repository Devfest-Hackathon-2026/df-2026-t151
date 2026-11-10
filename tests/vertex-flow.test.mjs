import assert from 'node:assert/strict';
import test from 'node:test';
import { getRecommendations } from '../src/server/recommendations.ts';
import { revalidateItinerary } from '../src/server/itinerary-validation.ts';
const start = Date.parse('2026-11-08T10:00:00+09:00');
const secret = 'test-only-signing-secret-32-characters';
const input = () => ({
    requestId: 'demo-vertex',
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'demo-garden' },
    arriveBy: '2026-11-08T12:00:00+09:00',
    travelMode: 'WALK',
    excludedPlaceIds: [],
});
const raw = (id) => ({
    id,
    displayName: { text: '架空の地点' },
    location: { latitude: 35.69, longitude: 139.7 },
    types: ['tourist_attraction'],
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
const aiResponse = () => {
    const statement = 'この架空の彫刻は庭園外の公道から入場せずに鑑賞できます';
    return {
        candidates: [
            {
                finishReason: 'STOP',
                content: {
                    parts: [
                        {
                            text: JSON.stringify({
                                candidates: [
                                    {
                                        placeId: 'demo-art',
                                        placeName: '架空の彫刻',
                                        title: '街角で彫刻を眺める',
                                        description: '自動テスト専用の架空の体験',
                                        publicExteriorWithoutAdmission: true,
                                        outsideDestination: true,
                                        accessStatement: statement,
                                    },
                                ],
                            }),
                        },
                    ],
                },
                groundingMetadata: {
                    groundingChunks: [
                        {
                            maps: {
                                placeId: 'places/demo-art',
                                title: '架空の彫刻',
                                uri: 'https://maps.google.com/?cid=demo',
                            },
                        },
                    ],
                    groundingSupports: [
                        { segment: { text: statement }, groundingChunkIndices: [0] },
                    ],
                },
            },
        ],
    };
};
const options = (changes = {}) => ({
    apiKey: 'test-maps-key',
    vertexAuthentication: {
        projectId: 'demo-vertex-project',
        location: 'global',
        getAccessToken: async () => 'test-vertex-token',
    },
    signingSecret: secret,
    now: () => new Date(start),
    fetch: async (url, init) => {
        if (url.includes('aiplatform.googleapis.com')) {
            assert.equal(init.headers['Authorization'], 'Bearer test-vertex-token');
            assert.equal(init.headers['X-Goog-Api-Key'], undefined);
            const value = aiResponse();
            if (JSON.parse(init.body).generationConfig.responseSchema) {
                const decoded = JSON.parse(value.candidates[0].content.parts[0].text);
                decoded.candidates[0].accessStatement = 's0';
                value.candidates[0].content.parts[0].text = JSON.stringify(decoded);
            }
            return Response.json(value);
        }
        assert.equal(init.headers['X-Goog-Api-Key'], 'test-maps-key');
        if (url.includes('/places/demo-garden')) return Response.json(raw('demo-garden'));
        if (url.includes('/places/demo-art')) return Response.json(raw('demo-art'));
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
        assert.fail('unexpected provider');
    },
    ...changes,
});
test('Gemini discovery flows through Places and Routes, then selected-only AI revalidation', async () => {
    let aiCalls = 0,
        weatherCalls = 0;
    const original = options();
    const connection = options({
        fetch: async (url, init) => {
            if (url.includes('aiplatform.googleapis.com')) aiCalls++;
            if (url.startsWith('https://weather.googleapis.com/')) weatherCalls++;
            return original.fetch(url, init);
        },
    });
    const result = await getRecommendations(input(), connection);
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(result.options[0].title, '街角で彫刻を眺める');
    assert.ok(
        result.options[0].sources.some((source) => source.provider === 'Google Maps：架空の彫刻'),
    );
    assert.ok(result.options[0].warnings.some((warning) => warning.code === 'AI_MAPS_GROUNDED'));
    assert.ok(result.warnings.some((warning) => warning.code === 'AI_MAPS_GROUNDED'));
    assert.equal(result.context.weather.status, 'available');
    assert.match(result.context.weather.summary, /雨/);
    assert.equal(weatherCalls, 1);
    assert.ok(
        result.attributions.some((value) => value.providerUri === 'https://jp.weathernews.com/'),
    );
    const selected = result.options[0];
    const validated = await revalidateItinerary(
        {
            ...input(),
            requestId: 'demo-revalidate',
            selectedPlaceId: selected.place.placeId,
            experienceId: selected.experienceId,
            optionToken: selected.optionToken,
        },
        connection,
    );
    assert.equal(validated.status, 'VALID');
    assert.equal(validated.option.place.placeId, selected.place.placeId);
    assert.equal(aiCalls, 4);
    assert.equal(weatherCalls, 2);
});
test('even a grounded AI claim cannot override a confirmed destination interior', async () => {
    const original = options();
    const result = await getRecommendations(
        input(),
        options({
            fetch: async (url, init) =>
                url.includes('/places/demo-art')
                    ? Response.json({
                          ...raw('demo-art'),
                          containingPlaces: [{ id: 'demo-garden' }],
                      })
                    : original.fetch(url, init),
        }),
    );
    assert.equal(result.outcome, 'NO_OPTIONS');
    assert.deepEqual(result.options, []);
});
test('missing Gemini configuration fails before any paid call', async () => {
    await assert.rejects(
        getRecommendations(
            input(),
            options({ vertexAuthentication: null, fetch: async () => assert.fail('no call') }),
        ),
        (error) => error.code === 'INTERNAL_ERROR',
    );
});
test('an AI outage stays an upstream error instead of a fabricated or empty recommendation', async () => {
    const original = options();
    await assert.rejects(
        getRecommendations(
            input(),
            options({
                fetch: async (url, init) =>
                    url.includes('aiplatform.googleapis.com')
                        ? Response.json(
                              { error: { message: 'private provider data' } },
                              { status: 503 },
                          )
                        : original.fetch(url, init),
            }),
        ),
        (error) => error.code === 'UPSTREAM_UNAVAILABLE',
    );
});
