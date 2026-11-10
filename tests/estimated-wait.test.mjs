import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTimeBudget } from '../src/server/time-budget.ts';
import { indoorProfiles, EXIT_SECONDS } from '../src/server/experience-profiles.ts';

const start = Date.parse('2026-11-09T10:00:00+09:00');
function input(profile) {
    return {
        calculatedAt: new Date(start).toISOString(),
        arriveBy: new Date(start + 120 * 60000).toISOString(),
        directSeconds: 600,
        legToStopSeconds: 600,
        legToDestinationSeconds: 600,
        bufferSeconds: 600,
        experienceDuration: {
            minSeconds: profile.activityMin + EXIT_SECONDS,
            maxSeconds: profile.activityMax + EXIT_SECONDS,
            includesWait: false,
        },
        wait: { status: 'estimated', minSeconds: profile.waitMin, maxSeconds: profile.waitMax },
    };
}
for (const [kind, totalMinutes] of [
    ['cafe', 45],
    ['light_meal', 60],
    ['small_exhibit', 45],
]) {
    test(`${kind}: upper estimate includes wait and exit; travel and buffer remain additional`, () => {
        const value = input(indoorProfiles[kind]);
        value.arriveBy = new Date(start + (totalMinutes + 30) * 60000).toISOString();
        const result = calculateTimeBudget(value);
        assert.equal(result.status, 'calculated');
        assert.equal(result.time.requiredSeconds, (totalMinutes + 30) * 60);
        assert.equal(result.time.isProvisional, true);
        assert.equal(result.time.waitTreatment, 'separate');
        assert.equal(result.time.waitSeconds, value.wait.maxSeconds);
        assert.ok(result.warnings.some(({ code }) => code === 'ESTIMATED_WAIT'));
        assert.equal(result.fitsDeadline, true);
        value.arriveBy = new Date(Date.parse(value.arriveBy) - 1).toISOString();
        assert.equal(calculateTimeBudget(value).fitsDeadline, false);
        // Recalculation starts from the new current time and does not shorten the activity.
        value.calculatedAt = new Date(start + 60000).toISOString();
        assert.equal(calculateTimeBudget(value).fitsDeadline, false);
    });
}
test('duration that already includes estimated waiting does not count it twice', () => {
    const value = input(indoorProfiles.cafe);
    value.experienceDuration = { minSeconds: 2400, maxSeconds: 2700, includesWait: true };
    const result = calculateTimeBudget(value);
    assert.equal(result.time.requiredSeconds, 75 * 60);
    assert.equal(result.time.waitSeconds, 0);
    assert.equal(result.time.waitTreatment, 'included');
    assert.equal(result.time.isProvisional, true);
    value.experienceDuration.maxSeconds = 600;
    value.experienceDuration.minSeconds = 600;
    assert.equal(calculateTimeBudget(value).reason, 'INCONSISTENT_WAIT');
});
test('estimated waiting rejects invalid ranges instead of treating them as zero', () => {
    for (const wait of [
        { status: 'estimated', minSeconds: 3, maxSeconds: 2 },
        { status: 'estimated', minSeconds: -1, maxSeconds: 2 },
        { status: 'estimated', minSeconds: 0, maxSeconds: NaN },
        { status: 'estimated', minSeconds: 0, maxSeconds: 1.5 },
    ])
        assert.throws(
            () => calculateTimeBudget({ ...input(indoorProfiles.cafe), wait }),
            RangeError,
        );
});
