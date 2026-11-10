import { sourcedAccessReason } from './access-evidence.ts';
import type { SourcedAccessEvidence } from './access-evidence';
import { indoorProfileForId } from './experience-profiles.ts';
import type { IndoorExperienceId } from './experience-profiles';
import { parseZonedDateTime } from './date-time.ts';

export interface InteriorAccessEvidence extends SourcedAccessEvidence {
    experienceId: IndoorExperienceId;
    indoorConfirmed: boolean | null;
    walkInAllowed: boolean | null;
    noFixedStart: boolean | null;
    smallExhibition: boolean | null;
    admissionRequired: boolean | null;
    /** Explicitly sourced admission/order deadline, or evidence that no separate cutoff applies. */
    entryCutoff: 'none' | 'known' | null;
    lastEntryAt: string | null;
}

export function interiorAccessReason(
    evidence: InteriorAccessEvidence | undefined,
    placeId: string,
    destinationPlaceId: string,
    at: string,
    endAt = at,
): string | null {
    if (!evidence) return 'ACCESS_UNKNOWN';
    const profile = indoorProfileForId(evidence.experienceId);
    if (!profile) return 'EXPERIENCE_UNKNOWN';
    const reason = sourcedAccessReason(
        evidence,
        placeId,
        destinationPlaceId,
        profile.experienceId,
        at,
        endAt,
    );
    if (reason) return reason;
    if (evidence.indoorConfirmed !== true) return 'ACCESS_INDOOR_UNKNOWN';
    if (evidence.walkInAllowed !== true || evidence.noFixedStart !== true)
        return 'ACCESS_RESERVATION_REQUIRED';
    if (typeof evidence.admissionRequired !== 'boolean') return 'ACCESS_ADMISSION_UNKNOWN';
    if (profile.experienceId === 'small-exhibit-v1' && evidence.smallExhibition !== true)
        return 'EXPERIENCE_UNKNOWN';
    if (evidence.entryCutoff === 'known') {
        if (parseZonedDateTime(evidence.lastEntryAt) === null) return 'LAST_ENTRY_UNKNOWN';
    } else if (evidence.entryCutoff !== 'none' || evidence.lastEntryAt !== null)
        return 'LAST_ENTRY_UNKNOWN';
    return null;
}
