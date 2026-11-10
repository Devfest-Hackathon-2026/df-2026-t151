import { sourcedAccessReason } from './access-evidence.ts';
import type { SourcedAccessEvidence } from './access-evidence';

export const PUBLIC_EXTERIOR_ID = 'public-exterior-v2';
export interface ExteriorAccessEvidence extends SourcedAccessEvidence {
    experienceId: typeof PUBLIC_EXTERIOR_ID;
    publicExteriorWithoutAdmission: boolean | null;
}

/** Producers must supply sourced access information, not infer it from a category or route. */
export function exteriorAccessReason(
    evidence: ExteriorAccessEvidence | undefined,
    placeId: string,
    destinationPlaceId: string,
    at: string,
    endAt = at,
): string | null {
    const reason = sourcedAccessReason(
        evidence,
        placeId,
        destinationPlaceId,
        PUBLIC_EXTERIOR_ID,
        at,
        endAt,
    );
    if (reason) return reason;
    if (evidence?.publicExteriorWithoutAdmission === false) return 'ADMISSION_REQUIRED';
    if (evidence?.publicExteriorWithoutAdmission !== true) return 'ACCESS_UNKNOWN';
    return null;
}
