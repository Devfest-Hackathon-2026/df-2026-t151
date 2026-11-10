import type { RecommendationsRequest, RecommendationsResponse } from '../lib/api/types';
import { getDestination } from './place-details.ts';
import { findDetourCandidates } from './detour-search.ts';
import { issueOptionToken, hasSigningSecret } from './option-token.ts';
import { GoogleServiceError } from './google-http.ts';
import { uniqueAttributions, uniqueWarnings } from './candidate-assessment.ts';
import { withRequestBudget } from './request-budget.ts';
import type { BudgetOptions } from './request-budget';
import type { searchNearbyCandidates } from './nearby-candidates';
import { loadVisitForecasts } from './visit-forecasts.ts';
import { loadGroundedCandidates } from './grounded-candidates.ts';
import { vertexAuthentication } from './vertex-auth.ts';
import type { ApiWarning, Attribution } from '../lib/api/types';
import type { CandidateExclusion } from '../lib/api/types';

export interface PlannerServiceOptions extends BudgetOptions {
    signingSecret: string | undefined;
    now?: () => Date;
}
interface RecommendationOptions extends PlannerServiceOptions {
    getDestination?: typeof getDestination;
    findCandidates?: typeof findDetourCandidates;
    searchNearby?: typeof searchNearbyCandidates;
}
export async function getRecommendations(
    input: RecommendationsRequest,
    options: RecommendationOptions,
): Promise<RecommendationsResponse> {
    if (!hasSigningSecret(options.signingSecret))
        throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const vertex =
        options.vertexAuthentication === undefined
            ? vertexAuthentication()
            : options.vertexAuthentication;
    if (!options.searchNearby && !options.findCandidates && !vertex)
        throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const now = options.now ?? (() => new Date());
    const acceptedAt = now();
    return withRequestBudget({ ...options, vertexAuthentication: vertex }, async (scope) => {
        const destination = await (options.getDestination ?? getDestination)(
            input.destination.placeId,
            scope.connection(),
        );
        let aiWarnings: ApiWarning[] = [],
            aiAttributions: Attribution[] = [];
        let discoveryExclusions: CandidateExclusion[] = [];
        const search: typeof searchNearbyCandidates =
            options.searchNearby ??
            (async () => {
                const result = await loadGroundedCandidates(
                    { request: input, destination: destination.place },
                    {
                        connection: scope.connection,
                        remainingMs: scope.remainingMs,
                        now,
                    },
                );
                aiWarnings = result.warnings;
                aiAttributions = result.attributions;
                discoveryExclusions = result.exclusions ?? [];
                return result.candidates;
            });
        const found = await (options.findCandidates ?? findDetourCandidates)(input, {
            ...scope.connection(),
            now,
            acceptedAt,
            destinationRelations: destination.relations,
            searchNearby: search,
            workTimeoutMs: scope.remainingMs(),
            loadWeather: (candidates) =>
                loadVisitForecasts(
                    candidates.map((option) => ({
                        place: option.place,
                        visitAt: option.time.experienceStartAt,
                    })),
                    { ...scope, now },
                ),
        });
        return {
            requestId: input.requestId,
            exclusions: [...discoveryExclusions, ...found.diagnostics.exclusions],
            dataMode: 'live',
            calculatedAt: found.calculatedAt,
            arriveBy: found.arriveBy,
            destination: destination.place,
            outcome: found.outcome,
            direct: found.direct,
            context: found.context,
            options: found.options.map((option) => ({
                ...option,
                ...issueOptionToken(
                    input,
                    { placeId: option.place.placeId, experienceId: option.experienceId },
                    options.signingSecret,
                    Date.parse(found.calculatedAt),
                ),
            })),
            warnings: uniqueWarnings([...found.warnings, ...aiWarnings]),
            attributions: uniqueAttributions([
                ...destination.attributions,
                ...found.attributions,
                ...aiAttributions,
            ]),
        };
    });
}
