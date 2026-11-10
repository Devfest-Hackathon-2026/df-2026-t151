import assert from 'node:assert/strict';
import test from 'node:test';
import { createCandidateExperience } from '../src/server/detour-search/experience.ts';
import { candidateAccessReason } from '../src/server/candidate-access.ts';
import { assessCandidate } from '../src/server/candidate-assessment.ts';
import { findDetourCandidates } from '../src/server/detour-search.ts';
import { revalidateItinerary } from '../src/server/itinerary-validation.ts';
import { issueOptionToken } from '../src/server/option-token.ts';
import { selectForWeather } from '../src/server/weather-selection.ts';
import { classifyWeather } from '../src/server/weather-policy.ts';
import { indoorCandidate, route, request, start, at } from './helpers/indoor-experience.mjs';

const experience = (candidate) =>
    createCandidateExperience(candidate, at(0), [], 'demo-destination');
const assess = (candidate, changes = {}) =>
    assessCandidate({
        candidate,
        experience: experience(candidate),
        calculatedAt: at(0),
        arriveBy: at(120),
        directSeconds: 600,
        legToStop: route(),
        legToDestination: route(),
        bufferSeconds: 600,
        ...changes,
    });
for (const [kind, minutes] of [
    ['cafe', 45],
    ['light_meal', 60],
    ['small_exhibit', 45],
]) {
    test(`sourced ${kind} includes estimated waiting and exit in the full opening/deadline check`, () => {
        const candidate = indoorCandidate(kind);
        const result = assess(candidate, { arriveBy: at(minutes + 30) });
        assert.equal(result.eligible, true);
        assert.equal(result.option.time.requiredSeconds, (minutes + 30) * 60);
        assert.equal(
            result.option.time.experienceStartAt,
            at(10 + (kind === 'light_meal' ? 20 : kind === 'cafe' ? 15 : 10)),
        );
        assert.equal(result.option.time.stopDepartureAt, at(10 + minutes));
        assert.equal(result.option.time.isProvisional, true);
        assert.ok(result.option.warnings.some(({ code }) => code === 'INDOOR_ACCESS_SOURCE'));
        assert.ok(!result.option.warnings.some(({ code }) => code === 'ACCESS_SOURCE'));
        assert.equal(result.option.crowd.status, 'unknown');
        assert.equal(result.option.cost.amount, null);
        assert.equal(
            assess(candidate, {
                arriveBy: new Date(Date.parse(at(minutes + 30)) - 1).toISOString(),
            }).reason,
            'TIME_LIMIT',
        );
        candidate.opening.windows[0].closesAt = at(10 + minutes - 1);
        assert.equal(assess(candidate).reason, 'CLOSED_FOR_VISIT');
    });
}
for (const [field, value, reason] of [
    ['indoorConfirmed', null, 'ACCESS_INDOOR_UNKNOWN'],
    ['walkInAllowed', false, 'ACCESS_RESERVATION_REQUIRED'],
    ['noFixedStart', null, 'ACCESS_RESERVATION_REQUIRED'],
    ['admissionRequired', null, 'ACCESS_ADMISSION_UNKNOWN'],
    ['entryCutoff', null, 'LAST_ENTRY_UNKNOWN'],
    ['outsideDestination', false, 'DESTINATION_INTERIOR'],
    ['outsideDestination', null, 'DESTINATION_RELATION_UNKNOWN'],
    ['destinationPlaceId', 'other', 'ACCESS_CONTEXT_MISMATCH'],
    ['sourceUrl', 'http://example.com', 'ACCESS_UNKNOWN'],
    ['checkedAt', at(-16), 'ACCESS_STALE'],
    ['checkedAt', at(1), 'ACCESS_STALE'],
])
    test(`indoor conditions cannot be inferred: ${field}=${value}`, () => {
        const candidate = indoorCandidate();
        candidate.interiorAccessEvidence[field] = value;
        assert.equal(candidateAccessReason(candidate, 'demo-destination', at(0)), reason);
        if (
            [
                'ACCESS_RESERVATION_REQUIRED',
                'DESTINATION_INTERIOR',
                'ACCESS_CONTEXT_MISMATCH',
            ].includes(reason) &&
            value !== null
        )
            assert.equal(experience(candidate), null);
        else {
            assert.ok(experience(candidate));
            assert.ok(
                assess(candidate).option.warnings.some((w) => w.code.startsWith('UNCONFIRMED_')),
            );
        }
    });
test('a cafe category and opening hours alone cannot establish indoor access', () => {
    const candidate = indoorCandidate();
    candidate.interiorAccessEvidence = undefined;
    assert.equal(experience(candidate), null);
});
test('small exhibitions require scale evidence and a matching facility category', () => {
    const candidate = indoorCandidate('small_exhibit');
    candidate.interiorAccessEvidence.smallExhibition = null;
    assert.ok(
        assess(candidate).option.warnings.some((w) => w.code === 'UNCONFIRMED_EXHIBITION_SIZE'),
    );
    candidate.interiorAccessEvidence.smallExhibition = true;
    candidate.types = ['park'];
    assert.equal(experience(candidate), null);
});
test('paid exhibition checks last entry after estimated waiting and before the full visit', () => {
    const candidate = indoorCandidate('small_exhibit');
    Object.assign(candidate.interiorAccessEvidence, {
        admissionRequired: true,
        entryCutoff: 'known',
        lastEntryAt: at(20),
    });
    assert.equal(assess(candidate).eligible, true);
    candidate.interiorAccessEvidence.lastEntryAt = new Date(Date.parse(at(20)) - 1).toISOString();
    assert.equal(assess(candidate).reason, 'LAST_ENTRY_PASSED');
    candidate.interiorAccessEvidence.lastEntryAt = null;
    assert.ok(assess(candidate).option.warnings.some((w) => w.code === 'UNCONFIRMED_ENTRY_CUTOFF'));
});
test('cafe last-order cutoff also uses the end of the estimated queue', () => {
    const candidate = indoorCandidate();
    Object.assign(candidate.interiorAccessEvidence, { entryCutoff: 'known', lastEntryAt: at(24) });
    assert.equal(assess(candidate).reason, 'LAST_ENTRY_PASSED');
});
test('access evidence must remain valid through checkout and exit', () => {
    const candidate = indoorCandidate();
    candidate.interiorAccessEvidence.validUntil = at(54);
    assert.ok(
        assess(candidate).option.warnings.some((w) => w.code === 'UNCONFIRMED_ACCESS_SOURCE'),
    );
});
test('registered inclusive duration is preferred without adding the estimated queue twice', () => {
    const candidate = indoorCandidate();
    const registered = {
        placeId: candidate.place.placeId,
        experienceId: 'cafe-break-v1',
        validFrom: at(-60),
        validUntil: at(600),
        conditionsMatched: true,
        duration: {
            minSeconds: 2400,
            maxSeconds: 2700,
            sourceType: 'registered',
            sourceUrl: null,
            checkedAt: at(0),
            includesWait: true,
            conditions: '架空の登録値：待ち・会計・退出を含む',
        },
    };
    const exp = createCandidateExperience(candidate, at(0), [registered], 'demo-destination');
    const result = assess(candidate, { experience: exp });
    assert.equal(result.option.experienceDuration.sourceType, 'registered');
    assert.equal(result.option.time.requiredSeconds, 75 * 60);
    assert.equal(result.option.time.waitTreatment, 'included');
    assert.equal(result.option.time.isProvisional, true);
});
test('search excludes destination interiors before spending any detour routes', async () => {
    const candidate = indoorCandidate();
    candidate.relations.parentIds = ['demo-destination'];
    let calls = 0;
    const result = await findDetourCandidates(request(), {
        apiKey: 'test',
        now: () => new Date(start),
        searchNearby: async () => [candidate],
        computeRoute: async () => {
            calls++;
            return route();
        },
    });
    assert.equal(result.outcome, 'NO_OPTIONS');
    assert.equal(calls, 1);
    assert.equal(result.diagnostics.excludedCounts.DESTINATION_INTERIOR, 1);
});
const forecast = (option, condition = 'RAIN') => ({
    placeId: option.place.placeId,
    forecast: {
        weather: { status: 'available', validAt: '2026-11-08T01:00:00.000Z', summary: condition },
        assessment: classifyWeather(condition, null),
        attributions: [],
    },
});
test('rain prefers verified indoor experiences, but dry or partial forecasts preserve time order', () => {
    const indoor = assess(indoorCandidate()).option;
    const outdoor = {
        ...indoor,
        place: { ...indoor.place, placeId: 'demo-outdoor' },
        experienceId: 'public-exterior-v2',
        time: { ...indoor.time, experienceSeconds: 60, waitSeconds: 0 },
    };
    const options = [outdoor, indoor];
    assert.equal(
        selectForWeather(
            options,
            options.map((x) => forecast(x)),
        ).options[0].experienceId,
        'cafe-break-v1',
    );
    assert.equal(
        selectForWeather(
            options,
            options.map((x) => forecast(x, 'CLEAR')),
        ).options[0].experienceId,
        'public-exterior-v2',
    );
    assert.equal(
        selectForWeather(options, [forecast(indoor)]).options[0].experienceId,
        'public-exterior-v2',
    );
    assert.equal(selectForWeather([indoor], [forecast(indoor, 'THUNDERSTORM')]).options.length, 0);
});
const secret = 'test-only-indoor-signing-secret-32-characters';
test('inclusive indoor durations retain the outdoor queue allowance when comparing rainy options', () => {
    const cafe = assess(indoorCandidate()).option;
    const exhibit = assess(indoorCandidate('small_exhibit')).option;
    const included = { ...cafe, time: { ...cafe.time, waitTreatment: 'included', waitSeconds: 0 } };
    exhibit.place = { ...exhibit.place, placeId: 'demo-exhibit' };
    const options = [included, exhibit];
    assert.equal(
        selectForWeather(
            options,
            options.map((value) => forecast(value)),
        ).options[0].experienceId,
        'small-exhibit-v1',
    );
});
function validationInput() {
    return {
        ...request(),
        selectedPlaceId: 'demo-indoor',
        experienceId: 'cafe-break-v1',
        optionToken: issueOptionToken(
            request(),
            { placeId: 'demo-indoor', experienceId: 'cafe-break-v1' },
            secret,
            start,
        ).optionToken,
    };
}
const validationOptions = (changes = {}) => ({
    apiKey: 'test',
    signingSecret: secret,
    now: () => new Date(start),
    getCandidate: async () => indoorCandidate(),
    getDestination: async () => ({
        place: { ...indoorCandidate().place, placeId: 'demo-destination' },
        relations: { parentIds: [], childIds: [] },
        attributions: [],
    }),
    computeRoute: async () => route(),
    fetch: async () => Response.json({}, { status: 503 }),
    ...changes,
});
test('recalculation uses the new origin and current time, keeping the same indoor experience', async () => {
    const input = { ...validationInput(), origin: { latitude: 35.7, longitude: 139.71 } };
    const origins = [];
    const result = await revalidateItinerary(
        input,
        validationOptions({
            now: () => new Date(start + 60000),
            computeRoute: async (query) => {
                origins.push(query.origin);
                return route();
            },
        }),
    );
    assert.equal(result.status, 'VALID');
    assert.equal(result.calculatedAt, at(1));
    assert.equal(result.option.time.stopArrivalAt, at(11));
    assert.equal(result.option.time.stopDepartureAt, at(56));
    assert.equal(result.option.experienceId, input.experienceId);
    assert.deepEqual(origins[1], input.origin);
});
test('a different indoor kind cannot replace the token-bound selected experience', async () => {
    let routeCalls = 0;
    const result = await revalidateItinerary(
        validationInput(),
        validationOptions({
            getCandidate: async () => indoorCandidate('light_meal'),
            computeRoute: async () => {
                routeCalls++;
                return route();
            },
        }),
    );
    assert.equal(result.status, 'NO_LONGER_FEASIBLE');
    assert.equal(routeCalls, 0);
});
test('recalculation rejects a once exact-fit indoor visit after one millisecond has elapsed', async () => {
    const input = { ...validationInput(), arriveBy: at(75) };
    input.optionToken = issueOptionToken(
        input,
        { placeId: input.selectedPlaceId, experienceId: input.experienceId },
        secret,
        start,
    ).optionToken;
    const result = await revalidateItinerary(
        input,
        validationOptions({ now: () => new Date(start + 1) }),
    );
    assert.equal(result.status, 'NO_LONGER_FEASIBLE');
    assert.ok(result.warnings.some(({ code }) => code === 'TIME_LIMIT'));
});
test('queue allowance moves the selected visit forecast to the correct hour', async () => {
    const input = { ...validationInput(), arriveBy: at(180) };
    input.optionToken = issueOptionToken(
        input,
        { placeId: input.selectedPlaceId, experienceId: input.experienceId },
        secret,
        start,
    ).optionToken;
    let weatherRequested = false;
    const result = await revalidateItinerary(
        input,
        validationOptions({
            computeRoute: async () => route(50 * 60),
            fetch: async (url) => {
                assert.ok(url.startsWith('https://weather.googleapis.com/'));
                weatherRequested = true;
                return Response.json({
                    timeZone: { id: 'Asia/Tokyo' },
                    forecastHours: [
                        {
                            interval: {
                                startTime: '2026-11-08T02:00:00Z',
                                endTime: '2026-11-08T03:00:00Z',
                            },
                            weatherCondition: {
                                type: 'THUNDERSTORM',
                                description: { text: '雷雨' },
                            },
                        },
                    ],
                });
            },
        }),
    );
    assert.equal(weatherRequested, true);
    assert.equal(result.status, 'NO_LONGER_FEASIBLE');
    assert.ok(result.warnings.some(({ code }) => code === 'WEATHER_UNSUITABLE'));
});
