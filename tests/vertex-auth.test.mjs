import assert from 'node:assert/strict';
import test from 'node:test';
import { vertexAuthentication, vertexGenerateContentUrl } from '../src/server/vertex-auth.ts';
import { googlePostJson, GoogleServiceError } from '../src/server/google-http.ts';
import { apiCapabilities } from '../src/server/api-capabilities.ts';
import { withRequestBudget } from '../src/server/request-budget.ts';

const projectId = 'demo-vertex-project';
const token = 'test-only-vertex-token';
const oldKey = 'test-only-ignored-api-key';
const credential = (getAccessToken = async () => token) => ({
    projectId,
    location: 'global',
    getAccessToken,
});
const fail = (code) => (error) => {
    assert.ok(error instanceof GoogleServiceError);
    assert.equal(error.code, code);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(token));
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(oldKey));
    return true;
};
const noFetch = async () => assert.fail('must not call a paid API');

test('Vertex requires a valid project, defaults to global and rejects URL/header injection', () => {
    assert.deepEqual(vertexAuthentication({ GOOGLE_CLOUD_PROJECT: projectId }), {
        projectId,
        location: 'global',
    });
    for (const settings of [
        {},
        { GOOGLE_CLOUD_PROJECT: 'bad/project' },
        { GOOGLE_CLOUD_PROJECT: projectId, GOOGLE_CLOUD_LOCATION: 'global.evil.example' },
        { GOOGLE_CLOUD_PROJECT: projectId, GOOGLE_CLOUD_LOCATION: '../global' },
        { GOOGLE_CLOUD_PROJECT: projectId, GOOGLE_CLOUD_LOCATION: 'global\nheader' },
    ]) {
        assert.equal(vertexAuthentication(settings), null);
    }
    assert.equal(
        vertexGenerateContentUrl(credential()),
        `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/gemini-3.5-flash:generateContent`,
    );
    const regional = vertexAuthentication({
        GOOGLE_CLOUD_PROJECT: projectId,
        GOOGLE_CLOUD_LOCATION: 'asia-northeast1',
    });
    assert.match(
        vertexGenerateContentUrl(regional),
        /^https:\/\/asia-northeast1-aiplatform\.googleapis\.com\/v1\/projects\//,
    );
});

test('Vertex sends only a bearer token and quota project, independent of an available Maps key', async () => {
    await googlePostJson(
        'vertexMaps',
        { contents: [] },
        {
            apiKey: oldKey,
            vertexAuthentication: credential(),
            mapsAuthentication: { mode: 'api-key', apiKey: 'test-maps-key' },
            fetch: async (url, init) => {
                assert.equal(url, vertexGenerateContentUrl(credential()));
                assert.ok(!url.includes(token) && !url.includes(oldKey));
                const headers = new Headers(init.headers);
                assert.equal(headers.get('Authorization'), `Bearer ${token}`);
                assert.equal(headers.get('X-Goog-User-Project'), projectId);
                assert.equal(headers.get('X-Goog-Api-Key'), null);
                assert.equal(headers.get('X-Goog-FieldMask'), null);
                assert.equal(init.redirect, 'error');
                assert.equal(init.cache, 'no-store');
                assert.deepEqual(JSON.parse(init.body), { contents: [] });
                return Response.json({ ok: true });
            },
        },
    );
});

test('missing or malformed Vertex configuration never uses an available API key', async () => {
    for (const auth of [
        null,
        { ...credential(), projectId: 'bad/project' },
        { ...credential(), location: 'global/../evil' },
    ]) {
        await assert.rejects(
            googlePostJson(
                'vertexMaps',
                {},
                { apiKey: oldKey, vertexAuthentication: auth, fetch: noFetch },
            ),
            fail('INTERNAL_ERROR'),
        );
    }
});

test('ADC failures and unusable tokens are static errors with no key fallback', async () => {
    const providers = [
        async () => {
            throw new Error(`${token} ${oldKey} private path`);
        },
        ...[null, undefined, '', 'bad\nheader'].map((value) => async () => value),
    ];
    for (const getAccessToken of providers) {
        await assert.rejects(
            googlePostJson(
                'vertexMaps',
                {},
                {
                    apiKey: oldKey,
                    vertexAuthentication: credential(getAccessToken),
                    fetch: noFetch,
                },
            ),
            fail('UPSTREAM_UNAVAILABLE'),
        );
    }
});

test('Vertex token acquisition respects provider timeout', async () => {
    await assert.rejects(
        googlePostJson(
            'vertexMaps',
            {},
            {
                vertexAuthentication: credential(() => new Promise(() => {})),
                timeoutMs: 20,
                fetch: noFetch,
            },
        ),
        fail('TIMEOUT'),
    );
});

test('Vertex abort observes late ADC failures without leaking credentials', async () => {
    const controller = new AbortController();
    let rejectToken;
    const pending = googlePostJson(
        'vertexMaps',
        {},
        {
            signal: controller.signal,
            vertexAuthentication: credential(
                () =>
                    new Promise((_resolve, reject) => {
                        rejectToken = reject;
                    }),
            ),
            fetch: noFetch,
        },
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, fail('TIMEOUT'));
    rejectToken(new Error(token));
    await new Promise((resolve) => setImmediate(resolve));
});

test('already-aborted Vertex requests do not obtain a token', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        googlePostJson(
            'vertexMaps',
            {},
            {
                signal: controller.signal,
                vertexAuthentication: credential(async () =>
                    assert.fail('must not obtain a token'),
                ),
                fetch: noFetch,
            },
        ),
        fail('TIMEOUT'),
    );
});

test('Vertex 401/403 do not retry or fall back to an API key', async () => {
    for (const status of [401, 403]) {
        let calls = 0;
        await assert.rejects(
            googlePostJson(
                'vertexMaps',
                {},
                {
                    apiKey: oldKey,
                    vertexAuthentication: credential(),
                    fetch: async () => {
                        calls++;
                        return Response.json({ error: token }, { status });
                    },
                },
            ),
            fail('UPSTREAM_UNAVAILABLE'),
        );
        assert.equal(calls, 1);
    }
});

test('request budgets pass Vertex credentials through to nested calls', async () => {
    const selected = credential();
    await withRequestBudget({ vertexAuthentication: selected }, async (scope) => {
        assert.equal(scope.connection().vertexAuthentication, selected);
        await googlePostJson(
            'vertexMaps',
            {},
            {
                ...scope.connection(),
                fetch: async (_url, init) => {
                    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${token}`);
                    return Response.json({});
                },
            },
        );
    });
});

test('capabilities accepts ADC configuration without a Gemini key and rejects invalid locations', () => {
    const settings = {
        GOOGLE_CLOUD_PROJECT: projectId,
        GOOGLE_MAPS_AUTH_MODE: 'service-account',
        OPTION_TOKEN_SECRET: 's'.repeat(64),
    };
    assert.equal(apiCapabilities(settings).dataMode, 'live');
    assert.equal(
        apiCapabilities({ ...settings, GOOGLE_CLOUD_LOCATION: 'evil.example' }).dataMode,
        'demo',
    );
});
