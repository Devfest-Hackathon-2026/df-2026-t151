import type {
    ApiWarning,
    Attribution,
    RecommendationsRequest,
    RecommendationsResponse,
} from '../lib/api/types';
import { GoogleServiceError, upstreamUnavailable } from './google-http.ts';
import type { GoogleRequestOptions } from './google-http';
import { computeWalkingRoute } from './routes.ts';
import { validateRecommendationsRequest } from './request-validation.ts';
import { parseZonedDateTime } from './date-time.ts';

export type DirectJourneyInput = Pick<
    RecommendationsRequest,
    'origin' | 'destination' | 'arriveBy' | 'travelMode'
>;
export interface DirectJourneyResult {
    calculatedAt: string;
    arriveBy: string;
    /** Internal status; this is not the outcome of the recommendations API. */
    outcome: 'ON_TIME' | 'DIRECT_LATE';
    direct: RecommendationsResponse['direct'];
    route: {
        travelMode: 'WALK';
        distanceMeters: number;
        provider: 'Google Routes';
        retrievedAt: string;
    };
    slackSeconds: number;
    warnings: ApiWarning[];
    attributions: Attribution[];
}
interface DirectJourneyOptions extends GoogleRequestOptions {
    computeRoute?: typeof computeWalkingRoute;
    now?: () => Date;
    acceptedAt?: Date;
}

/** Internal building block for recommendations; it does not choose a detour or open a new API. */
export async function getDirectJourney(
    input: DirectJourneyInput,
    options: DirectJourneyOptions,
): Promise<DirectJourneyResult> {
    const now = options.now ?? (() => new Date());
    const startedAt = now();
    const validated = validateRecommendationsRequest(
        {
            ...input,
            requestId: 'internal-direct-journey',
            excludedPlaceIds: [],
        },
        { now: options.acceptedAt ?? startedAt, supportedTravelModes: ['WALK'] },
    );
    if (!validated.ok) {
        throw new GoogleServiceError(validated.status, validated.body.error.code, false);
    }
    const value = validated.value;
    const route = await (options.computeRoute ?? computeWalkingRoute)(
        {
            origin: value.origin,
            destination: value.destination,
            travelMode: value.travelMode,
        },
        {
            apiKey: options.apiKey,
            mapsAuthentication: options.mapsAuthentication,
            fetch: options.fetch,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
        },
    );

    // Do not backdate departure to before a potentially slow provider call.
    // A backwards wall-clock adjustment must not create extra available time.
    const finishedAtMs = now().getTime();
    if (!Number.isFinite(finishedAtMs)) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const calculatedAtMs = Math.max(startedAt.getTime(), finishedAtMs);
    if (!Number.isSafeInteger(route.durationSeconds) || route.durationSeconds < 0)
        throw upstreamUnavailable();
    const arrivalMs = calculatedAtMs + route.durationSeconds * 1000;
    if (!Number.isSafeInteger(arrivalMs) || !Number.isFinite(new Date(arrivalMs).getTime()))
        throw upstreamUnavailable();
    // Date format and a future deadline were already validated before the paid call.
    const arriveByMs = parseZonedDateTime(value.arriveBy)!;
    const calculatedAt = new Date(calculatedAtMs).toISOString();
    return {
        calculatedAt,
        arriveBy: value.arriveBy,
        outcome: arrivalMs <= arriveByMs ? 'ON_TIME' : 'DIRECT_LATE',
        direct: {
            durationSeconds: route.durationSeconds,
            arrivalAt: new Date(arrivalMs).toISOString(),
        },
        route: {
            travelMode: 'WALK',
            distanceMeters: route.distanceMeters,
            provider: route.provider,
            retrievedAt: calculatedAt,
        },
        slackSeconds: Math.floor((arriveByMs - arrivalMs) / 1000),
        warnings: route.warnings,
        attributions: route.attributions,
    };
}
