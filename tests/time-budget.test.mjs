import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { calculateTimeBudget } from '../src/server/time-budget.ts';

const start = '2026-11-08T14:00:00+09:00';
const deadlineAfter = (seconds) => new Date(Date.parse(start) + seconds * 1000).toISOString();
const budget = (overrides = {}) => ({
    calculatedAt: start,
    arriveBy: deadlineAfter(90 * 60),
    directSeconds: 20 * 60,
    legToStopSeconds: 10 * 60,
    legToDestinationSeconds: 20 * 60,
    experienceDuration: { minSeconds: 20 * 60, maxSeconds: 35 * 60, includesWait: false },
    wait: { status: 'not_applicable' },
    bufferSeconds: 10 * 60,
    ...overrides,
});

test('A01: 90 minutes available, 30 travel, 35 experience, 10 buffer', () => {
    const result = calculateTimeBudget(budget());
    assert.equal(result.status, 'calculated');
    assert.equal(result.fitsDeadline, true);
    assert.equal(result.time.requiredSeconds, 75 * 60);
    assert.equal(result.time.arrivalAt, deadlineAfter(65 * 60));
    assert.equal(result.time.slackSeconds, 25 * 60);
    assert.equal(result.time.bufferSeconds, 10 * 60);
    assert.equal(result.time.extraTravelSeconds, 10 * 60);
});

test('A02: 95 minutes required does not fit a 90-minute window', () => {
    const result = calculateTimeBudget(budget({ legToDestinationSeconds: 40 * 60 }));
    assert.equal(result.time.requiredSeconds, 95 * 60);
    assert.equal(result.fitsDeadline, false);
});

test('A03: exact deadline fits; one second or one millisecond short does not', () => {
    assert.equal(
        calculateTimeBudget(budget({ arriveBy: deadlineAfter(75 * 60) })).fitsDeadline,
        true,
    );
    assert.equal(
        calculateTimeBudget(budget({ arriveBy: deadlineAfter(75 * 60 - 1) })).fitsDeadline,
        false,
    );
    const justShort = new Date(Date.parse(deadlineAfter(75 * 60)) - 1).toISOString();
    const result = calculateTimeBudget(budget({ arriveBy: justShort }));
    assert.equal(result.fitsDeadline, false);
    assert.equal(result.time.slackSeconds, 599);
});

test('A04: direct arrival after the deadline excludes detours', () => {
    const result = calculateTimeBudget(budget({ arriveBy: deadlineAfter(20 * 60 - 1) }));
    assert.equal(result.status, 'excluded');
    assert.equal(result.reason, 'DIRECT_LATE');
    assert.equal(result.direct.arrivalAt, deadlineAfter(20 * 60));
});

test('direct arrival exactly at the deadline is not late, while a detour still does not fit', () => {
    const result = calculateTimeBudget(budget({ arriveBy: deadlineAfter(20 * 60) }));
    assert.equal(result.status, 'calculated');
    assert.equal(result.fitsDeadline, false);
});

test('experience ranges use the upper bound without shortening to fit', () => {
    const input = budget({
        arriveBy: deadlineAfter(79 * 60),
        experienceDuration: { minSeconds: 20 * 60, maxSeconds: 40 * 60, includesWait: false },
    });
    const before = structuredClone(input);
    const result = calculateTimeBudget(input);
    assert.equal(result.time.experienceSeconds, 40 * 60);
    assert.equal(result.time.requiredSeconds, 80 * 60);
    assert.equal(result.fitsDeadline, false);
    assert.deepEqual(input, before);
});

test('separate waiting: 30 travel + 30 experience + 15 wait + 10 buffer requires 85 minutes', () => {
    const result = calculateTimeBudget(
        budget({
            arriveBy: deadlineAfter(80 * 60),
            experienceDuration: { minSeconds: 30 * 60, maxSeconds: 30 * 60, includesWait: false },
            wait: { status: 'known', seconds: 15 * 60 },
        }),
    );
    assert.equal(result.time.requiredSeconds, 85 * 60);
    assert.equal(result.time.waitSeconds, 15 * 60);
    assert.equal(result.time.waitTreatment, 'separate');
    assert.equal(result.fitsDeadline, false);
});

test('included waiting: a 30-minute total containing 15 minutes waiting requires only 70 minutes', () => {
    const result = calculateTimeBudget(
        budget({
            arriveBy: deadlineAfter(80 * 60),
            experienceDuration: { minSeconds: 30 * 60, maxSeconds: 30 * 60, includesWait: true },
            wait: { status: 'known', seconds: 15 * 60 },
        }),
    );
    assert.equal(result.time.requiredSeconds, 70 * 60);
    assert.equal(result.time.experienceSeconds, 30 * 60);
    assert.equal(result.time.waitSeconds, 0);
    assert.equal(result.time.waitTreatment, 'included');
    assert.equal(result.fitsDeadline, true);
    assert.ok(!('experienceStartAt' in result.time));
});

test('unknown mandatory wait excludes a candidate even if the duration claims to include waiting', () => {
    for (const includesWait of [true, false, null]) {
        const result = calculateTimeBudget(
            budget({
                experienceDuration: { minSeconds: 1200, maxSeconds: 1800, includesWait },
                wait: { status: 'unknown', unavoidable: true },
            }),
        );
        assert.equal(result.status, 'excluded');
        assert.equal(result.reason, 'UNKNOWN_REQUIRED_WAIT');
    }
});

test('unknown avoidable wait stays null and makes the known subtotal provisional', () => {
    const result = calculateTimeBudget(budget({ wait: { status: 'unknown', unavoidable: false } }));
    assert.equal(result.time.waitSeconds, null);
    assert.equal(result.time.waitTreatment, 'unknown');
    assert.equal(result.time.isProvisional, true);
    assert.equal(result.time.requiredSeconds, 75 * 60);
    assert.equal(result.warnings[0].code, 'WAIT_UNKNOWN');
});

test('unclear wait inclusion uses a conservative sum and reports possible overlap', () => {
    const result = calculateTimeBudget(
        budget({
            experienceDuration: { minSeconds: 30 * 60, maxSeconds: 30 * 60, includesWait: null },
            wait: { status: 'known', seconds: 15 * 60 },
        }),
    );
    assert.equal(result.time.requiredSeconds, 85 * 60);
    assert.equal(result.time.isProvisional, true);
    assert.equal(result.warnings[0].code, 'WAIT_INCLUSION_UNKNOWN');
});

test('a known wait longer than an included total is inconsistent', () => {
    const result = calculateTimeBudget(
        budget({
            experienceDuration: { minSeconds: 600, maxSeconds: 1200, includesWait: true },
            wait: { status: 'known', seconds: 1201 },
        }),
    );
    assert.equal(result.reason, 'INCONSISTENT_WAIT');
});

test('negative extra travel is rejected instead of silently clamped', () => {
    const result = calculateTimeBudget(budget({ directSeconds: 30 * 60 + 1 }));
    assert.equal(result.status, 'excluded');
    assert.equal(result.reason, 'INCONSISTENT_ROUTE');
});

test('A10: recomputing later can invalidate a formerly feasible plan', () => {
    const input = budget();
    assert.equal(calculateTimeBudget(input).fitsDeadline, true);
    assert.equal(
        calculateTimeBudget({ ...input, calculatedAt: deadlineAfter(30 * 60) }).fitsDeadline,
        false,
    );
});

test('cross-midnight and different UTC offsets are compared as instants', () => {
    const result = calculateTimeBudget(
        budget({
            calculatedAt: '2026-11-08T23:30:00+09:00',
            arriveBy: '2026-11-08T16:00:00Z',
        }),
    );
    assert.equal(result.time.arrivalAt, '2026-11-08T15:35:00.000Z');
    assert.equal(result.fitsDeadline, true);
});

for (const field of [
    'directSeconds',
    'legToStopSeconds',
    'legToDestinationSeconds',
    'bufferSeconds',
]) {
    test(`rejects negative, fractional and non-finite ${field}`, () => {
        for (const value of [-1, 0.5, NaN, Infinity, '600']) {
            assert.throws(() => calculateTimeBudget(budget({ [field]: value })), RangeError);
        }
    });
}

test('rejects invalid ranges, wait metadata, date-times and overflowing durations', () => {
    for (const experienceDuration of [
        { minSeconds: -1, maxSeconds: 100, includesWait: false },
        { minSeconds: 200, maxSeconds: 100, includesWait: false },
        { minSeconds: 0, maxSeconds: NaN, includesWait: false },
        { minSeconds: 0, maxSeconds: 0.5, includesWait: false },
        { minSeconds: 0, maxSeconds: 100, includesWait: undefined },
    ])
        assert.throws(() => calculateTimeBudget(budget({ experienceDuration })), RangeError);
    for (const wait of [
        { status: 'known', seconds: -1 },
        { status: 'unknown' },
        { status: 'invalid' },
    ]) {
        assert.throws(() => calculateTimeBudget(budget({ wait })), RangeError);
    }
    assert.throws(
        () => calculateTimeBudget(budget({ calculatedAt: '2026-11-08T14:00:00' })),
        RangeError,
    );
    assert.throws(
        () => calculateTimeBudget(budget({ arriveBy: '2026-02-30T00:00:00Z' })),
        RangeError,
    );
    assert.throws(
        () => calculateTimeBudget(budget({ directSeconds: Number.MAX_SAFE_INTEGER })),
        RangeError,
    );
    assert.throws(
        () =>
            calculateTimeBudget(
                budget({
                    legToStopSeconds: Number.MAX_SAFE_INTEGER,
                    legToDestinationSeconds: Number.MAX_SAFE_INTEGER,
                }),
            ),
        RangeError,
    );
});

test('the existing demo fixture agrees with the time calculator without becoming live data', () => {
    const fixture = JSON.parse(
        readFileSync(new URL('../fixtures/search-success.json', import.meta.url), 'utf8'),
    );
    const option = fixture.options[0];
    const result = calculateTimeBudget({
        calculatedAt: fixture.calculatedAt,
        arriveBy: fixture.arriveBy,
        directSeconds: fixture.direct.durationSeconds,
        legToStopSeconds: option.time.legToStopSeconds,
        legToDestinationSeconds: option.time.legToDestinationSeconds,
        experienceDuration: option.experienceDuration,
        wait: { status: 'not_applicable' },
        bufferSeconds: option.time.bufferSeconds,
    });
    assert.equal(fixture.dataMode, 'demo');
    assert.equal(result.fitsDeadline, true);
    for (const [key, value] of Object.entries(result.time)) {
        if (key === 'arrivalAt') assert.equal(Date.parse(value), Date.parse(option.time[key]));
        else assert.deepEqual(value, option.time[key], key);
    }
});

test('adding travel or waiting never reduces the budget or increases slack', () => {
    const original = calculateTimeBudget(budget({ wait: { status: 'known', seconds: 0 } })).time;
    for (const seconds of [1, 59, 60, 601, 3600]) {
        const longer = calculateTimeBudget(
            budget({
                legToStopSeconds: 600 + seconds,
                wait: { status: 'known', seconds },
            }),
        ).time;
        assert.equal(longer.requiredSeconds, original.requiredSeconds + 2 * seconds);
        assert.equal(longer.slackSeconds, original.slackSeconds - 2 * seconds);
    }
});
