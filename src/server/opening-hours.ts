import { parseZonedDateTime } from './date-time.ts';

export type OpeningSchedule =
    | { status: 'unknown' }
    | {
          status: 'known';
          coverageStart: string;
          coverageEnd: string;
          windows: { opensAt: string; closesAt: string }[];
      };

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointTime(value: unknown): number | null {
    if (!record(value) || !record(value.date)) return null;
    const { year, month, day } = value.date;
    if (![year, month, day].every(Number.isInteger)) return null;
    // Zero-valued protobuf scalar fields may be omitted. A full date is still required.
    const hour = value.hour ?? 0;
    const minute = value.minute ?? 0;
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const time = parseZonedDateTime(
        `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`,
    );
    if (time === null) return null;
    const actualDay = new Date(time + 9 * 3600000).getUTCDay();
    if (value.day !== undefined && value.day !== actualDay) return null;
    return time;
}

/** Current, dated periods only. This first version supports Japan's fixed JST offset. */
export function parseOpeningSchedule(
    hours: unknown,
    utcOffsetMinutes: unknown,
    requestedAt: string,
): OpeningSchedule {
    const reference = parseZonedDateTime(requestedAt);
    if (
        reference === null ||
        utcOffsetMinutes !== 540 ||
        !record(hours) ||
        !Array.isArray(hours.periods) ||
        hours.periods.length > 32
    ) {
        return { status: 'unknown' };
    }
    const date = new Date(reference + 9 * 3600000).toISOString().slice(0, 10);
    const coverageStart = parseZonedDateTime(`${date}T00:00:00+09:00`)!;
    const coverageEnd = coverageStart + 7 * 86400000;
    const windows: { start: number; end: number }[] = [];
    for (const period of hours.periods) {
        if (!record(period)) return { status: 'unknown' };
        const start = pointTime(period.open);
        const end = pointTime(period.close);
        // Do not infer always-open operation from openNow or undated weekly hours.
        if (
            start === null ||
            end === null ||
            end <= start ||
            start < coverageStart ||
            end > coverageEnd
        ) {
            return { status: 'unknown' };
        }
        windows.push({ start, end });
    }
    windows.sort((a, b) => a.start - b.start);
    const merged: typeof windows = [];
    for (const window of windows) {
        const previous = merged.at(-1);
        if (previous && window.start <= previous.end)
            previous.end = Math.max(previous.end, window.end);
        else merged.push({ ...window });
    }
    return {
        status: 'known',
        coverageStart: new Date(coverageStart).toISOString(),
        coverageEnd: new Date(coverageEnd).toISOString(),
        windows: merged.map((window) => ({
            opensAt: new Date(window.start).toISOString(),
            closesAt: new Date(window.end).toISOString(),
        })),
    };
}

export function isOpenForVisit(
    schedule: OpeningSchedule,
    startAt: string,
    endAt: string,
): 'OPEN' | 'CLOSED' | 'UNKNOWN' {
    const start = parseZonedDateTime(startAt);
    const end = parseZonedDateTime(endAt);
    if (schedule.status !== 'known' || start === null || end === null || end < start)
        return 'UNKNOWN';
    if (start < Date.parse(schedule.coverageStart) || end > Date.parse(schedule.coverageEnd))
        return 'UNKNOWN';
    return schedule.windows.some(
        (window) =>
            start >= Date.parse(window.opensAt) &&
            start < Date.parse(window.closesAt) &&
            end <= Date.parse(window.closesAt),
    )
        ? 'OPEN'
        : 'CLOSED';
}
