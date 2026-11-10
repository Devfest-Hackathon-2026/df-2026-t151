import type { CandidateForecast } from '../visit-forecasts';
import type { PlaceCandidate } from '../nearby-candidates';
import type { WalkingRoute } from '../routes';
import type {
    ApiWarning,
    Attribution,
    RecommendationsResponse,
    CandidateExclusion,
    JsonValue,
} from '../../lib/api/types';
import type { GoogleRequestOptions } from '../google-http';
import type { UnsignedRecommendationOption } from '../candidate-assessment';
import type { DurationEvidence } from '../duration-evidence';
import type { PlaceRelations } from '../place-relations';
import type { searchNearbyCandidates } from '../nearby-candidates';
import type { computeWalkingRoute } from '../routes';
export interface DetourSearchResult {
    requestId: string;
    calculatedAt: string;
    arriveBy: string;
    outcome: RecommendationsResponse['outcome'];
    direct: RecommendationsResponse['direct'];
    context: RecommendationsResponse['context'];
    options: UnsignedRecommendationOption[];
    warnings: ApiWarning[];
    attributions: Attribution[];
    diagnostics: {
        discoveredCount: number;
        evaluatedCount: number;
        excludedCounts: Record<string, number>;
        exclusions: CandidateExclusion[];
    };
}
export interface SearchOptions extends GoogleRequestOptions {
    loadWeather?: (
        options: readonly UnsignedRecommendationOption[],
    ) => Promise<CandidateForecast[]>;
    now?: () => Date;
    acceptedAt?: Date;
    destinationRelations?: PlaceRelations;
    searchNearby?: typeof searchNearbyCandidates;
    computeRoute?: typeof computeWalkingRoute;
    radiusMeters?: number;
    bufferSeconds?: number;
    durationEvidence?: readonly DurationEvidence[];
    workTimeoutMs?: number;
}

export interface RoutedCandidate {
    candidate: PlaceCandidate;
    legToStop: WalkingRoute;
    legToDestination: WalkingRoute;
}
