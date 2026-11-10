import assert from 'node:assert/strict';
import test from 'node:test';
import { exteriorAccessReason } from '../src/server/exterior-access.ts';
import { demoAccess } from './helpers/exterior-access.mjs';
const at = '2026-11-08T01:00:00.000Z';
const reason = (evidence) => exteriorAccessReason(evidence, 'demo-art', 'demo-destination', at);
test('explicitly sourced public exterior access is required; a missing parent is not enough', () => {
    assert.equal(reason(undefined), 'ACCESS_UNKNOWN');
    assert.equal(reason(demoAccess('demo-art')), null);
});
for (const [change, expected] of [
    [{ publicExteriorWithoutAdmission: null }, 'ACCESS_UNKNOWN'],
    [{ publicExteriorWithoutAdmission: false }, 'ADMISSION_REQUIRED'],
    [{ outsideDestination: false }, 'DESTINATION_INTERIOR'],
    [{ outsideDestination: null }, 'DESTINATION_RELATION_UNKNOWN'],
    [{ destinationPlaceId: 'other' }, 'ACCESS_CONTEXT_MISMATCH'],
    [{ placeId: 'other' }, 'ACCESS_CONTEXT_MISMATCH'],
    [{ checkedAt: '2026-11-08T01:00:00.001Z' }, 'ACCESS_STALE'],
    [{ checkedAt: '2026-11-08T00:44:59.999Z' }, 'ACCESS_STALE'],
    [{ sourceUrl: 'javascript:bad' }, 'ACCESS_UNKNOWN'],
    [{ sourceUrl: 'https://user:password@example.com' }, 'ACCESS_UNKNOWN'],
    [{ conditions: '' }, 'ACCESS_UNKNOWN'],
]) {
    test('fails closed for unsupported access evidence: ' + JSON.stringify(change), () =>
        assert.equal(reason({ ...demoAccess('demo-art'), ...change }), expected),
    );
}
test('the source validity must cover the whole visit', () => {
    const evidence = { ...demoAccess('demo-art'), validUntil: '2026-11-08T01:30:00.000Z' };
    assert.equal(
        exteriorAccessReason(
            evidence,
            'demo-art',
            'demo-destination',
            at,
            '2026-11-08T01:30:00.000Z',
        ),
        null,
    );
    assert.equal(
        exteriorAccessReason(
            evidence,
            'demo-art',
            'demo-destination',
            at,
            '2026-11-08T01:30:00.001Z',
        ),
        'ACCESS_STALE',
    );
});
