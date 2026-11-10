import type { JsonValue, RecommendationsRequest } from '../../lib/api/types';
import type { PlaceCandidate } from '../nearby-candidates';
import type { PlaceRelations } from '../place-relations';
import { destinationExclusion } from '../place-relations.ts';
import { candidateExperienceId } from '../candidate-access.ts';
import { candidateConditions, isBusinessClosed } from '../candidate-conditions.ts';
import { PUBLIC_EXTERIOR_ID } from '../exterior-access.ts';
import { hasSupportedCategory } from './experience.ts';

const MAX_DISCOVERED_CANDIDATES = 6;
const MAX_ROUTED_CANDIDATES = 4;

/** Apply exclusions before any paid detour route requests. Preserve source order and limits. */
export function selectRoutableCandidates(
    input: RecommendationsRequest,
    nearby: PlaceCandidate[],
    options: { calculatedAt: string; destinationRelations?: PlaceRelations },
    exclude: (
        reason: string,
        candidate?: PlaceCandidate,
        facts?: Record<string, JsonValue>,
    ) => void,
): PlaceCandidate[] {
    const excluded = new Set([...input.excludedPlaceIds, input.destination.placeId]);
    const eligible: PlaceCandidate[] = [];
    for (const candidate of nearby.slice(0, MAX_DISCOVERED_CANDIDATES)) {
        const id = candidate.place.placeId;
        if (excluded.has(id)) {
            exclude('EXCLUDED_OR_DUPLICATE', candidate);
            continue;
        }
        excluded.add(id);
        const related = destinationExclusion(
            { placeId: id, relations: candidate.relations },
            { placeId: input.destination.placeId, relations: options.destinationRelations },
            nearby.map((place) => ({
                placeId: place.place.placeId,
                relations: place.relations,
            })),
        );
        if (related) {
            exclude(related, candidate, { destinationRelationSource: 'google_places' });
            continue;
        }
        const { blockedReason: accessReason } = candidateConditions(
            candidate,
            input.destination.placeId,
            options.calculatedAt,
        );
        if (accessReason) {
            exclude(accessReason, candidate);
            continue;
        }
        if (isBusinessClosed(candidate)) {
            exclude('NOT_OPERATIONAL', candidate);
            continue;
        }
        if (
            candidate.opening.status === 'known' &&
            Date.parse(options.calculatedAt) >= Date.parse(candidate.opening.coverageStart) &&
            Date.parse(input.arriveBy) <= Date.parse(candidate.opening.coverageEnd) &&
            !candidate.opening.windows.some(
                (window) =>
                    Date.parse(window.closesAt) > Date.parse(options.calculatedAt) &&
                    Date.parse(window.opensAt) < Date.parse(input.arriveBy),
            )
        ) {
            exclude('CLOSED_FOR_WINDOW', candidate);
            continue;
        }
        if (!hasSupportedCategory(candidate)) {
            exclude('EXPERIENCE_UNKNOWN', candidate);
            continue;
        }
        eligible.push(candidate);
    }
    // Reserve two exterior evaluations where possible, so one failure can use a verified backup.
    const exterior = eligible.filter(
        (candidate) => candidateExperienceId(candidate) === PUBLIC_EXTERIOR_ID,
    );
    const others = eligible.filter(
        (candidate) => candidateExperienceId(candidate) !== PUBLIC_EXTERIOR_ID,
    );
    const ranked = [...exterior.slice(0, 2), ...others, ...exterior.slice(2)];
    const selected = ranked.slice(0, MAX_ROUTED_CANDIDATES);
    for (const candidate of ranked.slice(MAX_ROUTED_CANDIDATES)) exclude('SEARCH_LIMIT', candidate);
    return selected;
}
