import assert from 'node:assert/strict';
import test from 'node:test';
import { parseZonedDateTime } from '../src/server/date-time.ts';
import {
    validateItineraryRequest,
    validatePlacesQuery,
    validateRecommendationsRequest,
} from '../src/server/request-validation.ts';

const now = new Date('2026-11-08T14:00:00+09:00');
const options = { now, supportedTravelModes: ['WALK'] };
const validRequest = () => ({
    requestId: 'search-001',
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'selected-place-id' },
    arriveBy: '2026-11-08T15:30:00+09:00',
    travelMode: 'WALK',
    excludedPlaceIds: [],
});

test('UTC and explicit offsets represent the same instant', () => {
    assert.equal(
        parseZonedDateTime('2026-11-08T15:30:00+09:00'),
        Date.parse('2026-11-08T06:30:00Z'),
    );
    assert.equal(
        parseZonedDateTime('2026-11-07T22:30:00-08:00'),
        Date.parse('2026-11-08T06:30:00Z'),
    );
    assert.equal(
        parseZonedDateTime('2028-02-29T00:00:00.123Z'),
        Date.parse('2028-02-29T00:00:00.123Z'),
    );
});

for (const invalid of [
    '2026-11-08T15:30:00',
    '2026-02-30T15:30:00Z',
    '2026-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-11-00T00:00:00Z',
    '2026-11-08T24:00:00Z',
    '2026-11-08T15:60:00Z',
    '2026-11-08T15:30:60Z',
    '2026-11-08T15:30:00+24:00',
    '2026-11-08T15:30:00+09:60',
    '2026-11-08T15:30:00.1234Z',
    '2026/11/08 15:30',
    '',
    null,
]) {
    test(`rejects invalid or ambiguous date-time: ${String(invalid)}`, () => {
        assert.equal(parseZonedDateTime(invalid), null);
    });
}

test('accepts search input without mutating it and discards client time and unknown fields', () => {
    const input = {
        ...validRequest(),
        calculatedAt: '1900-01-01T00:00:00Z',
        secret: 'do-not-echo',
    };
    const before = structuredClone(input);
    const result = validateRecommendationsRequest(input, options);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, validRequest());
    assert.deepEqual(input, before);
    assert.notEqual(result.value.origin, input.origin);
});

test('coordinates on the global boundaries and zero are valid numbers', () => {
    for (const origin of [
        { latitude: -90, longitude: -180 },
        { latitude: 90, longitude: 180 },
        { latitude: 0, longitude: 0 },
    ]) {
        assert.equal(
            validateRecommendationsRequest({ ...validRequest(), origin }, options).ok,
            true,
        );
    }
});

for (const [field, change] of [
    ['requestId', { requestId: '   ' }],
    ['requestId', { requestId: 'x\nsecret' }],
    ['requestId', { requestId: 'x'.repeat(129) }],
    ['origin', { origin: null }],
    ['origin', { origin: [] }],
    ['origin.latitude', { origin: { latitude: '35.69', longitude: 139.7 } }],
    ['origin.latitude', { origin: { latitude: NaN, longitude: 139.7 } }],
    ['origin.latitude', { origin: { latitude: 90.0001, longitude: 139.7 } }],
    ['origin.longitude', { origin: { latitude: 35.69, longitude: Infinity } }],
    ['origin.longitude', { origin: { latitude: 35.69, longitude: -180.001 } }],
    ['destination.placeId', { destination: {} }],
    ['destination.placeId', { destination: { placeId: 'x'.repeat(257) } }],
    ['arriveBy', { arriveBy: now.toISOString() }],
    ['arriveBy', { arriveBy: '2026-11-08T13:59:59+09:00', calculatedAt: '1900-01-01T00:00:00Z' }],
    ['arriveBy', { arriveBy: '2026-11-08T15:30:00' }],
    ['travelMode', { travelMode: 'FLY' }],
    ['excludedPlaceIds', { excludedPlaceIds: null }],
    ['excludedPlaceIds', { excludedPlaceIds: [''] }],
    ['excludedPlaceIds', { excludedPlaceIds: [null] }],
    ['excludedPlaceIds', { excludedPlaceIds: Array.from({ length: 51 }, (_, i) => `place-${i}`) }],
]) {
    test(`invalid ${field}: ${JSON.stringify(change)}`, () => {
        const result = validateRecommendationsRequest({ ...validRequest(), ...change }, options);
        assert.equal(result.ok, false);
        assert.equal(result.status, 400);
        assert.equal(result.body.error.code, 'INVALID_INPUT');
        assert.equal(result.body.error.field, field);
        assert.equal(result.body.error.retryable, false);
    });
}

test('missing or non-object bodies produce safe errors', () => {
    for (const input of [null, undefined, [], 'private input', 1]) {
        const result = validateRecommendationsRequest(input, options);
        assert.equal(result.status, 400);
        assert.equal(result.body.requestId, '');
        assert.equal(result.body.error.field, null);
        assert.ok(!JSON.stringify(result).includes('private input'));
    }
});

test('known unsupported modes return 422 and are never replaced with walking', () => {
    for (const travelMode of ['TRANSIT', 'DRIVE', 'BICYCLE']) {
        const result = validateRecommendationsRequest({ ...validRequest(), travelMode }, options);
        assert.equal(result.status, 422);
        assert.equal(result.body.error.code, 'UNSUPPORTED_MODE');
        assert.equal(result.body.requestId, 'search-001');
    }
    assert.equal(validateRecommendationsRequest(validRequest(), { now }).status, 422);
});

test('a future deadline one millisecond away is accepted without minute rounding', () => {
    const input = { ...validRequest(), arriveBy: new Date(now.getTime() + 1).toISOString() };
    assert.equal(validateRecommendationsRequest(input, options).ok, true);
});

test('error bodies contain the request ID and static messages, without location or raw payload', () => {
    const result = validateRecommendationsRequest(
        { ...validRequest(), origin: { latitude: 'private-location', longitude: 139.7123456789 } },
        options,
    );
    const serialized = JSON.stringify(result.body);
    assert.ok(!serialized.includes('private-location'));
    assert.ok(!serialized.includes('139.7123456789'));
    assert.equal(result.body.requestId, 'search-001');
});

test('place search validates request ID and a bounded nonempty query', () => {
    const input = { requestId: 'places-001', query: '新宿 駅' };
    assert.deepEqual(validatePlacesQuery(input), { ok: true, value: input });
    assert.equal(validatePlacesQuery({ ...input, query: ' ' }).body.error.field, 'query');
    assert.equal(validatePlacesQuery({ ...input, query: 'x'.repeat(201) }).status, 400);
    assert.equal(validatePlacesQuery({ query: '新宿' }).body.error.field, 'requestId');
});

test('itinerary selection requires all selection fields and retains common validation', () => {
    const input = {
        ...validRequest(),
        selectedPlaceId: 'stop',
        experienceId: 'visit',
        optionToken: 'opaque-signed-token',
    };
    assert.deepEqual(validateItineraryRequest(input, options), { ok: true, value: input });
    for (const field of ['selectedPlaceId', 'experienceId', 'optionToken']) {
        assert.equal(
            validateItineraryRequest({ ...input, [field]: '' }, options).body.error.field,
            field,
        );
    }
    assert.equal(
        validateItineraryRequest({ ...input, optionToken: 'x'.repeat(4097) }, options).status,
        400,
    );
    assert.equal(
        validateItineraryRequest({ ...input, arriveBy: now.toISOString() }, options).body.error
            .field,
        'arriveBy',
    );
});
