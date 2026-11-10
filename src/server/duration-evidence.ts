import type { ExperienceDuration } from '../lib/api/types';
import { parseZonedDateTime } from './date-time.ts';

export interface DurationEvidence {
    placeId: string;
    experienceId: string;
    duration: ExperienceDuration;
    validFrom: string;
    validUntil: string;
    conditionsMatched: boolean;
}
const priority = { registered: 0, official: 1, external_statistics: 2, estimate: 3 } as const;

/** Producers must verify applicability; a place name alone is never an identity match. */
export function selectExperienceDuration(
    evidence: readonly DurationEvidence[],
    context: { placeId: string; experienceId: string; visitStartAt: string; referenceAt: string },
): ExperienceDuration | null {
    const visit = parseZonedDateTime(context.visitStartAt);
    const reference = parseZonedDateTime(context.referenceAt);
    if (visit === null || reference === null || evidence.length > 64) return null;
    const usable = evidence.filter((item) => {
        if (
            item.placeId !== context.placeId ||
            item.experienceId !== context.experienceId ||
            item.conditionsMatched !== true
        )
            return false;
        const duration = item.duration;
        if (
            !duration ||
            !Object.hasOwn(priority, duration.sourceType) ||
            !Number.isSafeInteger(duration.minSeconds) ||
            duration.minSeconds < 0 ||
            !Number.isSafeInteger(duration.maxSeconds) ||
            duration.maxSeconds <= 0 ||
            duration.minSeconds > duration.maxSeconds ||
            ![true, false, null].includes(duration.includesWait) ||
            typeof duration.conditions !== 'string' ||
            !duration.conditions.trim() ||
            duration.conditions.length > 2000
        )
            return false;
        const checked = parseZonedDateTime(duration.checkedAt);
        const from = parseZonedDateTime(item.validFrom);
        const until = parseZonedDateTime(item.validUntil);
        if (
            checked === null ||
            checked > reference ||
            from === null ||
            until === null ||
            until <= from ||
            visit < from ||
            visit + duration.maxSeconds * 1000 > until
        )
            return false;
        if (duration.sourceUrl === null)
            return duration.sourceType === 'estimate' || duration.sourceType === 'registered';
        try {
            const url = new URL(duration.sourceUrl);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
        } catch {
            return false;
        }
    });
    usable.sort(
        (a, b) =>
            priority[a.duration.sourceType] - priority[b.duration.sourceType] ||
            Date.parse(b.duration.checkedAt) - Date.parse(a.duration.checkedAt),
    );
    return usable[0] ? { ...usable[0].duration } : null;
}
