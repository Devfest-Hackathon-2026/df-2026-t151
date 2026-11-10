import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGroundedDetours, discoverGroundedDetours } from '../src/server/grounded-detours.ts';
const at = '2026-11-08T01:00:00.000Z';
const input = () => ({
    request: {
        requestId: 'demo',
        origin: { latitude: 35.69, longitude: 139.7 },
        destination: { placeId: 'demo-garden' },
        arriveBy: '2026-11-08T03:00:00.000Z',
        travelMode: 'WALK',
        excludedPlaceIds: [],
    },
    destination: {
        placeId: 'demo-garden',
        label: '架空の庭園',
        latitude: 35.69,
        longitude: 139.71,
    },
});
const item = () => ({
    placeId: 'demo-art',
    placeName: '架空の街角彫刻',
    title: '街角彫刻の意匠を眺める',
    description: 'テスト専用の架空の体験です',
    publicExteriorWithoutAdmission: true,
    outsideDestination: true,
    accessStatement: 'この架空の彫刻は庭園の外の公道から観察でき、入場は不要です',
});
const payload = () => ({
    candidates: [
        {
            finishReason: 'STOP',
            content: { parts: [{ text: JSON.stringify({ candidates: [item()] }) }] },
            groundingMetadata: {
                groundingChunks: [
                    {
                        maps: {
                            placeId: 'places/demo-art',
                            title: '架空の街角彫刻',
                            uri: 'https://maps.google.com/?cid=demo',
                        },
                    },
                ],
                groundingSupports: [
                    { segment: { text: item().accessStatement }, groundingChunkIndices: [0] },
                ],
            },
        },
    ],
});
test('uses actual grounding identity, source title and supported access text', () => {
    const result = parseGroundedDetours(payload(), input(), at);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].placeId, 'demo-art');
    assert.equal(result.candidates[0].accessEvidence.provider, 'grounded_maps');
    assert.equal(result.candidates[0].accessEvidence.destinationPlaceId, 'demo-garden');
    assert.equal(result.attributions[0].provider, 'Google Maps：架空の街角彫刻');
});
test('resolves an exact source title when the model has no place ID', () => {
    const value = payload();
    const record = { ...item(), placeId: null };
    value.candidates[0].content.parts[0].text = JSON.stringify({ candidates: [record] });
    assert.equal(parseGroundedDetours(value, input(), at).candidates[0].placeId, 'demo-art');
});
for (const modify of [
    (value) => {
        value.candidates[0].groundingMetadata = {};
    },
    (value) => {
        value.candidates[0].groundingMetadata.groundingSupports = [];
    },
    (value) => {
        value.candidates[0].groundingMetadata.groundingSupports[0].segment.text =
            '営業時間の情報だけ';
    },
    (value) => {
        value.candidates[0].groundingMetadata.groundingChunks[0].maps.placeId = 'places/another-id';
    },
    (value) => {
        value.candidates[0].groundingMetadata.groundingChunks[0].maps.uri =
            'https://evil.example/maps';
    },
]) {
    test(
        'rejects candidates without matching location and statement provenance: ' +
            modify.toString(),
        () => {
            const value = payload();
            modify(value);
            const result = parseGroundedDetours(value, input(), at);
            if (result.candidates.length) {
                assert.equal(
                    result.candidates[0].accessEvidence.publicExteriorWithoutAdmission,
                    null,
                );
            } else
                assert.ok(
                    result.warnings.some((warning) => warning.code === 'AI_EVIDENCE_MISSING'),
                );
        },
    );
}
test('unknown access remains provisional; destination, visited places and a different selected place are filtered', () => {
    const value = payload();
    value.candidates[0].content.parts[0].text = JSON.stringify({
        candidates: [{ ...item(), publicExteriorWithoutAdmission: null }],
    });
    assert.equal(
        parseGroundedDetours(value, input(), at).candidates[0].accessEvidence
            .publicExteriorWithoutAdmission,
        null,
    );
    const visited = input();
    visited.request.excludedPlaceIds = ['demo-art'];
    assert.equal(parseGroundedDetours(payload(), visited, at).candidates.length, 0);
    assert.equal(
        parseGroundedDetours(
            payload(),
            { ...input(), selectedPlace: { ...input().destination, placeId: 'other' } },
            at,
        ).candidates.length,
        0,
    );
});
test('malformed or incomplete responses are errors, while a genuine empty answer is supported', () => {
    for (const value of [
        null,
        {},
        { candidates: [] },
        { candidates: [{ finishReason: 'MAX_TOKENS' }] },
        { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not JSON' }] } }] },
    ]) {
        assert.throws(
            () => parseGroundedDetours(value, input(), at),
            (error) => error.code === 'UPSTREAM_UNAVAILABLE',
        );
    }
    const value = payload();
    value.candidates[0].content.parts[0].text = '{"candidates":[]}';
    assert.deepEqual(parseGroundedDetours(value, input(), at).candidates, []);
});
test('uses the fixed Agent Platform endpoint with Maps grounding and bounded generation', async () => {
    let calls = 0;
    const result = await discoverGroundedDetours(input(), {
        vertexAuthentication: {
            projectId: 'demo-vertex-project',
            location: 'global',
            getAccessToken: async () => 'test-vertex-token',
        },
        now: () => new Date(at),
        fetch: async (url, init) => {
            calls++;
            assert.equal(
                url,
                'https://aiplatform.googleapis.com/v1/projects/demo-vertex-project/locations/global/publishers/google/models/gemini-3.5-flash:generateContent',
            );
            assert.equal(init.headers['Authorization'], 'Bearer test-vertex-token');
            assert.equal(init.headers['X-Goog-Api-Key'], undefined);
            assert.equal('X-Goog-FieldMask' in init.headers, false);
            const body = JSON.parse(init.body);
            if (calls === 1) {
                assert.deepEqual(body.tools, [{ googleMaps: {} }]);
                assert.deepEqual(body.generationConfig.thinkingConfig, {
                    thinkingLevel: 'MINIMAL',
                });
            } else {
                assert.equal(body.tools, undefined);
                assert.equal(body.generationConfig.responseMimeType, 'application/json');
                assert.deepEqual(
                    body.generationConfig.responseSchema.properties.candidates.items.properties
                        .accessStatement.enum,
                    ['s0'],
                );
            }
            assert.ok(!init.body.includes('test-vertex-key'));
            assert.equal('temperature' in body.generationConfig, false);
            assert.equal(init.cache, 'no-store');
            const value = payload();
            if (calls === 2)
                value.candidates[0].content.parts[0].text = JSON.stringify({
                    candidates: [{ ...item(), accessStatement: 's0' }],
                });
            return Response.json(value);
        },
    });
    assert.equal(calls, 2);
    assert.equal(result.candidates.length, 1);
});
test('missing API credentials fail before the network call', async () => {
    await assert.rejects(
        discoverGroundedDetours(input(), {
            apiKey: undefined,
            fetch: async () => assert.fail('no call'),
        }),
        (error) => error.code === 'INTERNAL_ERROR',
    );
});

test('long source statements use short schema references and restore exact evidence', async () => {
    const long = '架空の条件文'.repeat(180);
    let calls = 0;
    const result = await discoverGroundedDetours(input(), {
        vertexAuthentication: {
            projectId: 'demo-vertex-project',
            location: 'global',
            getAccessToken: async () => 'test-vertex-token',
        },
        now: () => new Date(at),
        fetch: async (_url, init) => {
            const value = payload();
            if (++calls === 1) {
                value.candidates[0].content.parts[0].text = long;
                value.candidates[0].groundingMetadata.groundingSupports[0].segment.text = long;
            } else {
                const body = JSON.parse(init.body);
                assert.ok(JSON.stringify(body.generationConfig.responseSchema).length < 1500);
                assert.equal(JSON.parse(body.contents[0].parts[0].text).statementRefs.s0, long);
                value.candidates[0].content.parts[0].text = JSON.stringify({
                    candidates: [{ ...item(), accessStatement: 's0' }],
                });
            }
            return Response.json(value);
        },
    });
    assert.equal(result.candidates[0].accessEvidence.conditions, long);
});

test('unknown or prototype statement references cannot create evidence', async () => {
    for (const ref of ['s999', '__proto__', 'constructor', item().accessStatement]) {
        let calls = 0;
        const result = await discoverGroundedDetours(input(), {
            vertexAuthentication: {
                projectId: 'demo-vertex-project',
                location: 'global',
                getAccessToken: async () => 'test-vertex-token',
            },
            now: () => new Date(at),
            fetch: async () => {
                const value = payload();
                if (++calls === 2)
                    value.candidates[0].content.parts[0].text = JSON.stringify({
                        candidates: [{ ...item(), accessStatement: ref }],
                    });
                return Response.json(value);
            },
        });
        assert.equal(result.candidates.length, 1);
        assert.equal(result.candidates[0].accessEvidence.publicExteriorWithoutAdmission, null);
        assert.equal(result.candidates[0].accessEvidence.outsideDestination, null);
    }
});

test('an answer without Maps sources stops before a second model call', async () => {
    let calls = 0;
    const value = payload();
    value.candidates[0].groundingMetadata = {};
    const result = await discoverGroundedDetours(input(), {
        vertexAuthentication: {
            projectId: 'demo-vertex-project',
            location: 'global',
            getAccessToken: async () => 'test-vertex-token',
        },
        now: () => new Date(at),
        fetch: async () => {
            calls++;
            return Response.json(value);
        },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.candidates, []);
});

test('malformed or incomplete extraction stays an upstream error after response restoration', async () => {
    const mutations = [
        (answer) => {
            answer.finishReason = 'MAX_TOKENS';
        },
        (answer) => {
            answer.content.parts[0].text = '{';
        },
        (answer) => {
            answer.content.parts[0].text = JSON.stringify({ candidates: Array(5).fill(item()) });
        },
        (answer) => {
            answer.content.parts = Array(17).fill({ text: '' });
        },
        (answer) => {
            answer.content.parts = [{ thought: true, text: '{"candidates":[]}' }];
        },
    ];
    for (const mutate of mutations) {
        let calls = 0;
        await assert.rejects(
            discoverGroundedDetours(input(), {
                vertexAuthentication: {
                    projectId: 'demo-vertex-project',
                    location: 'global',
                    getAccessToken: async () => 'test-vertex-token',
                },
                now: () => new Date(at),
                fetch: async () => {
                    const value = payload();
                    if (++calls === 2) mutate(value.candidates[0]);
                    return Response.json(value);
                },
            }),
            (error) => error.code === 'UPSTREAM_UNAVAILABLE',
        );
        assert.equal(calls, 2);
    }
});

test('missing source support reaches extraction as unknown without inventing access evidence', async () => {
    let calls = 0;
    const result = await discoverGroundedDetours(input(), {
        vertexAuthentication: {
            projectId: 'demo-vertex-project',
            location: 'global',
            getAccessToken: async () => 'test-vertex-token',
        },
        now: () => new Date(at),
        fetch: async () => {
            calls++;
            const value = payload();
            if (calls === 1)
                value.candidates[0].content.parts[0].text = '利用条件は確認できませんでした';
            else
                value.candidates[0].content.parts[0].text = JSON.stringify({
                    candidates: [{ ...item(), accessStatement: null }],
                });
            return Response.json(value);
        },
    });
    assert.equal(calls, 2);
    assert.equal(result.candidates[0].accessEvidence.publicExteriorWithoutAdmission, null);
});

test('the extraction response cannot replace the original source metadata', async () => {
    let calls = 0;
    const result = await discoverGroundedDetours(input(), {
        vertexAuthentication: {
            projectId: 'demo-vertex-project',
            location: 'global',
            getAccessToken: async () => 'test-vertex-token',
        },
        now: () => new Date(at),
        fetch: async () => {
            const value = payload();
            if (++calls === 2) {
                value.candidates[0].groundingMetadata.groundingChunks[0].maps.placeId =
                    'places/forged-id';
                value.candidates[0].content.parts[0].text = JSON.stringify({
                    candidates: [{ ...item(), accessStatement: 's0' }],
                });
            }
            return Response.json(value);
        },
    });
    assert.equal(result.candidates[0].placeId, 'demo-art');
});
