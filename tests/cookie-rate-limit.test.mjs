import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createCookieRateLimiter,
    COOKIE_NAME,
    COOKIE_LIMITS,
} from '../src/server/cookie-rate-limit.ts';
import { createPlacesHandler } from '../src/server/places-handler.ts';
import {
    createPlannerLimiter,
    createPlannerPostHandler,
} from '../src/server/planner-post-handler.ts';
import { validateRecommendationsRequest } from '../src/server/request-validation.ts';
import {
    loadRecommendations,
    lookupPlaces,
    PlannerApiError,
} from '../src/lib/client/planner-api.ts';

const start = Date.parse('2026-11-09T10:00:00+09:00');
const secret = 'test-only-cookie-signing-secret';
const request = (
    cookie = '',
    url = 'https://example.com/api/v1/places?requestId=test-001&query=test',
) => new Request(url, { headers: cookie ? { Cookie: cookie } : {} });
const newLimiter = (options = {}) =>
    createCookieRateLimiter({ now: () => start, getSecret: () => secret, ...options });
function issue(limiter) {
    return limiter
        .check(request(), 'places')
        .apply(new Response())
        .headers.get('Set-Cookie')
        .split(';')[0];
}
const input = {
    requestId: 'test-001',
    origin: { latitude: 35.69, longitude: 139.7 },
    destination: { placeId: 'test-destination' },
    arriveBy: '2026-11-09T12:00:00+09:00',
    travelMode: 'WALK',
    excludedPlaceIds: [],
};
const post = (cookie, body = input) =>
    new Request('https://example.com/api/v1/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body),
    });
const planner = (cookieLimiter, changes = {}) =>
    createPlannerPostHandler({
        cookieLimiter,
        now: () => start,
        validate: validateRecommendationsRequest,
        execute: async (value) => ({ requestId: value.requestId, outcome: 'NO_OPTIONS' }),
        getApiKey: () => undefined,
        getSigningSecret: () => secret,
        getVertexAuthentication: () => null,
        ...changes,
    });

test('issues an opaque signed host-only HttpOnly cookie, secure on HTTPS, without input data', () => {
    for (const protocol of ['https', 'http']) {
        const allowance = newLimiter().check(
            request('', `${protocol}://example.com/api/v1/places`),
            'places',
        );
        const response = allowance.apply(new Response());
        const cookie = response.headers.get('Set-Cookie');
        assert.match(cookie, new RegExp(`^${COOKIE_NAME}=[a-f0-9-]+\\.[A-Za-z0-9_-]{43};`));
        assert.match(cookie, /Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax/);
        assert.equal(cookie.includes('; Secure'), protocol === 'https');
        assert.ok(!cookie.includes('Domain='));
        assert.ok(!cookie.includes(secret));
        assert.match(response.headers.get('Cache-Control'), /no-store/);
    }
});

test('malformed, tampered, duplicated and oversized cookies are replaced safely', () => {
    const limiter = newLimiter();
    const cookie = issue(limiter);
    for (const raw of [
        `${COOKIE_NAME}=broken`,
        `${cookie.slice(0, -1)}${cookie.endsWith('A') ? 'B' : 'A'}`,
        `${cookie}; ${cookie}`,
        `${COOKIE_NAME}=${'x'.repeat(9000)}`,
    ]) {
        const replacement = limiter
            .check(request(raw), 'places')
            .apply(new Response())
            .headers.get('Set-Cookie');
        assert.ok(replacement);
        assert.ok(!replacement.startsWith(`${cookie};`));
    }
    assert.equal(
        limiter
            .check(request(`unrelated=value; ${cookie}`), 'places')
            .apply(new Response())
            .headers.get('Set-Cookie'),
        null,
    );
});

test('the same cookie and replayed old cookie share a minute quota; other browsers and operations have separate quotas', () => {
    let time = start;
    const limiter = newLimiter({ now: () => time });
    const cookie = issue(limiter);
    for (let i = 0; i < COOKIE_LIMITS.recommendations.minute; i++)
        assert.equal(limiter.check(request(cookie), 'recommendations').retryAfter, undefined);
    assert.equal(limiter.check(request(cookie), 'recommendations').retryAfter, 60);
    assert.equal(limiter.check(request(cookie), 'validation').retryAfter, undefined);
    assert.equal(limiter.check(request(issue(limiter)), 'recommendations').retryAfter, undefined);
    time += 60000;
    assert.equal(limiter.check(request(cookie), 'recommendations').retryAfter, undefined);
});

test('daily search quota survives minute changes and resets at midnight in Japan', () => {
    let time = Date.parse('2026-11-09T23:50:00+09:00');
    const limiter = newLimiter({ now: () => time });
    const cookie = issue(limiter);
    for (let i = 0; i < COOKIE_LIMITS.recommendations.day; i++) {
        assert.equal(limiter.check(request(cookie), 'recommendations').retryAfter, undefined);
        time += 500;
    }
    const limited = limiter.check(request(cookie), 'recommendations');
    assert.equal(limited.retryAfter, 100);
    assert.match(limited.message, /明日0時/);
    time = Date.parse('2026-11-10T00:00:00+09:00');
    assert.equal(limiter.check(request(cookie), 'recommendations').retryAfter, undefined);
});

test('daily allowances are separate for place lookup and validation', () => {
    for (const [operation, limit] of [
        ['places', COOKIE_LIMITS.places.day],
        ['validation', COOKIE_LIMITS.validation.day],
    ]) {
        let time = start;
        const limiter = newLimiter({ now: () => time });
        const cookie = issue(limiter);
        const used = operation === 'places' ? 1 : 0;
        for (let i = used; i < limit; i++) {
            time += 100;
            assert.equal(limiter.check(request(cookie), operation).retryAfter, undefined);
        }
        assert.match(limiter.check(request(cookie), operation).message, /本日の利用上限/);
        assert.equal(limiter.check(request(cookie), 'recommendations').retryAfter, undefined);
    }
});

test('skips tracking unknown visitors when full, preserves existing quotas and resumes tracking next day', () => {
    let time = start;
    const limiter = newLimiter({ now: () => time, maxVisitors: 1 });
    const cookie = issue(limiter);
    const untrackedCookie = issue(newLimiter());
    for (let i = 0; i < COOKIE_LIMITS.recommendations.minute; i++) {
        assert.equal(limiter.check(request(cookie), 'recommendations').retryAfter, undefined);
    }
    for (const untracked of ['', untrackedCookie]) {
        const allowance = limiter.check(request(untracked), 'recommendations');
        assert.equal(allowance.retryAfter, undefined);
        const response = allowance.apply(new Response());
        assert.equal(response.headers.get('Set-Cookie'), null);
        assert.match(response.headers.get('Cache-Control'), /no-store/);
    }
    assert.equal(limiter.check(request(cookie), 'recommendations').retryAfter, 60);
    time += 86400000;
    assert.match(issue(limiter), new RegExp(`^${COOKIE_NAME}=`));
});

test('a full cookie table still permits requests within the process-wide limits', async () => {
    const cookieLimiter = newLimiter({ maxVisitors: 1 });
    issue(cookieLimiter);
    const places = createPlacesHandler({
        cookieLimiter,
        now: () => start,
        search: async () => ({ places: [], attributions: [] }),
    });
    const limiter = createPlannerLimiter(() => start);
    const recommend = planner(cookieLimiter, { limiter });
    const validate = planner(cookieLimiter, { limiter, operation: 'validation' });
    for (let i = 0; i < 6000; i++) assert.equal((await places(request())).status, 200);
    assert.equal((await places(request())).status, 429);
    for (let i = 0; i < 1000; i++) {
        assert.equal((await recommend(post(''))).status, 200);
        assert.equal((await validate(post(''))).status, 200);
    }
    assert.equal((await recommend(post(''))).status, 429);
    assert.equal((await validate(post(''))).status, 429);
});

test('planner rejects searches beyond the increased minute quota before calling providers, echoes requestId and preserves validation allowance', async () => {
    const limiter = newLimiter();
    let calls = 0;
    const api = planner(limiter, {
        execute: async () => {
            calls++;
            return { requestId: input.requestId };
        },
    });
    const first = await api(post(''));
    assert.equal(first.status, 200);
    const cookie = first.headers.get('Set-Cookie').split(';')[0];
    for (let i = 0; i < COOKIE_LIMITS.recommendations.minute - 1; i++)
        assert.equal((await api(post(cookie))).status, 200);
    const limited = await api(post(cookie));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60');
    const body = await limited.json();
    assert.equal(body.requestId, input.requestId);
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.match(body.error.message, /短時間/);
    assert.equal(calls, COOKIE_LIMITS.recommendations.minute);
    assert.equal((await planner(limiter, { operation: 'validation' })(post(cookie))).status, 200);
});

test('invalid planner input does not spend quota; failed upstream attempts keep identity and consume quota', async () => {
    const limiter = newLimiter();
    const cookie = issue(limiter);
    const api = planner(limiter, {
        execute: async () => {
            throw new Error('private-provider-details');
        },
    });
    for (let i = 0; i < 5; i++)
        assert.equal((await api(post(cookie, { ...input, origin: null }))).status, 400);
    const first = await api(post(''));
    assert.equal(first.status, 500);
    const failedCookie = first.headers.get('Set-Cookie').split(';')[0];
    for (let i = 0; i < COOKIE_LIMITS.recommendations.minute - 1; i++)
        assert.equal((await api(post(failedCookie))).status, 500);
    const limited = await api(post(failedCookie));
    assert.equal(limited.status, 429);
    assert.ok(!(await limited.text()).includes('private-provider-details'));
});

test('parallel place requests cannot exceed the per-browser quota and keep existing concurrency control', async () => {
    const limiter = newLimiter();
    const cookie = issue(limiter);
    // Leave one place lookup available after issuing the cookie.
    for (let i = 0; i < COOKIE_LIMITS.places.minute - 2; i++)
        limiter.check(request(cookie), 'places');
    let calls = 0;
    let complete;
    const api = createPlacesHandler({
        cookieLimiter: limiter,
        now: () => start,
        search: () => {
            calls++;
            return new Promise((resolve) => {
                complete = resolve;
            });
        },
    });
    const pending = Array.from({ length: 8 }, () => api(request(cookie)));
    assert.equal(calls, 1);
    complete({ places: [], attributions: [] });
    const statuses = (await Promise.all(pending)).map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 200).length, 1);
    assert.equal(statuses.filter((status) => status === 429).length, 7);
});

test('existing browser client displays correlated rate-limit messages for both places and planner', async (t) => {
    const limiter = newLimiter();
    const cookie = issue(limiter);
    for (let i = 0; i < COOKIE_LIMITS.recommendations.minute; i++)
        limiter.check(request(cookie), 'recommendations');
    for (let i = 1; i < COOKIE_LIMITS.places.minute; i++) limiter.check(request(cookie), 'places');
    const api = planner(limiter, { execute: async () => assert.fail('no provider request') });
    const places = createPlacesHandler({
        cookieLimiter: limiter,
        search: async () => assert.fail('no provider request'),
    });
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });
    globalThis.fetch = async (path, init) => {
        const headers = new Headers(init.headers);
        headers.set('Cookie', cookie);
        const req = new Request(`https://example.com${path}`, { ...init, headers });
        return path.includes('/places?') ? places(req) : api(req);
    };
    for (const operation of [
        () => loadRecommendations(input, new AbortController().signal),
        () => lookupPlaces('test', new AbortController().signal),
    ])
        await assert.rejects(
            operation,
            (error) => error instanceof PlannerApiError && /短時間/.test(error.message),
        );
});
