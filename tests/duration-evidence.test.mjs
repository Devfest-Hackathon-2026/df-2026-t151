import assert from 'node:assert/strict';
import test from 'node:test';
import { selectExperienceDuration } from '../src/server/duration-evidence.ts';

const context = {
    placeId: 'demo-place',
    experienceId: 'view',
    visitStartAt: '2026-11-08T10:10:00+09:00',
    referenceAt: '2026-11-08T10:00:00+09:00',
};
const evidence = (sourceType = 'registered', seconds = 1800) => ({
    placeId: 'demo-place',
    experienceId: 'view',
    validFrom: '2026-11-08T00:00:00+09:00',
    validUntil: '2026-11-09T00:00:00+09:00',
    conditionsMatched: true,
    duration: {
        minSeconds: seconds,
        maxSeconds: seconds,
        sourceType,
        sourceUrl:
            sourceType === 'registered' || sourceType === 'estimate'
                ? null
                : 'https://example.com/duration',
        checkedAt: '2026-11-08T09:00:00+09:00',
        includesWait: false,
        conditions: 'テスト用の体験',
    },
});

test('prioritizes registered data over official, statistics and estimates', () => {
    assert.equal(
        selectExperienceDuration(
            [evidence('estimate', 600), evidence('official', 2700), evidence('registered', 1800)],
            context,
        ).maxSeconds,
        1800,
    );
    assert.equal(
        selectExperienceDuration([evidence('external_statistics'), evidence('official')], context)
            .sourceType,
        'official',
    );
});

for (const change of [
    { placeId: 'another-place' },
    { experienceId: 'another-experience' },
    { conditionsMatched: false },
    { validUntil: '2026-11-08T10:20:00+09:00' },
    { validFrom: '2026-11-08T11:00:00+09:00' },
    { duration: { ...evidence().duration, checkedAt: '2026-11-09T00:00:00+09:00' } },
    { duration: { ...evidence().duration, minSeconds: -1 } },
    { duration: { ...evidence().duration, minSeconds: 2000 } },
    { duration: { ...evidence().duration, sourceType: 'official', sourceUrl: null } },
    { duration: { ...evidence().duration, sourceUrl: 'javascript:bad' } },
]) {
    test(`invalid registered data falls through to an estimate: ${JSON.stringify(change)}`, () => {
        assert.equal(
            selectExperienceDuration(
                [{ ...evidence(), ...change }, evidence('estimate', 1200)],
                context,
            ).sourceType,
            'estimate',
        );
    });
}

test('does not mutate evidence or invent a duration when nothing is usable', () => {
    const item = evidence();
    const before = structuredClone(item);
    const selected = selectExperienceDuration([item], context);
    selected.maxSeconds = 1;
    assert.deepEqual(item, before);
    assert.equal(selectExperienceDuration([], context), null);
});
