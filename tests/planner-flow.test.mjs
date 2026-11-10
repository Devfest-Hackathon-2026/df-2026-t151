import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createPlannerPostHandler,
    createPlannerLimiter,
} from '../src/server/planner-post-handler.ts';
import { getRecommendations } from '../src/server/recommendations.ts';
import { revalidateItinerary } from '../src/server/itinerary-validation.ts';
import {
    validateRecommendationsRequest,
    validateItineraryRequest,
} from '../src/server/request-validation.ts';
import { searchNearbyCandidates } from '../src/server/nearby-candidates.ts';
import { getCandidateDetails } from '../src/server/place-details.ts';
import { demoAccess } from './helpers/exterior-access.mjs';

test('HTTP search and revalidation preserve the contract through refreshed provider responses', async () => {
    const start = Date.parse('2026-11-08T10:00:00+09:00');
    let clock = start,
        closed = false,
        outage = false;
    const urls = [];
    const place = (id) => ({
        id,
        displayName: { text: '自動テスト用の架空地点' },
        location: { latitude: 35.69, longitude: 139.7 },
        types: ['park'],
        businessStatus: closed ? 'CLOSED_TEMPORARILY' : 'OPERATIONAL',
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
    const provider = async (url) => {
        urls.push(url);
        if (outage)
            return Response.json({ error: { message: 'private raw error' } }, { status: 503 });
        if (url.includes('/places/demo-destination'))
            return Response.json(place('demo-destination'));
        if (url.includes('/places/demo-park')) return Response.json(place('demo-park'));
        if (url.endsWith(':searchNearby')) return Response.json({ places: [place('demo-park')] });
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
    };
    const common = {
        now: () => clock,
        limiter: createPlannerLimiter(() => clock),
        getApiKey: () => 'test-key',
        getSigningSecret: () => 'test-only-signing-secret-32-characters',
    };
    const search = createPlannerPostHandler({
        ...common,
        validate: validateRecommendationsRequest,
        execute: (input, options) =>
            getRecommendations(input, {
                ...options,
                fetch: provider,
                searchNearby: async (origin, connection) =>
                    (await searchNearbyCandidates(origin, connection)).map((candidate) => ({
                        ...candidate,
                        accessEvidence: demoAccess(candidate.place.placeId),
                    })),
            }),
    });
    const validate = createPlannerPostHandler({
        ...common,
        validate: validateItineraryRequest,
        execute: (input, options) =>
            revalidateItinerary(input, {
                ...options,
                fetch: provider,
                getCandidate: async (id, connection) => ({
                    ...(await getCandidateDetails(id, connection)),
                    accessEvidence: demoAccess(id),
                }),
            }),
    });
    const post = (value) =>
        new Request('https://example.com/api/v1/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value),
        });
    const input = {
        requestId: 'search',
        origin: { latitude: 35.69, longitude: 139.7 },
        destination: { placeId: 'demo-destination' },
        arriveBy: new Date(start + 90 * 60000).toISOString(),
        travelMode: 'WALK',
        excludedPlaceIds: [],
    };
    const searchResponse = await search(post(input));
    assert.equal(searchResponse.status, 200);
    const result = await searchResponse.json();
    assert.equal(result.dataMode, 'live');
    assert.equal(result.options.length, 1);
    assert.equal(result.context.weather.status, 'available');
    assert.equal(urls.filter((url) => url.startsWith('https://weather.googleapis.com/')).length, 1);
    const option = result.options[0];
    const selected = {
        ...input,
        requestId: 'validate',
        selectedPlaceId: option.place.placeId,
        experienceId: option.experienceId,
        optionToken: option.optionToken,
    };
    let before = urls.length;
    const validResponse = await validate(post(selected));
    const valid = await validResponse.json();
    assert.equal(validResponse.status, 200);
    assert.match(validResponse.headers.get('Cache-Control'), /no-store/);
    assert.equal(valid.status, 'VALID');
    assert.equal(valid.requestId, 'validate');
    assert.equal(valid.option.place.placeId, selected.selectedPlaceId);
    assert.equal(urls.length - before, 6);
    assert.equal(
        urls.slice(before).filter((url) => url.startsWith('https://weather.googleapis.com/'))
            .length,
        1,
    );
    assert.ok(!urls.slice(before).some((url) => url.endsWith(':searchNearby')));
    before = urls.length;
    assert.equal((await validate(post({ ...selected, optionToken: 'forged' }))).status, 400);
    assert.equal(urls.length, before);
    closed = true;
    const unavailable = await validate(post(selected));
    assert.equal(unavailable.status, 200);
    assert.equal((await unavailable.json()).status, 'NO_LONGER_FEASIBLE');
    closed = false;
    outage = true;
    const failed = await validate(post(selected));
    assert.equal(failed.status, 502);
    assert.ok(!JSON.stringify(await failed.json()).includes('private raw'));
    outage = false;
    clock += 5 * 60000;
    before = urls.length;
    const expired = await validate(post(selected));
    assert.equal(expired.status, 200);
    assert.equal((await expired.json()).status, 'EXPIRED');
    assert.equal(urls.length, before);
});
