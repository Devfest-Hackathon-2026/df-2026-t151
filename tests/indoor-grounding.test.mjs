import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGroundedDetours } from '../src/server/grounded-detours.ts';
import { refreshGroundedCandidate } from '../src/server/grounded-candidates.ts';
import { getRecommendations } from '../src/server/recommendations.ts';
import { revalidateItinerary } from '../src/server/itinerary-validation.ts';
import { indoorCandidate, request, at, start } from './helpers/indoor-experience.mjs';

const input = () => ({
    request: request(),
    destination: { ...indoorCandidate().place, placeId: 'demo-destination' },
});
const item = (experienceKind = 'cafe') => ({
    placeId: 'demo-indoor',
    placeName: '架空の施設',
    title: '架空の屋内体験',
    description: '自動テスト専用の架空データ',
    experienceKind,
    publicExteriorWithoutAdmission: false,
    outsideDestination: true,
    indoorConfirmed: true,
    walkInAllowed: true,
    noFixedStart: true,
    smallExhibition: experienceKind === 'small_exhibit',
    admissionRequired: false,
    entryCutoff: 'none',
    lastEntryAt: null,
    accessStatement:
        'この架空施設は目的地の外で、屋内利用・予約不要・随時入店可能、入場料不要、別途受付締切なしの小規模展示もあります',
});
function payload(record = item()) {
    return {
        candidates: [
            {
                finishReason: 'STOP',
                content: { parts: [{ text: JSON.stringify({ candidates: [record] }) }] },
                groundingMetadata: {
                    groundingChunks: [
                        {
                            maps: {
                                placeId: 'places/demo-indoor',
                                title: '架空の施設',
                                uri: 'https://maps.google.com/?cid=demo-indoor',
                            },
                        },
                    ],
                    groundingSupports: [
                        { segment: { text: record.accessStatement }, groundingChunkIndices: [0] },
                    ],
                },
            },
        ],
    };
}
for (const [kind, id] of [
    ['cafe', 'cafe-break-v1'],
    ['light_meal', 'light-meal-v1'],
    ['small_exhibit', 'small-exhibit-v1'],
]) {
    test(`Maps-supported ${kind} produces only its own indoor access evidence`, () => {
        const result = parseGroundedDetours(payload(item(kind)), input(), at(0));
        assert.equal(result.candidates.length, 1);
        assert.equal(result.candidates[0].interiorAccessEvidence.experienceId, id);
        assert.equal(result.candidates[0].accessEvidence, undefined);
        assert.match(result.candidates[0].sources[0].url, /^https:\/\/maps.google.com/);
    });
}
for (const changes of [
    { indoorConfirmed: null },
    { walkInAllowed: null },
    { noFixedStart: false },
    { admissionRequired: null },
    { entryCutoff: null },
    { entryCutoff: 'known', lastEntryAt: null },
    { entryCutoff: 'known', lastEntryAt: '2026-11-08T12:00:00' },
    { experienceKind: 'small_exhibit', smallExhibition: null },
    { experienceKind: 'full_museum' },
    { placeId: 'invented-id' },
])
    test(`unknown indoor conditions remain provisional, confirmed incompatibilities are filtered: ${JSON.stringify(changes)}`, () => {
        const result = parseGroundedDetours(payload({ ...item(), ...changes }), input(), at(0));
        const rejected =
            changes.noFixedStart === false ||
            changes.experienceKind === 'full_museum' ||
            changes.placeId === 'invented-id';
        assert.equal(result.candidates.length, rejected ? 0 : 1);
        if (rejected) assert.ok(result.warnings.some(({ code }) => code === 'AI_EVIDENCE_MISSING'));
    });

const cafeInAnotherBuilding = () => ({
    ...item(),
    outsideDestination: false,
    accessStatement:
        'この架空カフェは別の建物Bの屋内にあり、予約不要・随時入店可能、入場料不要、別途受付締切なしです',
});

test('a grounded indoor venue remains a candidate when the model mislabels destination containment', () => {
    const result = parseGroundedDetours(payload(cafeInAnotherBuilding()), input(), at(0));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].interiorAccessEvidence.outsideDestination, false);
    assert.deepEqual(result.exclusions, []);
});

test('model claims without the matching original Maps support do not become indoor evidence', () => {
    const value = payload();
    value.candidates[0].groundingMetadata.groundingSupports[0].segment.text = '営業時間のみ';
    const candidate = parseGroundedDetours(value, input(), at(0)).candidates[0];
    assert.equal(candidate.interiorAccessEvidence.indoorConfirmed, null);
    assert.equal(candidate.interiorAccessEvidence.walkInAllowed, null);
});
test('selected-only extraction cannot change cafe into a different indoor experience', () => {
    assert.equal(
        parseGroundedDetours(
            payload(item('light_meal')),
            {
                ...input(),
                selectedPlace: indoorCandidate().place,
                selectedExperienceId: 'cafe-break-v1',
            },
            at(0),
        ).candidates.length,
        0,
    );
});
test('failed selected-only refresh clears both indoor and exterior access evidence', async () => {
    const candidate = indoorCandidate();
    const refreshed = await refreshGroundedCandidate(
        candidate,
        { ...input(), selectedExperienceId: 'cafe-break-v1' },
        {
            connection: () => ({
                vertexAuthentication: {
                    projectId: 'demo-vertex-project',
                    location: 'global',
                    getAccessToken: async () => 'test-vertex-token',
                },
            }),
            remainingMs: () => 1000,
            now: () => new Date(start),
            discover: async (query) => {
                assert.equal(query.selectedExperienceId, 'cafe-break-v1');
                assert.equal(query.selectedPlace.placeId, candidate.place.placeId);
                return { candidates: [], warnings: [], attributions: [] };
            },
        },
    );
    assert.equal(refreshed.candidate.interiorAccessEvidence, undefined);
    assert.equal(refreshed.candidate.accessEvidence, undefined);
});

const secret = 'test-only-indoor-signing-secret-32-characters';
function rawPlace(id) {
    return {
        id,
        displayName: { text: '自動テスト用の架空カフェ' },
        location: { latitude: 35.69, longitude: 139.7 },
        types: [id === 'demo-exterior' ? 'tourist_attraction' : 'cafe'],
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
    };
}
test('search and revalidation keep a cafe in another building despite an AI containment flag', async () => {
    let aiCalls = 0,
        weatherCalls = 0,
        selectedRefresh = false;
    const options = {
        apiKey: 'test-maps',
        vertexAuthentication: {
            projectId: 'demo-vertex-project',
            location: 'global',
            getAccessToken: async () => 'test-vertex-token',
        },
        signingSecret: secret,
        now: () => new Date(start),
        fetch: async (url, init) => {
            if (url.includes('aiplatform.googleapis.com')) {
                aiCalls++;
                const body = JSON.parse(init.body);
                const value = payload(cafeInAnotherBuilding());
                if (
                    !body.contents[0].parts[0].text.includes(
                        '"selectedExperienceId":"cafe-break-v1"',
                    )
                ) {
                    const record = {
                        ...item(),
                        placeId: 'demo-exterior',
                        placeName: '架空の外観',
                        title: '建物の装飾を眺める',
                        experienceKind: 'exterior',
                        publicExteriorWithoutAdmission: true,
                        accessStatement:
                            'この架空の建物は目的地の外にあり、公道から入場せず外観を観察できます',
                    };
                    value.candidates[0].content.parts[0].text = JSON.stringify({
                        candidates: [cafeInAnotherBuilding(), record],
                    });
                    value.candidates[0].groundingMetadata.groundingChunks.push({
                        maps: {
                            placeId: 'places/demo-exterior',
                            title: '架空の外観',
                            uri: 'https://maps.google.com/?cid=demo-exterior',
                        },
                    });
                    value.candidates[0].groundingMetadata.groundingSupports.push({
                        segment: { text: record.accessStatement },
                        groundingChunkIndices: [1],
                    });
                }
                if (body.generationConfig.responseSchema) {
                    const context = JSON.parse(body.contents[0].parts[0].text);
                    assert.equal(
                        context.destinationLabel,
                        rawPlace('demo-destination').displayName.text,
                    );
                    if (context.selectedPlaceId) {
                        assert.equal(context.selectedPlaceId, 'demo-indoor');
                        assert.equal(context.selectedExperienceId, 'cafe-break-v1');
                        selectedRefresh = true;
                    }
                    const records = JSON.parse(
                        value.candidates[0].content.parts[0].text,
                    ).candidates.map((record) => ({
                        ...record,
                        accessStatement: record.experienceKind === 'exterior' ? 's1' : 's0',
                    }));
                    value.candidates[0].content.parts[0].text = JSON.stringify({
                        candidates: records,
                    });
                }
                return Response.json(value);
            }
            if (url.includes('/places/demo-destination'))
                return Response.json(rawPlace('demo-destination'));
            if (url.includes('/places/demo-indoor'))
                return Response.json({
                    ...rawPlace('demo-indoor'),
                    containingPlaces: [{ id: 'demo-other-building' }],
                });
            if (url.includes('/places/demo-exterior'))
                return Response.json(rawPlace('demo-exterior'));
            if (url.endsWith(':computeRoutes'))
                return Response.json({ routes: [{ duration: '600s', distanceMeters: 500 }] });
            if (url.startsWith('https://weather.googleapis.com/')) {
                weatherCalls++;
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
            }
            assert.fail('unexpected provider');
        },
    };
    const result = await getRecommendations(request(), options);
    assert.equal(result.outcome, 'OPTIONS');
    assert.equal(result.options[0].experienceId, 'public-exterior-v2');
    const selected = result.options.find((option) => option.experienceId === 'cafe-break-v1');
    assert.equal(selected.experienceId, 'cafe-break-v1');
    assert.equal(selected.time.requiredSeconds, 75 * 60);
    assert.equal(selected.time.isProvisional, true);
    assert.ok(selected.warnings.some(({ code }) => code === 'ESTIMATED_WAIT'));
    assert.ok(selected.warnings.some(({ code }) => code === 'UNCONFIRMED_DESTINATION_RELATION'));
    assert.ok(selected.recommendationReasons.some((reason) => reason.includes('屋内体験')));
    const checked = await revalidateItinerary(
        {
            ...request(),
            selectedPlaceId: selected.place.placeId,
            experienceId: selected.experienceId,
            optionToken: selected.optionToken,
        },
        options,
    );
    assert.equal(checked.status, 'VALID');
    assert.equal(checked.option.experienceId, selected.experienceId);
    assert.equal(checked.option.place.placeId, selected.place.placeId);
    assert.ok(
        checked.option.warnings.some(({ code }) => code === 'UNCONFIRMED_DESTINATION_RELATION'),
    );
    assert.equal(aiCalls, 4);
    assert.equal(weatherCalls, 3);
    assert.equal(selectedRefresh, true);
});
