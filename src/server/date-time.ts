// Date.parse alone accepts impossible dates such as February 30 by rolling over.
const ZONED_DATE_TIME =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/** ISO date-time with seconds and an explicit zone; never uses the host timezone. */
export function parseZonedDateTime(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const match = ZONED_DATE_TIME.exec(value);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = Number(match[10] ?? 0);
    const offsetMinute = Number(match[11] ?? 0);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    if (
        year < 1 ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > monthDays[month - 1] ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        offsetHour > 23 ||
        offsetMinute > 59
    )
        return null;

    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}
