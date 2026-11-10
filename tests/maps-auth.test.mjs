import assert from 'node:assert/strict';
import test from 'node:test';
import { mapsAuthentication, mapsAuthHeaders } from '../src/server/maps-auth.ts';
import { apiCapabilities } from '../src/server/api-capabilities.ts';
import {
    googlePostJson,
    googlePlaceDetails,
    googleHourlyForecast,
    GoogleServiceError,
} from '../src/server/google-http.ts';
import { withRequestBudget } from '../src/server/request-budget.ts';

const projectId = 'demo-maps-project';
const testToken = 'test-only-short-lived-token';
const testKey = 'test-only-unused-key';
const credential = (getAccessToken = async () => testToken) => ({
    mode: 'service-account',
    projectId,
    getAccessToken,
});
const options = (extra = {}) => ({ apiKey: testKey, mapsAuthentication: credential(), ...extra });
const json = (value = {}, status = 200) => new Response(JSON.stringify(value), { status });
const signal = () => new AbortController().signal;
const failure = (code) => (error) => {
    assert.ok(error instanceof GoogleServiceError);
    assert.equal(error.code, code);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(testToken));
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(testKey));
    return true;
};
function verifyHeaders(init, fieldMask) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${testToken}`);
    assert.equal(headers.get('X-Goog-User-Project'), projectId);
    assert.equal(headers.get('X-Goog-Api-Key'), null);
    assert.equal(headers.get('X-Goog-FieldMask'), fieldMask);
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
}

test('Maps configuration retains local API-key mode and validates service-account settings without a key', () => {
    assert.deepEqual(mapsAuthentication({ GOOGLE_MAPS_API_KEY: testKey }), {
        mode: 'api-key',
        apiKey: testKey,
    });
    assert.deepEqual(
        mapsAuthentication({
            GOOGLE_MAPS_AUTH_MODE: 'service-account',
            GOOGLE_CLOUD_PROJECT: projectId,
        }),
        { mode: 'service-account', projectId },
    );
    for (const settings of [
        {},
        { GOOGLE_MAPS_AUTH_MODE: 'unknown', GOOGLE_MAPS_API_KEY: testKey },
        { GOOGLE_MAPS_AUTH_MODE: 'service-account', GOOGLE_MAPS_API_KEY: testKey },
        {
            GOOGLE_MAPS_AUTH_MODE: 'service-account',
            GOOGLE_CLOUD_PROJECT: 'bad/project',
            GOOGLE_MAPS_API_KEY: testKey,
        },
        { GOOGLE_MAPS_API_KEY: 'bad\nkey' },
    ])
        assert.equal(mapsAuthentication(settings), null);
});

test('capabilities recognises configured service-account mode without a Gemini key but still requires project and signing secret', () => {
    const settings = {
        GOOGLE_MAPS_AUTH_MODE: 'service-account',
        GOOGLE_CLOUD_PROJECT: projectId,
        OPTION_TOKEN_SECRET: 's'.repeat(64),
    };
    assert.equal(apiCapabilities(settings).dataMode, 'live');
    assert.deepEqual(apiCapabilities(settings).supportedTravelModes, ['WALK']);
    for (const key of ['GOOGLE_CLOUD_PROJECT', 'OPTION_TOKEN_SECRET'])
        assert.equal(apiCapabilities({ ...settings, [key]: undefined }).dataMode, 'demo');
    assert.equal(
        apiCapabilities({
            ...settings,
            GOOGLE_MAPS_AUTH_MODE: 'invalid',
            GOOGLE_MAPS_API_KEY: testKey,
        }).dataMode,
        'demo',
    );
});

for (const service of ['places', 'nearby', 'routes']) {
    test(`${service} sends a bearer token and quota project, never an API key`, async () => {
        let calls = 0;
        const result = await googlePostJson(
            service,
            { request: 'demo' },
            options({
                apiKey: undefined,
                fetch: async (url, init) => {
                    calls++;
                    assert.ok(url.startsWith('https://'));
                    verifyHeaders(
                        init,
                        service === 'routes'
                            ? 'routes.duration,routes.distanceMeters,routes.warnings'
                            : new Headers(init.headers).get('X-Goog-FieldMask'),
                    );
                    assert.ok(new Headers(init.headers).get('X-Goog-FieldMask'));
                    assert.equal(init.method, 'POST');
                    assert.deepEqual(JSON.parse(init.body), { request: 'demo' });
                    return json({ ok: true });
                },
            }),
        );
        assert.deepEqual(result, { ok: true });
        assert.equal(calls, 1);
    });
}

test('Place Details uses the same credential and preserves its fixed resource path and field mask', async () => {
    await googlePlaceDetails(
        'demo-place',
        true,
        options({
            fetch: async (url, init) => {
                assert.equal(
                    url,
                    'https://places.googleapis.com/v1/places/demo-place?languageCode=ja',
                );
                verifyHeaders(
                    init,
                    'id,displayName,location,types,businessStatus,currentOpeningHours,utcOffsetMinutes,googleMapsUri,attributions,containingPlaces,subDestinations',
                );
                assert.equal(init.method, 'GET');
                return json();
            },
        }),
    );
});

test('hourly weather uses bearer authentication and does not put credentials in its URL', async () => {
    await googleHourlyForecast(
        { latitude: 35.69, longitude: 139.7 },
        24,
        options({
            fetch: async (url, init) => {
                assert.equal(new URL(url).hostname, 'weather.googleapis.com');
                assert.ok(!url.includes(testKey) && !url.includes(testToken));
                verifyHeaders(init, null);
                return json();
            },
        }),
    );
});

test('Vertex uses its own ADC project even when Maps has a different authentication', async () => {
    await googlePostJson(
        'vertexMaps',
        {},
        options({
            vertexAuthentication: {
                projectId: 'demo-vertex-project',
                location: 'global',
                getAccessToken: async () => 'test-vertex-token',
            },
            mapsAuthentication: credential(async () => {
                throw new Error('must not obtain a Maps token');
            }),
            fetch: async (_url, init) => {
                const headers = new Headers(init.headers);
                assert.equal(headers.get('X-Goog-Api-Key'), null);
                assert.equal(headers.get('Authorization'), 'Bearer test-vertex-token');
                assert.equal(headers.get('X-Goog-User-Project'), 'demo-vertex-project');
                return json();
            },
        }),
    );
});

test('credential failures are sanitised and never fall back to the available API key', async () => {
    let calls = 0;
    await assert.rejects(
        googlePostJson(
            'places',
            {},
            options({
                mapsAuthentication: credential(async () => {
                    throw new Error(`${testToken} ${testKey} private credential path`);
                }),
                fetch: async () => {
                    calls++;
                    return json();
                },
            }),
        ),
        failure('UPSTREAM_UNAVAILABLE'),
    );
    assert.equal(calls, 0);
});

test('empty or header-injecting tokens are rejected before calling Google', async () => {
    for (const token of [null, undefined, '', 'bad\nAuthorization: injected']) {
        await assert.rejects(
            googlePostJson(
                'routes',
                {},
                options({
                    mapsAuthentication: credential(async () => token),
                    fetch: async () => {
                        assert.fail('must not call Google');
                    },
                }),
            ),
            failure('UPSTREAM_UNAVAILABLE'),
        );
    }
});

test('credential acquisition is included in the provider timeout', async () => {
    let calls = 0;
    const started = performance.now();
    await assert.rejects(
        googlePostJson(
            'places',
            {},
            options({
                mapsAuthentication: credential(() => new Promise(() => {})),
                timeoutMs: 20,
                fetch: async () => {
                    calls++;
                    return json();
                },
            }),
        ),
        failure('TIMEOUT'),
    );
    assert.ok(performance.now() - started < 1000);
    assert.equal(calls, 0);
});

test('abort while obtaining credentials returns promptly and observes late failures', async () => {
    const controller = new AbortController();
    let rejectToken;
    const pending = googlePostJson(
        'places',
        {},
        options({
            signal: controller.signal,
            mapsAuthentication: credential(
                () =>
                    new Promise((_resolve, reject) => {
                        rejectToken = reject;
                    }),
            ),
            fetch: async () => {
                assert.fail('must not call Google');
            },
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, failure('TIMEOUT'));
    rejectToken(new Error(testToken));
    await new Promise((resolve) => setImmediate(resolve));
});

test('already-aborted work does not request credentials', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        googlePostJson(
            'places',
            {},
            options({
                signal: controller.signal,
                mapsAuthentication: credential(async () => {
                    assert.fail('must not request token');
                }),
                fetch: async () => {
                    assert.fail('must not fetch');
                },
            }),
        ),
        failure('TIMEOUT'),
    );
});

test('expired or unauthorised provider responses are static errors without key fallback or retries', async () => {
    for (const status of [401, 403]) {
        let calls = 0;
        await assert.rejects(
            googlePostJson(
                'places',
                {},
                options({
                    fetch: async (_url, init) => {
                        calls++;
                        verifyHeaders(init, new Headers(init.headers).get('X-Goog-FieldMask'));
                        return json({ error: testToken }, status);
                    },
                }),
            ),
            failure('UPSTREAM_UNAVAILABLE'),
        );
        assert.equal(calls, 1);
    }
});

test('invalid quota projects fail before obtaining a credential', async () => {
    await assert.rejects(
        mapsAuthHeaders(
            {
                ...credential(async () => {
                    assert.fail('must not request token');
                }),
                projectId: 'injected\nproject',
            },
            signal(),
        ),
        failure('INTERNAL_ERROR'),
    );
});

test('request budgets preserve the selected authentication for nested Maps calls', async () => {
    const selected = credential();
    await withRequestBudget(options({ mapsAuthentication: selected }), async ({ connection }) => {
        assert.equal(connection().mapsAuthentication, selected);
        await googlePostJson(
            'routes',
            {},
            {
                ...connection(),
                fetch: async (_url, init) => {
                    verifyHeaders(init, 'routes.duration,routes.distanceMeters,routes.warnings');
                    return json();
                },
            },
        );
    });
});
