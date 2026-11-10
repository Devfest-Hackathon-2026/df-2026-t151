import assert from 'node:assert/strict';
import test from 'node:test';
import {
    issueOptionToken,
    verifyOptionToken,
    OPTION_TOKEN_TTL_MS,
} from '../src/server/option-token.ts';
const secret = 'test-only-signing-secret-32-characters';
const now = Date.parse('2026-11-08T10:00:00+09:00');
const input = () => ({
    requestId: 'demo',
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'demo-destination' },
    arriveBy: '2026-11-08T12:00:00+09:00',
    travelMode: 'WALK',
    excludedPlaceIds: [],
});
const selected = { placeId: 'demo-park', experienceId: 'exterior-view-v1' };
const signed = () => ({
    ...input(),
    selectedPlaceId: selected.placeId,
    experienceId: selected.experienceId,
    optionToken: issueOptionToken(input(), selected, secret, now).optionToken,
});
test('accepts a genuine token; exact expiry is expired', () => {
    const value = signed();
    assert.equal(verifyOptionToken(value, secret, now + OPTION_TOKEN_TTL_MS - 1).status, 'valid');
    assert.equal(verifyOptionToken(value, secret, now + OPTION_TOKEN_TTL_MS).status, 'expired');
});
test('request IDs, current origin and visited history may change without extending the token', () => {
    const value = {
        ...signed(),
        requestId: 'new',
        origin: { latitude: 35.7, longitude: 139.71 },
        excludedPlaceIds: ['other-visited'],
    };
    assert.equal(verifyOptionToken(value, secret, now).status, 'valid');
});
for (const change of [
    { selectedPlaceId: 'other' },
    { experienceId: 'other' },
    { destination: { placeId: 'other' } },
    { arriveBy: '2026-11-08T13:00:00+09:00' },
    { travelMode: 'DRIVE' },
    { optionToken: 'demo-token' },
]) {
    test(`rejects changed selection or bound conditions: ${JSON.stringify(change)}`, () => {
        assert.throws(
            () => verifyOptionToken({ ...signed(), ...change }, secret, now),
            (error) => error.code === 'INVALID_INPUT',
        );
    });
}
test('rejects tampering, another signing key and future-issued tokens', () => {
    const value = signed();
    const parts = value.optionToken.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    claims.placeId = 'forged';
    parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
    assert.throws(() =>
        verifyOptionToken(
            { ...value, selectedPlaceId: 'forged', optionToken: parts.join('.') },
            secret,
            now,
        ),
    );
    assert.throws(() => verifyOptionToken(value, 'another-test-only-key-32-characters', now));
    assert.throws(() => verifyOptionToken(value, secret, now - 1));
});
test('contains no coordinates, deadline, destination, history or secret; each token is distinct', () => {
    const value = signed();
    const claims = Buffer.from(value.optionToken.split('.')[1], 'base64url').toString();
    for (const text of [
        'latitude',
        'longitude',
        '35.69',
        '139.7',
        'demo-destination',
        'excludedPlaceIds',
        secret,
    ])
        assert.ok(!claims.includes(text));
    assert.notEqual(value.optionToken, signed().optionToken);
});
test('requires a server signing secret', () => {
    for (const key of [undefined, '', 'short', ' '.repeat(64)])
        assert.throws(
            () => issueOptionToken(input(), selected, key, now),
            (error) => error.code === 'INTERNAL_ERROR',
        );
});
