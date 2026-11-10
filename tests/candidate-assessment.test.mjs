import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCandidate } from '../src/server/candidate-assessment.ts';

const at = (minutes) =>
    new Date(Date.parse('2026-11-08T10:00:00+09:00') + minutes * 60000).toISOString();
const route = (minutes) => ({
    travelMode: 'WALK',
    durationSeconds: minutes * 60,
    distanceMeters: 500,
    provider: 'Google Routes',
    warnings: [{ code: 'WALKING_BETA', message: 'テスト用注意' }],
    attributions: ['Google Maps'],
});
const input = () => ({
    candidate: {
        place: { placeId: 'demo-place', label: '架空の景観', latitude: 35.69, longitude: 139.7 },
        types: ['park'],
        businessStatus: 'OPERATIONAL',
        retrievedAt: at(0),
        sourceUrl: null,
        attributions: ['Google Maps'],
        opening: {
            status: 'known',
            coverageStart: at(-600),
            coverageEnd: at(600),
            windows: [{ opensAt: at(-60), closesAt: at(120) }],
        },
    },
    experience: {
        experienceId: 'view',
        title: '架空の体験',
        description: '自動テスト用',
        wait: { status: 'not_applicable' },
        admission: { status: 'not_applicable' },
        durationEvidence: [
            {
                placeId: 'demo-place',
                experienceId: 'view',
                validFrom: at(-60),
                validUntil: at(600),
                conditionsMatched: true,
                duration: {
                    minSeconds: 1200,
                    maxSeconds: 1800,
                    sourceType: 'estimate',
                    sourceUrl: null,
                    checkedAt: at(0),
                    includesWait: false,
                    conditions: 'テスト用推定',
                },
            },
        ],
    },
    calculatedAt: at(0),
    arriveBy: at(90),
    directSeconds: 1200,
    legToStop: route(10),
    legToDestination: route(20),
    bufferSeconds: 600,
});

test('combines the upper duration bound, opening hours and time budget without fabricating unknown data', () => {
    const result = assessCandidate(input());
    assert.equal(result.eligible, true);
    assert.equal(result.option.time.requiredSeconds, 70 * 60);
    assert.equal(result.option.time.experienceSeconds, 30 * 60);
    assert.equal(result.option.time.stopArrivalAt, at(10));
    assert.equal(result.option.time.stopDepartureAt, at(40));
    assert.equal(result.option.time.arrivalAt, at(60));
    assert.equal(result.option.crowd.status, 'unknown');
    assert.equal(result.option.cost.amount, null);
    assert.ok(result.option.warnings.some((warning) => warning.code === 'ESTIMATED_DURATION'));
    assert.equal(
        result.option.warnings.filter((warning) => warning.code === 'WALKING_BETA').length,
        1,
    );
});

test('deadline equality fits, while one millisecond short is rejected', () => {
    assert.equal(assessCandidate({ ...input(), arriveBy: at(70) }).eligible, true);
    assert.equal(
        assessCandidate({ ...input(), arriveBy: new Date(Date.parse(at(70)) - 1).toISOString() })
            .reason,
        'TIME_LIMIT',
    );
});

test('checks arrival and the full visit, preventing opening waits and closing overruns', () => {
    for (const window of [
        { opensAt: at(11), closesAt: at(120) },
        { opensAt: at(-60), closesAt: at(39) },
    ]) {
        const value = input();
        value.candidate.opening.windows = [window];
        assert.equal(assessCandidate(value).reason, 'CLOSED_FOR_VISIT');
    }
});

test('required entry must have a verified last-entry time, including queue delay', () => {
    const value = input();
    value.experience.wait = { status: 'known', seconds: 300 };
    value.experience.admission = { status: 'required', lastEntryAt: null };
    assert.ok(
        assessCandidate(value).option.warnings.some((w) => w.code === 'UNCONFIRMED_ENTRY_CUTOFF'),
    );
    value.experience.admission.lastEntryAt = at(14);
    assert.equal(assessCandidate(value).reason, 'LAST_ENTRY_PASSED');
    value.experience.admission.lastEntryAt = at(15);
    assert.equal(assessCandidate(value).eligible, true);
});

test('included wait is counted once while actual entry is checked after the queue', () => {
    const value = input();
    value.experience.durationEvidence[0].duration.includesWait = true;
    value.experience.wait = { status: 'known', seconds: 900 };
    value.experience.admission = { status: 'required', lastEntryAt: at(24) };
    assert.equal(assessCandidate(value).reason, 'LAST_ENTRY_PASSED');
    value.experience.admission.lastEntryAt = at(25);
    const result = assessCandidate(value);
    assert.equal(result.eligible, true);
    assert.equal(result.option.time.requiredSeconds, 70 * 60);
    assert.equal(result.option.time.experienceStartAt, at(25));
    assert.equal(result.option.time.stopDepartureAt, at(40));
});

test('unavoidable unknown waits are excluded; avoidable unknown waits stay provisional', () => {
    const value = input();
    value.experience.wait = { status: 'unknown', unavoidable: true };
    assert.equal(assessCandidate(value).reason, 'UNKNOWN_REQUIRED_WAIT');
    value.experience.wait.unavoidable = false;
    const result = assessCandidate(value);
    assert.equal(result.eligible, true);
    assert.equal(result.option.time.waitSeconds, null);
    assert.equal(result.option.time.isProvisional, true);
});

test('does not invent entry timestamps for an unknown queue inside an inclusive duration', () => {
    const value = input();
    value.experience.wait = { status: 'unknown', unavoidable: false };
    value.experience.durationEvidence[0].duration.includesWait = true;
    assert.equal(assessCandidate(value).reason, 'WAIT_START_UNKNOWN');
});

test('rejects stale metadata, closed businesses, missing duration and inconsistent routes', () => {
    let value = input();
    value.candidate.retrievedAt = at(-16);
    assert.equal(assessCandidate(value).reason, 'STALE_OR_INVALID_SOURCE');
    value = input();
    value.candidate.businessStatus = 'CLOSED_TEMPORARILY';
    assert.equal(assessCandidate(value).reason, 'NOT_OPERATIONAL');
    value = input();
    value.candidate.opening = { status: 'unknown' };
    assert.equal(assessCandidate(value).option.opening.status, 'unknown');
    value = input();
    value.experience.durationEvidence = [];
    assert.equal(assessCandidate(value).reason, 'DURATION_UNKNOWN');
    value = input();
    value.directSeconds = 1801;
    assert.equal(assessCandidate(value).reason, 'INCONSISTENT_ROUTE');
});
