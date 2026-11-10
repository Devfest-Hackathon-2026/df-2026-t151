import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createPlannerPostHandler,
    createPlannerLimiter,
} from '../src/server/planner-post-handler.ts';
import { validateRecommendationsRequest } from '../src/server/request-validation.ts';
import { GoogleServiceError } from '../src/server/google-http.ts';
const now = Date.parse('2026-11-08T10:00:00+09:00');
const input = () => ({
    requestId: 'demo-request',
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'demo-destination' },
    arriveBy: '2026-11-08T12:00:00+09:00',
    travelMode: 'WALK',
    excludedPlaceIds: [],
});
const request = (body = input(), changes = {}) =>
    new Request('https://example.com/api/v1/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...changes,
    });
const handler = (changes = {}) =>
    createPlannerPostHandler({
        validate: validateRecommendationsRequest,
        now: () => now,
        getApiKey: () => 'test-key',
        getSigningSecret: () => 'test-only-signing-secret-32-characters',
        getVertexAuthentication: () => ({ projectId: 'demo-vertex-project', location: 'global' }),
        execute: async (value) => ({ requestId: value.requestId, outcome: 'NO_OPTIONS' }),
        ...changes,
    });
test('echoes request IDs, uses server credentials and disables caching', async () => {
    const response = await handler({
        execute: async (value, options) => {
            assert.equal(options.apiKey, 'test-key');
            assert.deepEqual(options.vertexAuthentication, {
                projectId: 'demo-vertex-project',
                location: 'global',
            });
            assert.equal(options.geminiApiKey, undefined);
            assert.ok(options.signingSecret.startsWith('test-only'));
            assert.equal(options.now().getTime(), now);
            assert.ok(options.signal instanceof AbortSignal);
            return { requestId: value.requestId, outcome: 'NO_OPTIONS' };
        },
    })(request());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.equal((await response.json()).requestId, 'demo-request');
});
test('invalid fields and unsupported modes do not run the operation', async () => {
    for (const [change, status, field] of [
        [{ origin: null }, 400, 'origin'],
        [{ travelMode: 'DRIVE' }, 422, 'travelMode'],
    ]) {
        const response = await handler({ execute: async () => assert.fail('must not run') })(
            request({ ...input(), ...change }),
        );
        assert.equal(response.status, status);
        assert.equal((await response.json()).error.field, field);
    }
});
test('rejects malformed JSON, invalid UTF-8, oversize header and actual body, media types and query strings', async () => {
    const examples = [
        request(null, { body: '{' }),
        request(null, { body: new Uint8Array([0xff]) }),
        request(null, { body: 'x'.repeat(32769) }),
        request(input(), {
            headers: { 'Content-Type': 'application/json', 'Content-Length': '32769' },
        }),
        request(input(), { headers: { 'Content-Type': 'text/plain' } }),
        new Request('https://example.com/api/v1/recommendations?secret=query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        }),
    ];
    for (const example of examples) {
        const response = await handler({ execute: async () => assert.fail('must not run') })(
            example,
        );
        assert.equal(response.status, 400);
        assert.ok(!JSON.stringify(await response.json()).includes('secret=query'));
    }
});
test('bounds slow body reads and cancels their streams', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
        cancel() {
            cancelled = true;
        },
    });
    const response = await handler({ bodyTimeoutMs: 20 })(
        request(null, { body: stream, duplex: 'half' }),
    );
    assert.equal(response.status, 504);
    assert.equal(cancelled, true);
});
test('rate limits are shared across route handlers, echo requestId and reset after one minute', async () => {
    let clock = now;
    const limiter = createPlannerLimiter(() => clock);
    const first = handler({ limiter }),
        second = handler({ limiter });
    for (let index = 0; index < 2000; index++) assert.equal((await first(request())).status, 200);
    const limited = await second(request());
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60');
    assert.equal((await limited.json()).requestId, 'demo-request');
    clock += 60000;
    assert.equal((await second(request())).status, 200);
});
test('concurrent calls are capped and slots release on both success and failure', async () => {
    const releases = [];
    const api = handler({
        execute: () => new Promise((resolve, reject) => releases.push({ resolve, reject })),
    });
    const one = api(request()),
        two = api(request());
    while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await api(request())).status, 429);
    releases[0].reject(new Error('private details'));
    assert.equal((await one).status, 500);
    const three = api(request());
    while (releases.length < 3) await new Promise((resolve) => setImmediate(resolve));
    releases[1].resolve({ requestId: 'demo-request' });
    releases[2].resolve({ requestId: 'demo-request' });
    assert.equal((await two).status, 200);
    assert.equal((await three).status, 200);
});
test('converts provider errors to static messages without leaking body or key', async () => {
    for (const error of [
        new GoogleServiceError(429, 'RATE_LIMITED', true),
        new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', false),
        new Error('secret-raw-input'),
    ]) {
        const response = await handler({
            execute: async () => {
                throw error;
            },
        })(request());
        const body = await response.json();
        assert.equal(body.requestId, 'demo-request');
        assert.equal(response.status, error.status ?? 500);
        assert.ok(!JSON.stringify(body).includes('secret-raw-input'));
        if (response.status === 429) assert.equal(response.headers.get('Retry-After'), '60');
    }
});
