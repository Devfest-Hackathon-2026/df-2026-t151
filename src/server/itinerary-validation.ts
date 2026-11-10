import { loadVisitForecasts } from './visit-forecasts.ts';
import { selectForWeather } from './weather-selection.ts';
import type {
    ApiWarning,
    Attribution,
    ValidateItineraryRequest,
    ValidateItineraryResponse,
} from '../lib/api/types';
import { verifyOptionToken, issueOptionToken } from './option-token.ts';
import { getCandidateDetails, getDestination } from './place-details.ts';
import { destinationExclusion } from './place-relations.ts';
import { getDirectJourney } from './direct-journey.ts';
import { computeWalkingRoute, RouteNotFoundError } from './routes.ts';
import { createCandidateExperience } from './detour-search/experience.ts';
import { assessCandidate, uniqueAttributions, uniqueWarnings } from './candidate-assessment.ts';
import { withRequestBudget } from './request-budget.ts';
import type { PlannerServiceOptions } from './recommendations';
import { GoogleServiceError } from './google-http.ts';
import { candidateAccessReason, supportedExperienceId } from './candidate-access.ts';
import { waitUpperSeconds } from './time-budget.ts';
import { refreshGroundedCandidate } from './grounded-candidates.ts';
import { vertexAuthentication } from './vertex-auth.ts';
import { candidateConditions, isBusinessClosed } from './candidate-conditions.ts';
import { candidateExclusion } from './candidate-diagnostics.ts';
import type { PlaceCandidate } from './nearby-candidates';
import type { CandidateExclusion } from '../lib/api/types';
import type { JsonValue } from '../lib/api/types';

interface ItineraryOptions extends PlannerServiceOptions {
    getCandidate?: typeof getCandidateDetails;
    getDestination?: typeof getDestination;
    computeRoute?: typeof computeWalkingRoute;
}
export async function revalidateItinerary(
    input: ValidateItineraryRequest,
    options: ItineraryOptions,
): Promise<ValidateItineraryResponse> {
    const now = options.now ?? (() => new Date());
    const acceptedAt = now();
    const token = verifyOptionToken(input, options.signingSecret, acceptedAt.getTime());
    let attributions: Attribution[] = [];
    let warnings: ApiWarning[] = [];
    let diagnosticCandidate: PlaceCandidate | undefined;
    const exclusions: CandidateExclusion[] = [];
    let diagnosticFacts: Record<string, JsonValue> = {};
    const negative = (
        status: 'EXPIRED' | 'NO_LONGER_FEASIBLE',
        reason: string,
        calculatedAt = now().toISOString(),
    ): ValidateItineraryResponse => {
        const at = Math.max(acceptedAt.getTime(), Date.parse(calculatedAt));
        if (verifyOptionToken(input, options.signingSecret, at).status === 'expired') {
            status = 'EXPIRED';
            reason = 'OPTION_EXPIRED';
        }
        return {
            requestId: input.requestId,
            exclusions: [
                ...exclusions,
                candidateExclusion(
                    reason,
                    diagnosticCandidate,
                    'itinerary-validation',
                    diagnosticFacts,
                ),
            ],
            status,
            option: null,
            calculatedAt: new Date(at).toISOString(),
            attributions: uniqueAttributions(attributions),
            warnings: uniqueWarnings([
                ...warnings,
                {
                    code: reason,
                    message:
                        status === 'EXPIRED'
                            ? '候補の有効期限を過ぎました。条件を確認して検索し直してください'
                            : '選択した寄り道は現在の時間・営業・天候条件では利用できません。検索し直すか直行を選んでください',
                },
            ]),
        };
    };
    if (token.status === 'expired') return negative('EXPIRED', 'OPTION_EXPIRED');
    if (
        input.excludedPlaceIds.includes(input.selectedPlaceId) ||
        input.destination.placeId === input.selectedPlaceId
    )
        return negative('NO_LONGER_FEASIBLE', 'PLACE_EXCLUDED');
    if (!supportedExperienceId(input.experienceId))
        return negative('NO_LONGER_FEASIBLE', 'EXPERIENCE_UNSUPPORTED');
    const vertex =
        options.vertexAuthentication === undefined
            ? vertexAuthentication()
            : options.vertexAuthentication;
    if (!options.getCandidate && !vertex)
        throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    return withRequestBudget({ ...options, vertexAuthentication: vertex }, async (scope) => {
        let candidate = await (options.getCandidate ?? getCandidateDetails)(input.selectedPlaceId, {
            ...scope.connection(),
            now,
        });
        candidate = { ...candidate, proposedExperienceId: input.experienceId };
        diagnosticCandidate = candidate;
        attributions = [...candidate.attributions];
        if (isBusinessClosed(candidate)) return negative('NO_LONGER_FEASIBLE', 'NOT_OPERATIONAL');
        const destination = await (options.getDestination ?? getDestination)(
            input.destination.placeId,
            scope.connection(),
        );
        attributions.push(...destination.attributions);
        const related = destinationExclusion(
            { placeId: candidate.place.placeId, relations: candidate.relations },
            { placeId: destination.place.placeId, relations: destination.relations },
        );
        if (related) {
            diagnosticFacts = { destinationRelationSource: 'google_places' };
            return negative('NO_LONGER_FEASIBLE', related);
        }
        if (
            candidateAccessReason(
                candidate,
                input.destination.placeId,
                now().toISOString(),
                undefined,
                input.experienceId,
            ) &&
            vertex
        ) {
            const refreshed = await refreshGroundedCandidate(
                candidate,
                {
                    request: input,
                    destination: destination.place,
                    selectedExperienceId: input.experienceId,
                },
                {
                    connection: scope.connection,
                    remainingMs: scope.remainingMs,
                    now,
                },
            );
            candidate = refreshed.candidate;
            diagnosticCandidate = candidate;
            warnings.push(...refreshed.warnings);
            attributions.push(...refreshed.attributions);
            exclusions.push(...refreshed.exclusions);
        }
        const { blockedReason: accessReason } = candidateConditions(
            candidate,
            input.destination.placeId,
            now().toISOString(),
            undefined,
            input.experienceId,
        );
        if (accessReason) return negative('NO_LONGER_FEASIBLE', accessReason);
        const direct = await getDirectJourney(input, {
            ...scope.connection(),
            now,
            acceptedAt,
            computeRoute: options.computeRoute,
        });
        warnings.push(...direct.warnings);
        attributions.push(...direct.attributions);
        if (direct.outcome === 'DIRECT_LATE')
            return negative('NO_LONGER_FEASIBLE', 'DIRECT_LATE', direct.calculatedAt);
        const computeRoute = options.computeRoute ?? computeWalkingRoute;
        try {
            const first = await computeRoute(
                {
                    origin: input.origin,
                    destination: { placeId: input.selectedPlaceId },
                    travelMode: 'WALK',
                },
                scope.connection(),
            );
            const second = await computeRoute(
                {
                    origin: { placeId: input.selectedPlaceId },
                    destination: input.destination,
                    travelMode: 'WALK',
                },
                scope.connection(),
            );
            const forecastBaseMs = now().getTime();
            if (!Number.isFinite(forecastBaseMs))
                throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
            const previewExperience = createCandidateExperience(
                candidate,
                new Date(forecastBaseMs).toISOString(),
                [],
                input.destination.placeId,
            );
            if (!previewExperience || previewExperience.experienceId !== input.experienceId)
                return negative('NO_LONGER_FEASIBLE', 'EXPERIENCE_UNSUPPORTED');
            const forecasts = await loadVisitForecasts(
                [
                    {
                        place: candidate.place,
                        visitAt: new Date(
                            Math.max(
                                acceptedAt.getTime(),
                                Date.parse(direct.calculatedAt),
                                forecastBaseMs,
                            ) +
                                (first.durationSeconds + waitUpperSeconds(previewExperience.wait)) *
                                    1000,
                        ).toISOString(),
                    },
                ],
                { ...scope, now },
            );
            scope.remainingMs();
            const current = now().getTime();
            if (!Number.isFinite(current))
                throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
            const calculatedAtMs = Math.max(
                acceptedAt.getTime(),
                Date.parse(direct.calculatedAt),
                current,
            );
            const calculatedAt = new Date(calculatedAtMs).toISOString();
            if (
                verifyOptionToken(input, options.signingSecret, calculatedAtMs).status === 'expired'
            )
                return negative('EXPIRED', 'OPTION_EXPIRED', calculatedAt);
            const experience = createCandidateExperience(
                candidate,
                calculatedAt,
                [],
                input.destination.placeId,
            );
            if (!experience || experience.experienceId !== input.experienceId)
                return negative('NO_LONGER_FEASIBLE', 'EXPERIENCE_UNSUPPORTED', calculatedAt);
            const assessment = assessCandidate({
                candidate,
                experience,
                calculatedAt,
                arriveBy: input.arriveBy,
                directSeconds: direct.direct.durationSeconds,
                legToStop: first,
                legToDestination: second,
                bufferSeconds: 600,
            });
            if (!assessment.eligible) {
                diagnosticFacts = assessment.facts;
                return negative('NO_LONGER_FEASIBLE', assessment.reason, calculatedAt);
            }
            const selection = selectForWeather([assessment.option], forecasts);
            warnings.push(...selection.warnings);
            attributions.push(...selection.attributions);
            if (!selection.options.length)
                return negative('NO_LONGER_FEASIBLE', 'WEATHER_UNSUITABLE', calculatedAt);
            const option = {
                ...selection.options[0],
                ...issueOptionToken(
                    input,
                    { placeId: input.selectedPlaceId, experienceId: input.experienceId },
                    options.signingSecret,
                    calculatedAtMs,
                ),
            };
            return {
                requestId: input.requestId,
                exclusions,
                status: 'VALID',
                calculatedAt,
                option,
                warnings: uniqueWarnings([...warnings, ...option.warnings]),
                attributions: uniqueAttributions([...attributions, ...assessment.attributions]),
            };
        } catch (error) {
            if (error instanceof RouteNotFoundError)
                return negative('NO_LONGER_FEASIBLE', 'NO_ROUTE');
            throw error;
        }
    });
}
