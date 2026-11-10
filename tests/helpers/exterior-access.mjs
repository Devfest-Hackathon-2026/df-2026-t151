/**
 * Create fabricated exterior-access evidence for an automated test.
 *
 * @param {string} placeId - The detour candidate to bind to the evidence.
 * @param {string} [destinationPlaceId='demo-destination'] - The requested endpoint in the same test case.
 */
export function demoAccess(placeId, destinationPlaceId = 'demo-destination') {
    return {
        placeId,
        destinationPlaceId,
        experienceId: 'public-exterior-v2',
        publicExteriorWithoutAdmission: true,
        outsideDestination: true,
        provider: 'registered',
        sourceUrl: 'https://example.com/fabricated-test-access',
        checkedAt: '2026-11-08T01:00:00.000Z',
        validUntil: '2026-11-09T01:00:00.000Z',
        conditions: '自動テスト専用の架空の利用条件',
    };
}
