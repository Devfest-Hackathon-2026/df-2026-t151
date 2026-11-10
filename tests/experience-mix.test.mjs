import assert from 'node:assert/strict';
import test from 'node:test';
import { selectExperienceMix } from '../src/server/experience-mix.ts';
import { findDetourCandidates } from '../src/server/detour-search.ts';
import { RouteNotFoundError } from '../src/server/routes.ts';
import { classifyWeather } from '../src/server/weather-policy.ts';
import { demoAccess } from './helpers/exterior-access.mjs';
import { indoorCandidate, route, request, start, at } from './helpers/indoor-experience.mjs';

const option = (id, experienceId) => ({ place: { placeId: id }, experienceId });
const exterior = (id) => option(id, 'public-exterior-v2');
test('reserves an exterior ahead of better-ranked indoor experiences and caps the total at three', () => {
    const ranked = [
        option('c1', 'cafe-break-v1'),
        option('m1', 'light-meal-v1'),
        option('g1', 'small-exhibit-v1'),
        exterior('e1'),
    ];
    const before = structuredClone(ranked);
    assert.deepEqual(
        selectExperienceMix(ranked).map(({ place }) => place.placeId),
        ['e1', 'c1', 'm1'],
    );
    assert.deepEqual(ranked, before);
});
test('additional types get a slot even if three exteriors had a higher original rank', () => {
    const ranked = [exterior('e1'), exterior('e2'), exterior('e3'), option('c1', 'cafe-break-v1')];
    assert.deepEqual(
        selectExperienceMix(ranked).map(({ place }) => place.placeId),
        ['e1', 'c1', 'e2'],
    );
});
test('returns only verified available exteriors when other experiences are absent', () => {
    assert.deepEqual(selectExperienceMix([exterior('e1')]), [exterior('e1')]);
    assert.deepEqual(
        selectExperienceMix(['e1', 'e2', 'e3', 'e4'].map(exterior)).map(
            ({ place }) => place.placeId,
        ),
        ['e1', 'e2', 'e3'],
    );
});
test('an empty or indoor-only result cannot satisfy the mandatory exterior slot', () => {
    assert.deepEqual(selectExperienceMix([]), []);
    assert.deepEqual(selectExperienceMix([option('c1', 'cafe-break-v1')]), []);
});

function candidate(id, kind = 'cafe') {
    const value = indoorCandidate(kind === 'exterior' ? 'cafe' : kind);
    value.place.placeId = id;
    if (kind === 'exterior') {
        value.types = ['tourist_attraction'];
        value.interiorAccessEvidence = undefined;
        value.accessEvidence = demoAccess(id);
    } else value.interiorAccessEvidence.placeId = id;
    return value;
}
const options = (candidates, overrides = {}) => ({
    apiKey: 'test',
    now: () => new Date(start),
    searchNearby: async () => candidates,
    computeRoute: async () => route(),
    ...overrides,
});
function forecast(option, type, summary = type) {
    return {
        placeId: option.place.placeId,
        forecast: {
            weather: {
                status: 'available',
                provider: 'Google Weather API',
                retrievedAt: at(0),
                validAt: new Date(
                    Math.floor(Date.parse(option.time.experienceStartAt) / 3600000) * 3600000,
                ).toISOString(),
                summary,
                sourceUrl: null,
            },
            assessment: classifyWeather(type, null),
            attributions: ['Google Weather'],
        },
    };
}
test('an exterior sixth in discovery is still routed within the existing four-candidate cap', async () => {
    let routes = 0;
    const values = [
        ...['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => candidate(id)),
        candidate('e1', 'exterior'),
    ];
    const result = await findDetourCandidates(
        request(),
        options(values, {
            computeRoute: async () => {
                routes++;
                return route();
            },
        }),
    );
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(result.options.length, 3);
    assert.equal(result.options[0].experienceId, 'public-exterior-v2');
    assert.equal(result.diagnostics.evaluatedCount, 4);
    assert.equal(routes, 9);
});
test('a second exterior remains available when the first has no walking route', async () => {
    const values = [
        candidate('c1'),
        candidate('m1', 'light_meal'),
        candidate('g1', 'small_exhibit'),
        candidate('e1', 'exterior'),
        candidate('e2', 'exterior'),
    ];
    const result = await findDetourCandidates(
        request(),
        options(values, {
            computeRoute: async (query) => {
                if (query.destination.placeId === 'e1') throw new RouteNotFoundError();
                return route();
            },
        }),
    );
    assert.equal(result.options[0].place.placeId, 'e2');
    assert.equal(result.options.length, 3);
    assert.equal(result.diagnostics.evaluatedCount, 4);
});
test('indoor-only eligibility reports why no recommendation is returned', async () => {
    const result = await findDetourCandidates(request(), options([candidate('c1')]));
    assert.equal(result.outcome, 'NO_OPTIONS');
    assert.equal(result.options.length, 0);
    assert.ok(result.warnings.some(({ code }) => code === 'EXTERIOR_REQUIRED'));
});
test('a deadline failure cannot be overridden to fill the exterior slot', async () => {
    const result = await findDetourCandidates(
        { ...request(), arriveBy: at(80) },
        options([candidate('c1'), candidate('e1', 'exterior')], {
            computeRoute: async (query) => route(query.destination.placeId === 'e1' ? 3600 : 600),
        }),
    );
    assert.equal(result.outcome, 'NO_OPTIONS');
    assert.equal(result.diagnostics.excludedCounts.TIME_LIMIT, 1);
    assert.ok(result.warnings.some(({ code }) => code === 'EXTERIOR_REQUIRED'));
});
test('severe weather removes the exterior even when an indoor visit has clear weather', async () => {
    const result = await findDetourCandidates(
        request(),
        options([candidate('e1', 'exterior'), candidate('c1')], {
            loadWeather: async (values) =>
                values.map((value) =>
                    forecast(
                        value,
                        value.experienceId === 'public-exterior-v2' ? 'THUNDERSTORM' : 'CLEAR',
                    ),
                ),
        }),
    );
    assert.equal(result.outcome, 'NO_OPTIONS');
    assert.equal(result.options.length, 0);
    assert.ok(result.warnings.some(({ code }) => code === 'WEATHER_UNSUITABLE'));
    assert.ok(result.warnings.some(({ code }) => code === 'EXTERIOR_REQUIRED'));
});
test('the summary forecast belongs to the exterior moved to the first position', async () => {
    const result = await findDetourCandidates(
        request(),
        options([candidate('c1'), candidate('e1', 'exterior')], {
            loadWeather: async (values) =>
                values.map((value) =>
                    forecast(
                        value,
                        'RAIN',
                        value.experienceId === 'public-exterior-v2'
                            ? '外観地点の雨'
                            : '飲食地点の雨',
                    ),
                ),
        }),
    );
    assert.equal(result.options[0].experienceId, 'public-exterior-v2');
    assert.equal(result.context.weather.summary, '外観地点の雨');
});
