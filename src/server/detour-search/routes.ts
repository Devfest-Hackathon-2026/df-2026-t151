import type { RecommendationsRequest } from '../../lib/api/types';
import type { PlaceCandidate } from '../nearby-candidates';
import type { GoogleRequestOptions } from '../google-http';
import { RouteNotFoundError } from '../routes.ts';
import type { computeWalkingRoute } from '../routes';
import type { RoutedCandidate } from './types';

interface RouteCollectionOptions {
    connection: () => GoogleRequestOptions;
    computeRoute: typeof computeWalkingRoute;
    onEvaluate: () => void;
    exclude: (reason: string, candidate?: PlaceCandidate) => void;
}
/** One worker handles both legs of a candidate; at most two route calls run concurrently. */
export async function collectCandidateRoutes(
    input: RecommendationsRequest,
    selected: PlaceCandidate[],
    options: RouteCollectionOptions,
): Promise<RoutedCandidate[]> {
    const routePairs: RoutedCandidate[] = [];
    let cursor = 0;
    const worker = async () => {
        while (cursor < selected.length) {
            options.connection();
            const candidate = selected[cursor++];
            options.onEvaluate();
            try {
                const legToStop = await options.computeRoute(
                    {
                        origin: input.origin,
                        destination: { placeId: candidate.place.placeId },
                        travelMode: 'WALK',
                    },
                    options.connection(),
                );
                const legToDestination = await options.computeRoute(
                    {
                        origin: { placeId: candidate.place.placeId },
                        destination: input.destination,
                        travelMode: 'WALK',
                    },
                    options.connection(),
                );
                routePairs.push({ candidate, legToStop, legToDestination });
            } catch (error) {
                if (error instanceof RouteNotFoundError) {
                    options.exclude('NO_ROUTE', candidate);
                    continue;
                }
                throw error;
            }
        }
    };
    await Promise.all([worker(), worker()]);

    return routePairs;
}
