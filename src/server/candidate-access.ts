import type { PlaceCandidate } from './nearby-candidates';
import { exteriorAccessReason, PUBLIC_EXTERIOR_ID } from './exterior-access.ts';
import { interiorAccessReason } from './interior-access.ts';
import { indoorProfileForId } from './experience-profiles.ts';

export function candidateExperienceId(candidate: PlaceCandidate): string {
    return (
        candidate.interiorAccessEvidence?.experienceId ??
        candidate.proposedExperienceId ??
        PUBLIC_EXTERIOR_ID
    );
}
export function supportedExperienceId(id: string): boolean {
    return id === PUBLIC_EXTERIOR_ID || indoorProfileForId(id) !== null;
}
export function candidateAccessReason(
    candidate: PlaceCandidate,
    destinationPlaceId: string,
    at: string,
    endAt = at,
    experienceId = candidateExperienceId(candidate),
): string | null {
    if (candidate.accessEvidence && candidate.interiorAccessEvidence)
        return 'ACCESS_CONTEXT_MISMATCH';
    if (experienceId !== candidateExperienceId(candidate)) return 'ACCESS_CONTEXT_MISMATCH';
    return experienceId === PUBLIC_EXTERIOR_ID
        ? exteriorAccessReason(
              candidate.accessEvidence,
              candidate.place.placeId,
              destinationPlaceId,
              at,
              endAt,
          )
        : interiorAccessReason(
              candidate.interiorAccessEvidence,
              candidate.place.placeId,
              destinationPlaceId,
              at,
              endAt,
          );
}
