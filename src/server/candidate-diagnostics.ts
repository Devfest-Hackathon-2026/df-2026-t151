import type { CandidateExclusion, JsonValue } from '../lib/api/types';
import type { PlaceCandidate } from './nearby-candidates';

/** Explicit allowlist: never serialize coordinates, request bodies, tokens or raw upstream data. */
export function candidateExclusion(
    reason: string,
    candidate?: PlaceCandidate,
    stage = 'candidate-selection',
    facts: Record<string, JsonValue> = {},
): CandidateExclusion {
    const access = candidate?.interiorAccessEvidence ?? candidate?.accessEvidence;
    const usesPlaceRelations = facts.destinationRelationSource === 'google_places';
    const isAccess =
        !usesPlaceRelations &&
        /ACCESS|ADMISSION|DESTINATION|EXPERIENCE|EXHIBITION|LAST_ENTRY/.test(reason);
    const provider = /TIME_LIMIT|INCONSISTENT_ROUTE|DIRECT_LATE/.test(reason)
        ? '時間計算（Google Routes・体験時間・余裕）'
        : reason === 'NO_ROUTE'
          ? 'Google Routes'
          : reason === 'WEATHER_UNSUITABLE'
            ? 'Google Weather'
            : isAccess
              ? 'Google Maps / 利用条件'
              : 'Google Places';
    return {
        stage,
        placeLabel: candidate?.place.label ?? '検索全体',
        reason,
        source: {
            provider,
            url: isAccess
                ? (access?.sourceUrl ?? candidate?.sourceUrl ?? null)
                : (candidate?.sourceUrl ?? null),
        },
        facts: {
            ...(candidate && {
                businessStatus: candidate.businessStatus,
                openingStatus: candidate.opening.status,
                types: candidate.types,
            }),
            ...(candidate?.opening.status === 'known' && {
                openingWindows: candidate.opening.windows.map((w) => ({
                    opensAt: w.opensAt,
                    closesAt: w.closesAt,
                })),
            }),
            ...(access &&
                (isAccess || usesPlaceRelations) && {
                    outsideDestination: access.outsideDestination,
                    outsideDestinationSource: access.provider,
                }),
            ...(access && isAccess && { experienceId: access.experienceId }),
            ...(candidate?.interiorAccessEvidence &&
                isAccess && {
                    indoorConfirmed: candidate.interiorAccessEvidence.indoorConfirmed,
                    walkInAllowed: candidate.interiorAccessEvidence.walkInAllowed,
                    noFixedStart: candidate.interiorAccessEvidence.noFixedStart,
                    smallExhibition: candidate.interiorAccessEvidence.smallExhibition,
                    admissionRequired: candidate.interiorAccessEvidence.admissionRequired,
                    entryCutoff: candidate.interiorAccessEvidence.entryCutoff,
                    lastEntryAt: candidate.interiorAccessEvidence.lastEntryAt,
                }),
            ...(candidate?.accessEvidence &&
                isAccess && {
                    publicExteriorWithoutAdmission:
                        candidate.accessEvidence.publicExteriorWithoutAdmission,
                }),
            ...facts,
        },
    };
}
