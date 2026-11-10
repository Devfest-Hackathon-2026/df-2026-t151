import assert from 'node:assert/strict';
import test from 'node:test';
import { findDetourCandidates } from '../src/server/detour-search.ts';
import { loadGroundedCandidates } from '../src/server/grounded-candidates.ts';
import { revalidateItinerary } from '../src/server/itinerary-validation.ts';
import { issueOptionToken } from '../src/server/option-token.ts';
import { printCandidateExclusions } from '../src/lib/client/candidate-diagnostics.ts';
import { indoorCandidate, route, request, start, at } from './helpers/indoor-experience.mjs';
import { demoAccess } from './helpers/exterior-access.mjs';

const exterior = () => ({
    ...indoorCandidate(),
    place: { ...indoorCandidate().place, placeId: 'demo-exterior', label: '架空の外観' },
    types: ['park'],
    interiorAccessEvidence: undefined,
    accessEvidence: demoAccess('demo-exterior'),
});
const unknownCafe = () => {
    const candidate = indoorCandidate();
    candidate.businessStatus = null;
    candidate.opening = { status: 'unknown' };
    Object.assign(candidate.interiorAccessEvidence, {
        outsideDestination: null,
        indoorConfirmed: null,
        walkInAllowed: null,
        noFixedStart: null,
        admissionRequired: null,
        entryCutoff: null,
    });
    return candidate;
};
const search = (candidates) =>
    findDetourCandidates(request(), {
        now: () => new Date(start),
        searchNearby: async () => candidates,
        computeRoute: async () => route(),
    });

test('unknown opening, business and indoor conditions survive search and selected itinerary revalidation', async () => {
    const cafe = unknownCafe();
    const result = await search([exterior(), cafe]);
    assert.equal(result.options.length, 2);
    assert.deepEqual(result.diagnostics.exclusions, []);
    const selected = result.options.find((option) => option.experienceId === 'cafe-break-v1');
    assert.equal(selected.opening.status, 'unknown');
    assert.equal(selected.time.isProvisional, true);
    for (const code of [
        'UNCONFIRMED_BUSINESS_STATUS',
        'UNCONFIRMED_DESTINATION_RELATION',
        'UNCONFIRMED_OPENING',
        'UNCONFIRMED_INDOOR',
        'UNCONFIRMED_RESERVATION',
        'UNCONFIRMED_ENTRY_CUTOFF',
    ])
        assert.ok(selected.warnings.some((w) => w.code === code));
    assert.ok(!selected.recommendationReasons.some((reason) => reason.includes('営業時間内に')));
    const secret = 'test-only-provisional-plan-secret';
    const signed = issueOptionToken(
        request(),
        { placeId: selected.place.placeId, experienceId: selected.experienceId },
        secret,
        start,
    );
    const checked = await revalidateItinerary(
        {
            ...request(),
            selectedPlaceId: selected.place.placeId,
            experienceId: selected.experienceId,
            optionToken: signed.optionToken,
        },
        {
            signingSecret: secret,
            now: () => new Date(start),
            vertexAuthentication: null,
            getCandidate: async () => cafe,
            getDestination: async () => ({
                place: { ...cafe.place, placeId: 'demo-destination' },
                relations: { parentIds: [], childIds: [] },
                attributions: [],
            }),
            computeRoute: async () => route(),
            fetch: async () => Response.json({}, { status: 503 }),
        },
    );
    assert.equal(checked.status, 'VALID');
    assert.equal(checked.option.experienceId, 'cafe-break-v1');
    assert.equal(checked.option.opening.status, 'unknown');
    assert.ok(checked.option.warnings.some((w) => w.code === 'UNCONFIRMED_INDOOR'));
});

test('missing revalidation evidence retains the selected indoor type with unknowns', async () => {
    const cafe = unknownCafe();
    cafe.interiorAccessEvidence = undefined;
    const secret = 'test-only-selected-indoor-secret';
    const signed = issueOptionToken(
        request(),
        { placeId: cafe.place.placeId, experienceId: 'cafe-break-v1' },
        secret,
        start,
    );
    const result = await revalidateItinerary(
        {
            ...request(),
            selectedPlaceId: cafe.place.placeId,
            experienceId: 'cafe-break-v1',
            optionToken: signed.optionToken,
        },
        {
            signingSecret: secret,
            now: () => new Date(start),
            vertexAuthentication: null,
            getCandidate: async () => cafe,
            getDestination: async () => ({
                place: { ...cafe.place, placeId: 'demo-destination' },
                relations: { parentIds: [], childIds: [] },
                attributions: [],
            }),
            computeRoute: async () => route(),
            fetch: async () => Response.json({}, { status: 503 }),
        },
    );
    assert.equal(result.status, 'VALID');
    assert.equal(result.option.experienceId, 'cafe-break-v1');
    assert.ok(result.option.warnings.some((w) => w.code === 'UNCONFIRMED_INDOOR'));
});

test('confirmed temporary/permanent closures are excluded and include the source decision data', async () => {
    for (const businessStatus of ['CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY']) {
        const cafe = { ...unknownCafe(), businessStatus };
        const result = await search([exterior(), cafe]);
        assert.equal(result.options.length, 1);
        const decision = result.diagnostics.exclusions.find(
            (item) => item.reason === 'NOT_OPERATIONAL',
        );
        assert.equal(decision.placeLabel, cafe.place.label);
        assert.equal(decision.facts.businessStatus, businessStatus);
        assert.equal(decision.source.url, cafe.sourceUrl);
    }
});

test('known closed hours still exclude; unknown hours alone never create an exclusion', async () => {
    const cafe = indoorCandidate();
    cafe.opening.windows = [];
    const result = await search([exterior(), cafe]);
    assert.equal(result.options.length, 1);
    assert.equal(result.diagnostics.exclusions[0].reason, 'CLOSED_FOR_WINDOW');
    assert.deepEqual(result.diagnostics.exclusions[0].facts.openingWindows, []);
});

test('3km is inclusive: 2.5km and 3km survive, candidates just beyond 3km are diagnosed', async () => {
    const input = {
        request: { ...request(), origin: { latitude: 0, longitude: 0 } },
        destination: { ...exterior().place, placeId: 'demo-destination' },
    };
    for (const distance of [2500, 3000, 3001]) {
        const candidate = exterior();
        candidate.place = {
            ...candidate.place,
            latitude: ((distance / 6371000) * 180) / Math.PI,
            longitude: 0,
        };
        const result = await loadGroundedCandidates(input, {
            connection: () => ({}),
            remainingMs: () => 25000,
            now: () => new Date(start),
            discover: async () => ({
                candidates: [
                    {
                        placeId: candidate.place.placeId,
                        sourceTitle: '架空の外観',
                        sourceUrl: 'https://maps.google.com/',
                        title: '架空の外観を眺める',
                        description: 'テスト用',
                        sources: [],
                    },
                ],
                warnings: [],
                attributions: [],
            }),
            getDetails: async () => candidate,
        });
        assert.equal(result.candidates.length, distance <= 3000 ? 1 : 0);
        if (distance > 3000) {
            assert.equal(result.exclusions[0].reason, 'OUTSIDE_SEARCH_AREA');
            assert.equal(result.exclusions[0].facts.distanceMeters, 3001);
            assert.equal(result.exclusions[0].facts.searchRadiusMeters, 3000);
        }
    }
});

test('browser console prints exclusion evidence without coordinates or option tokens', async (t) => {
    const cafe = { ...unknownCafe(), businessStatus: 'CLOSED_PERMANENTLY' };
    const contained = indoorCandidate();
    contained.place.placeId = 'demo-contained';
    contained.relations.parentIds = ['demo-destination'];
    Object.assign(contained.interiorAccessEvidence, {
        placeId: contained.place.placeId,
        provider: 'grounded_maps',
        outsideDestination: false,
    });
    const result = await search([exterior(), cafe, contained]);
    let printed;
    const originalInfo = console.info,
        originalTable = console.table;
    t.after(() => {
        console.info = originalInfo;
        console.table = originalTable;
    });
    console.info = () => {};
    console.table = (rows) => {
        printed = rows;
    };
    printCandidateExclusions(result.diagnostics.exclusions, '候補検索');
    const encoded = JSON.stringify(printed);
    assert.match(encoded, /CLOSED_PERMANENTLY/);
    assert.match(encoded, /Google Places/);
    assert.ok(encoded.includes(cafe.place.label));
    const containment = printed.find((row) => row.除外理由 === 'DESTINATION_INTERIOR');
    assert.equal(containment.情報源, 'Google Places');
    const containmentFacts = JSON.parse(containment.判断に使用した情報);
    assert.equal(containmentFacts.destinationRelationSource, 'google_places');
    assert.equal(containmentFacts.outsideDestination, false);
    assert.equal(containmentFacts.outsideDestinationSource, 'grounded_maps');
    for (const privateField of [
        'latitude',
        'longitude',
        'optionToken',
        'OPTION_TOKEN_SECRET',
        'requestId',
    ])
        assert.ok(!encoded.includes(privateField));
});
