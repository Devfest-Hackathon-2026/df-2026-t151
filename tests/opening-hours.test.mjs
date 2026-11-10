import assert from 'node:assert/strict';
import test from 'node:test';
import { isOpenForVisit, parseOpeningSchedule } from '../src/server/opening-hours.ts';

const now = '2026-11-08T10:00:00+09:00';
const point = (day, hour, minute = 0) => ({ date: { year: 2026, month: 11, day }, hour, minute });
const hours = (...periods) => ({ periods });
const period = (startHour = 9, endHour = 18) => ({
    open: point(8, startHour),
    close: point(8, endHour),
});

test('checks the whole visit rather than only openNow, including closing boundaries', () => {
    const schedule = parseOpeningSchedule({ ...hours(period()), openNow: false }, 540, now);
    assert.equal(isOpenForVisit(schedule, now, '2026-11-08T18:00:00+09:00'), 'OPEN');
    assert.equal(isOpenForVisit(schedule, '2026-11-08T08:59:59+09:00', now), 'CLOSED');
    assert.equal(isOpenForVisit(schedule, now, '2026-11-08T18:00:00.001+09:00'), 'CLOSED');
    assert.equal(
        isOpenForVisit(schedule, '2026-11-08T18:00:00+09:00', '2026-11-08T18:00:00+09:00'),
        'CLOSED',
    );
});

test('supports split hours and merges adjacent or overlapping intervals', () => {
    const schedule = parseOpeningSchedule(hours(period(9, 12), period(13, 18)), 540, now);
    assert.equal(
        isOpenForVisit(schedule, '2026-11-08T11:30:00+09:00', '2026-11-08T13:30:00+09:00'),
        'CLOSED',
    );
    const adjacent = parseOpeningSchedule(hours(period(9, 12), period(12, 18)), 540, now);
    assert.equal(
        isOpenForVisit(adjacent, '2026-11-08T11:30:00+09:00', '2026-11-08T13:30:00+09:00'),
        'OPEN',
    );
});

test('handles midnight, omitted zero-valued fields and truncated dated periods', () => {
    const schedule = parseOpeningSchedule(
        hours({
            open: { date: { year: 2026, month: 11, day: 8 }, truncated: true },
            close: point(9, 2),
        }),
        540,
        now,
    );
    assert.equal(
        isOpenForVisit(schedule, '2026-11-08T23:50:00+09:00', '2026-11-09T00:10:00+09:00'),
        'OPEN',
    );
});

test('does not extend the seven-day coverage or infer a new schedule', () => {
    const schedule = parseOpeningSchedule(hours(period()), 540, now);
    assert.equal(
        isOpenForVisit(schedule, '2026-11-15T10:00:00+09:00', '2026-11-15T11:00:00+09:00'),
        'UNKNOWN',
    );
    assert.equal(isOpenForVisit(schedule, 'bad', now), 'UNKNOWN');
});

test('an explicitly empty periods array is known closed', () => {
    assert.equal(isOpenForVisit(parseOpeningSchedule(hours(), 540, now), now, now), 'CLOSED');
});

for (const value of [
    undefined,
    null,
    { openNow: true },
    { periods: 'invalid' },
    hours({ open: { day: 0, hour: 0, minute: 0 } }),
    hours({ open: point(8, 18), close: point(8, 9) }),
    hours({ open: { ...point(8, 9), day: 1 }, close: point(8, 18) }),
    hours({ open: { date: { year: 2026, month: 2, day: 30 }, hour: 9 }, close: point(8, 18) }),
]) {
    test(`unknown hours stay unknown: ${JSON.stringify(value)}`, () => {
        assert.equal(parseOpeningSchedule(value, 540, now).status, 'unknown');
    });
}

test('does not apply fixed JST math to other offsets', () => {
    assert.equal(parseOpeningSchedule(hours(period()), -480, now).status, 'unknown');
});
