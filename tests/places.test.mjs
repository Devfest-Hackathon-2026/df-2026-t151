import assert from 'node:assert/strict';
import test from 'node:test';
import { PlacesServiceError, searchPlaces } from '../src/server/places.ts';

const testKey = 'test-only-not-a-real-key';
const place = () => ({
    id: 'demo-place',
    displayName: { text: '新宿の目的地（架空）' },
    location: { latitude: 35.69, longitude: 139.7 },
    attributions: [{ provider: 'Example Provider', providerUri: 'https://example.com/source' }],
});
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const run = (payload) =>
    searchPlaces('新宿駅', { apiKey: testKey, fetch: async () => json(payload) });
const failsWith = (status, code, retryable) => (error) => {
    assert.ok(error instanceof PlacesServiceError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.ok(!JSON.stringify(error).includes(testKey));
    return true;
};

test('sends one request with bounded fields and translates provider data to the API contract', async () => {
    let calls = 0;
    const result = await searchPlaces('新宿駅', {
        apiKey: testKey,
        fetch: async (url, init) => {
            calls++;
            assert.equal(url, 'https://places.googleapis.com/v1/places:searchText');
            assert.equal(init.method, 'POST');
            assert.equal(init.cache, 'no-store');
            assert.equal(init.redirect, 'error');
            assert.equal(new Headers(init.headers).get('X-Goog-Api-Key'), testKey);
            assert.equal(
                new Headers(init.headers).get('X-Goog-FieldMask'),
                'places.id,places.displayName,places.formattedAddress,places.primaryTypeDisplayName,places.location,places.attributions',
            );
            assert.deepEqual(JSON.parse(init.body), {
                textQuery: '新宿駅',
                languageCode: 'ja',
                regionCode: 'JP',
                pageSize: 5,
            });
            assert.ok(init.signal instanceof AbortSignal);
            return json({
                places: [{ ...place(), websiteUri: 'https://example.com/not-requested' }],
            });
        },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.places, [
        { placeId: 'demo-place', label: '新宿の目的地（架空）', latitude: 35.69, longitude: 139.7 },
    ]);
    assert.deepEqual(result.attributions, [
        { provider: 'Google Maps', providerUri: 'https://maps.google.com/' },
        { provider: 'Example Provider', providerUri: 'https://example.com/source' },
    ]);
    assert.ok(!JSON.stringify(result).includes('websiteUri'));
});

test('same-name matches keep their individual addresses, types and IDs', async () => {
    const base = { ...place(), displayName: { text: '同名の駅（架空）' } };
    const result = await run({
        places: [
            {
                ...base,
                id: 'east',
                formattedAddress: '東口通り（架空）',
                primaryTypeDisplayName: { text: '鉄道駅' },
            },
            {
                ...base,
                id: 'west',
                formattedAddress: '西口通り（架空）',
                primaryTypeDisplayName: { text: '地下鉄駅' },
            },
            {
                ...base,
                id: 'missing',
                formattedAddress: '',
                primaryTypeDisplayName: { text: '\ninvalid' },
            },
        ],
    });
    assert.deepEqual(
        result.places.map(({ placeId, label, address, typeLabel }) => ({
            placeId,
            label,
            address,
            typeLabel,
        })),
        [
            {
                placeId: 'east',
                label: '同名の駅（架空）',
                address: '東口通り（架空）',
                typeLabel: '鉄道駅',
            },
            {
                placeId: 'west',
                label: '同名の駅（架空）',
                address: '西口通り（架空）',
                typeLabel: '地下鉄駅',
            },
            {
                placeId: 'missing',
                label: '同名の駅（架空）',
                address: undefined,
                typeLabel: undefined,
            },
        ],
    );
});

test('empty and omitted places fields are successful empty searches', async () => {
    assert.deepEqual((await run({})).places, []);
    assert.deepEqual((await run({ places: [] })).places, []);
});

test('caps output at five places and deduplicates provider attributions', async () => {
    const result = await run({
        places: Array.from({ length: 7 }, (_, i) => ({ ...place(), id: `demo-${i}` })),
    });
    assert.equal(result.places.length, 5);
    assert.equal(result.attributions.length, 2);
});

test('preserves provider names without fabricating missing links', async () => {
    const result = await run({
        places: [{ ...place(), attributions: [{ provider: 'Provider without link' }] }],
    });
    assert.deepEqual(result.attributions[1], {
        provider: 'Provider without link',
        providerUri: null,
    });
});

for (const payload of [
    null,
    [],
    { places: null },
    { places: {} },
    { error: { message: 'provider-private-data' } },
    { places: [{ ...place(), id: '' }] },
    { places: [{ ...place(), displayName: {} }] },
    { places: [{ ...place(), location: { latitude: null, longitude: 139.7 } }] },
    { places: [{ ...place(), location: { latitude: 91, longitude: 139.7 } }] },
    { places: [{ ...place(), location: { latitude: 35.69, longitude: 181 } }] },
    {
        places: [
            {
                ...place(),
                attributions: [{ provider: 'Unsafe link', providerUri: 'javascript:alert(1)' }],
            },
        ],
    },
    {
        places: [
            {
                ...place(),
                attributions: [
                    { provider: 'Unsafe link', providerUri: 'https://user:secret@example.com/' },
                ],
            },
        ],
    },
]) {
    test(`rejects malformed provider data: ${JSON.stringify(payload)}`, async () => {
        await assert.rejects(run(payload), failsWith(502, 'UPSTREAM_UNAVAILABLE', true));
    });
}

for (const [status, expected, code, retryable] of [
    [400, 502, 'UPSTREAM_UNAVAILABLE', false],
    [401, 502, 'UPSTREAM_UNAVAILABLE', false],
    [403, 502, 'UPSTREAM_UNAVAILABLE', false],
    [429, 429, 'RATE_LIMITED', true],
    [500, 502, 'UPSTREAM_UNAVAILABLE', true],
    [503, 502, 'UPSTREAM_UNAVAILABLE', true],
    [504, 504, 'TIMEOUT', true],
]) {
    test(`maps provider HTTP ${status} without copying provider messages or retrying`, async () => {
        let calls = 0;
        await assert.rejects(
            searchPlaces('新宿駅', {
                apiKey: testKey,
                fetch: async () => {
                    calls++;
                    return json({ error: { message: `sensitive ${testKey}` } }, status);
                },
            }),
            failsWith(expected, code, retryable),
        );
        assert.equal(calls, 1);
    });
}

test('invalid query and missing key fail before an external request', async () => {
    const fetch = async () => {
        assert.fail('external request must not occur');
    };
    await assert.rejects(
        searchPlaces('', { apiKey: testKey, fetch }),
        failsWith(400, 'INVALID_INPUT', false),
    );
    for (const apiKey of [undefined, '', ' ', 'key\nwith-header-injection']) {
        await assert.rejects(
            searchPlaces('新宿駅', { apiKey, fetch }),
            failsWith(500, 'INTERNAL_ERROR', false),
        );
    }
});

test('network and invalid JSON errors do not retain a raw cause', async () => {
    for (const fetch of [
        async () => {
            throw new Error(`network error containing ${testKey}`);
        },
        async () => new Response(`not json containing ${testKey}`),
    ]) {
        try {
            await searchPlaces('新宿駅', { apiKey: testKey, fetch });
            assert.fail('expected failure');
        } catch (error) {
            failsWith(502, 'UPSTREAM_UNAVAILABLE', true)(error);
            assert.ok(!error.cause);
            assert.ok(!String(error.stack).includes(testKey));
        }
    }
});

test('bounds response bytes even when Content-Length is missing', async () => {
    await assert.rejects(
        searchPlaces('新宿駅', {
            apiKey: testKey,
            fetch: async () => new Response(' '.repeat(1024 * 1024 + 1)),
        }),
        failsWith(502, 'UPSTREAM_UNAVAILABLE', true),
    );
});

test('aborts a hanging request at the configured timeout', async () => {
    await assert.rejects(
        searchPlaces('新宿駅', {
            apiKey: testKey,
            timeoutMs: 10,
            fetch: async (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => reject(new Error('abort')), {
                        once: true,
                    });
                }),
        }),
        failsWith(504, 'TIMEOUT', true),
    );
});
