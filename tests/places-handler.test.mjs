import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GET } from '../src/app/api/v1/places/route.ts';
import { createPlacesHandler } from '../src/server/places-handler.ts';
import { PlacesServiceError } from '../src/server/places.ts';

const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/places-success.json', import.meta.url), 'utf8'),
);
const request = (query = 'requestId=places-001&query=%E6%96%B0%E5%AE%BF%E9%A7%85') =>
    new Request(`http://localhost/api/v1/places?${query}`);
const mockResult = () => ({ places: fixture.places, attributions: fixture.attributions });
const noRequest = async () => {
    assert.fail('provider should not be called');
};

test('the actual Next.js GET export validates before any provider request', async () => {
    const response = await GET(request('query='));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.field, 'requestId');
});

test('valid requests return the contract, echo request IDs and disable caching', async () => {
    let calls = 0;
    const handler = createPlacesHandler({
        getApiKey: () => 'test-key',
        search: async (query, options) => {
            calls++;
            assert.equal(query, '新宿駅');
            assert.equal(options.apiKey, 'test-key');
            return mockResult();
        },
    });
    const response = await handler(request());
    assert.equal(calls, 1);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(await response.json(), { ...fixture, requestId: 'places-001' });
});

test('no matches remains a 200 empty list', async () => {
    const handler = createPlacesHandler({ search: async () => ({ places: [], attributions: [] }) });
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).places, []);
});

for (const [query, field] of [
    ['query=新宿駅', 'requestId'],
    ['requestId=places-001', 'query'],
    ['requestId=places-001&query=%20', 'query'],
    ['requestId=first&requestId=second&query=新宿駅', 'requestId'],
    ['requestId=places-001&query=新宿駅&query=池袋駅', 'query'],
]) {
    test(`invalid query does not call the provider: ${query}`, async () => {
        const handler = createPlacesHandler({ search: noRequest });
        const response = await handler(request(query));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.field, field);
        assert.match(response.headers.get('Cache-Control'), /no-store/);
    });
}

test('rejects oversized URLs before parsing or calling the provider', async () => {
    const response = await createPlacesHandler({ search: noRequest })(
        request('query=' + 'x'.repeat(4097)),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).requestId, '');
});

for (const [status, code, retryable] of [
    [429, 'RATE_LIMITED', true],
    [500, 'INTERNAL_ERROR', false],
    [502, 'UPSTREAM_UNAVAILABLE', true],
    [504, 'TIMEOUT', true],
]) {
    test(`maps ${code} to a static API error`, async () => {
        const handler = createPlacesHandler({
            search: async () => {
                throw new PlacesServiceError(status, code, retryable);
            },
        });
        const response = await handler(request());
        assert.equal(response.status, status);
        const body = await response.json();
        assert.equal(body.requestId, 'places-001');
        assert.equal(body.error.code, code);
        assert.equal(body.error.retryable, retryable);
        if (status === 429) assert.equal(response.headers.get('Retry-After'), '60');
    });
}

test('unexpected exceptions never copy secrets or raw input to the client', async () => {
    const response = await createPlacesHandler({
        search: async () => {
            throw new Error('private-key-and-query');
        },
    })(request());
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('private-key-and-query'));
});

test('per-instance quota blocks the 6001st valid request and resets after one minute', async () => {
    let time = 1000;
    let calls = 0;
    const handler = createPlacesHandler({
        now: () => time,
        search: async () => {
            calls++;
            return mockResult();
        },
    });
    for (let i = 0; i < 6000; i++) assert.equal((await handler(request())).status, 200);
    const limited = await handler(request());
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60');
    assert.equal(calls, 6000);
    time += 60000;
    assert.equal((await handler(request())).status, 200);
    assert.equal(calls, 6001);
});

test('caps concurrent provider calls and releases slots after completion', async () => {
    const complete = [];
    const handler = createPlacesHandler({
        search: () => new Promise((resolve) => complete.push(() => resolve(mockResult()))),
    });
    const pending = Array.from({ length: 4 }, () => handler(request()));
    assert.equal((await handler(request())).status, 429);
    assert.equal(complete.length, 4);
    for (const resolve of complete) resolve();
    for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
    const next = handler(request());
    complete.at(-1)();
    assert.equal((await next).status, 200);
});

test('provider failures also release concurrent slots', async () => {
    let failing = true;
    const handler = createPlacesHandler({
        search: async () => {
            if (failing) throw new Error('failure');
            return mockResult();
        },
    });
    for (let i = 0; i < 4; i++) assert.equal((await handler(request())).status, 500);
    failing = false;
    assert.equal((await handler(request())).status, 200);
});
