import { indoorProfiles } from '../../src/server/experience-profiles.ts';

export const start = Date.parse('2026-11-08T10:00:00+09:00');
export const at = (minutes) => new Date(start + minutes * 60000).toISOString();
export const request = () => ({
    requestId: 'fabricated-indoor-test',
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'demo-destination' },
    arriveBy: at(120),
    travelMode: 'WALK',
    excludedPlaceIds: [],
});
// Fabricated evidence only; never imported by the application.
export function indoorCandidate(kind = 'cafe') {
    const profile = indoorProfiles[kind];
    return {
        place: {
            placeId: 'demo-indoor',
            label: '自動テスト専用の架空施設',
            latitude: 35.69,
            longitude: 139.7,
        },
        types: [kind === 'small_exhibit' ? 'art_gallery' : 'cafe'],
        businessStatus: 'OPERATIONAL',
        retrievedAt: at(0),
        sourceUrl: 'https://example.com/fabricated-indoor',
        attributions: ['Google Maps'],
        relations: { parentIds: [], childIds: [] },
        opening: {
            status: 'known',
            coverageStart: at(-60),
            coverageEnd: at(600),
            windows: [{ opensAt: at(-60), closesAt: at(600) }],
        },
        interiorAccessEvidence: {
            placeId: 'demo-indoor',
            destinationPlaceId: 'demo-destination',
            experienceId: profile.experienceId,
            outsideDestination: true,
            sourceUrl: 'https://example.com/fabricated-indoor',
            provider: 'registered',
            checkedAt: at(0),
            validUntil: at(600),
            conditions:
                '自動テスト用の架空条件：屋内・予約不要・随時利用・目的地外・別途受付締切なし',
            indoorConfirmed: true,
            walkInAllowed: true,
            noFixedStart: true,
            smallExhibition: kind === 'small_exhibit',
            admissionRequired: false,
            entryCutoff: 'none',
            lastEntryAt: null,
        },
    };
}
export const route = (seconds = 600) => ({
    travelMode: 'WALK',
    durationSeconds: seconds,
    distanceMeters: 500,
    provider: 'Google Routes',
    warnings: [],
    attributions: ['Google Maps'],
});
