import { parseZonedDateTime } from './date-time.ts';

export interface SourcedAccessEvidence {
    placeId: string;
    destinationPlaceId: string;
    experienceId: string;
    outsideDestination: boolean | null;
    sourceUrl: string;
    provider: 'registered' | 'grounded_maps';
    checkedAt: string;
    validUntil: string;
    conditions: string;
}

/** Shared provenance and freshness checks; each experience must also validate its own conditions. */
export function sourcedAccessReason(
    evidence: SourcedAccessEvidence | undefined,
    placeId: string,
    destinationPlaceId: string,
    experienceId: string,
    at: string,
    endAt = at,
): string | null {
    if (!evidence) return 'ACCESS_UNKNOWN';
    if (
        evidence.placeId !== placeId ||
        evidence.destinationPlaceId !== destinationPlaceId ||
        evidence.experienceId !== experienceId
    )
        return 'ACCESS_CONTEXT_MISMATCH';
    const now = parseZonedDateTime(at),
        end = parseZonedDateTime(endAt);
    const checked = parseZonedDateTime(evidence.checkedAt),
        until = parseZonedDateTime(evidence.validUntil);
    if (
        now === null ||
        end === null ||
        end < now ||
        checked === null ||
        checked > now ||
        now - checked > 15 * 60000 ||
        until === null ||
        until < end ||
        until <= checked
    )
        return 'ACCESS_STALE';
    if (
        !['registered', 'grounded_maps'].includes(evidence.provider) ||
        typeof evidence.sourceUrl !== 'string' ||
        evidence.sourceUrl.length > 2048 ||
        typeof evidence.conditions !== 'string' ||
        !evidence.conditions.trim() ||
        evidence.conditions.length > 2000
    )
        return 'ACCESS_UNKNOWN';
    try {
        const url = new URL(evidence.sourceUrl);
        if (url.protocol !== 'https:' || url.username || url.password) return 'ACCESS_UNKNOWN';
    } catch {
        return 'ACCESS_UNKNOWN';
    }
    // A model can confuse being indoors with being inside the requested destination.
    if (evidence.outsideDestination === false && evidence.provider === 'registered')
        return 'DESTINATION_INTERIOR';
    if (evidence.outsideDestination !== true) return 'DESTINATION_RELATION_UNKNOWN';
    return null;
}
