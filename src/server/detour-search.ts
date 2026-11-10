import type { CandidateForecast } from './visit-forecasts';
import { candidateExclusion } from './candidate-diagnostics.ts';
import type { PlaceCandidate } from './nearby-candidates';
import type { JsonValue } from '../lib/api/types';
import { collectCandidateRoutes } from './detour-search/routes.ts';
import {
    createSearchResult,
    refreshDirectEstimate,
    appendAssessedOptions,
    finalizeSearchResult,
} from './detour-search/results.ts';
import type { RecommendationsRequest } from '../lib/api/types';
import { GoogleServiceError } from './google-http.ts';
import type { GoogleRequestOptions } from './google-http';
import { getDirectJourney } from './direct-journey.ts';
import { computeWalkingRoute } from './routes.ts';
import { searchNearbyCandidates } from './nearby-candidates.ts';
import { validateRecommendationsRequest } from './request-validation.ts';
import { selectRoutableCandidates } from './detour-search/selection.ts';
import type { DetourSearchResult, SearchOptions } from './detour-search/types';
export type { DetourSearchResult } from './detour-search/types';
export { exteriorExperience } from './detour-search/experience.ts';

/** Bounded internal workflow. Signing tokens and exposing an HTTP response are separate. */
export async function findDetourCandidates(
    input: RecommendationsRequest,
    options: SearchOptions,
): Promise<DetourSearchResult> {
    const now = options.now ?? (() => new Date());
    const startedAt = now();
    const validated = validateRecommendationsRequest(input, {
        now: options.acceptedAt ?? startedAt,
        supportedTravelModes: ['WALK'],
    });
    if (!validated.ok)
        throw new GoogleServiceError(validated.status, validated.body.error.code, false);
    const request = validated.value;
    const bufferSeconds = options.bufferSeconds ?? 600;
    const radiusMeters = options.radiusMeters ?? 3000;
    const workTimeoutMs = options.workTimeoutMs ?? 30000;
    if (
        !Number.isSafeInteger(bufferSeconds) ||
        bufferSeconds < 0 ||
        bufferSeconds > 3600 ||
        !Number.isSafeInteger(radiusMeters) ||
        radiusMeters < 1 ||
        radiusMeters > 3000 ||
        !Number.isSafeInteger(workTimeoutMs) ||
        workTimeoutMs < 1 ||
        workTimeoutMs > 30000 ||
        (options.durationEvidence?.length ?? 0) > 1000
    )
        throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const controller = new AbortController();
    const externalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const startedMonotonic = performance.now();
    let stopped = false;
    const connection = (): GoogleRequestOptions => {
        const remaining = workTimeoutMs - (performance.now() - startedMonotonic);
        if (stopped || controller.signal.aborted || remaining <= 0)
            throw new GoogleServiceError(504, 'TIMEOUT', true);
        return {
            apiKey: options.apiKey,
            mapsAuthentication: options.mapsAuthentication,
            fetch: options.fetch,
            timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 5000, Math.ceil(remaining))),
            signal: controller.signal,
        };
    };
    const callRoute: typeof computeWalkingRoute = async (request) =>
        (options.computeRoute ?? computeWalkingRoute)(request, connection());
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new GoogleServiceError(504, 'TIMEOUT', true));
        }, workTimeoutMs);
    });
    const run = async (): Promise<DetourSearchResult> => {
        connection();
        const direct = await getDirectJourney(request, {
            ...connection(),
            now,
            acceptedAt: options.acceptedAt ?? startedAt,
            computeRoute: callRoute,
        });
        const result = createSearchResult(request, direct);
        if (
            result.outcome === 'DIRECT_LATE' ||
            Date.parse(result.direct.arrivalAt) + bufferSeconds * 1000 >
                Date.parse(request.arriveBy)
        )
            return result;
        const nearby = await (options.searchNearby ?? searchNearbyCandidates)(request.origin, {
            ...connection(),
            now,
            radiusMeters,
        });
        result.diagnostics.discoveredCount = nearby.length;
        // Discovery may obtain newer evidence. Never assess it against the earlier direct-route clock.
        refreshDirectEstimate(
            result,
            now().getTime(),
            Math.max(startedAt.getTime(), Date.parse(result.calculatedAt)),
        );
        if (Date.parse(result.direct.arrivalAt) > Date.parse(request.arriveBy)) {
            result.outcome = 'DIRECT_LATE';
            return result;
        }
        const exclude = (
            reason: string,
            candidate?: PlaceCandidate,
            facts?: Record<string, JsonValue>,
        ) => {
            result.diagnostics.excludedCounts[reason] =
                (result.diagnostics.excludedCounts[reason] ?? 0) + 1;
            result.diagnostics.exclusions.push(
                candidateExclusion(reason, candidate, 'candidate-selection', facts),
            );
        };
        const selected = selectRoutableCandidates(
            request,
            nearby,
            {
                calculatedAt: result.calculatedAt,
                destinationRelations: options.destinationRelations,
            },
            exclude,
        );
        const routePairs = await collectCandidateRoutes(request, selected, {
            connection,
            computeRoute: callRoute,
            exclude,
            onEvaluate: () => {
                result.diagnostics.evaluatedCount++;
            },
        });
        connection();
        refreshDirectEstimate(
            result,
            now().getTime(),
            Math.max(startedAt.getTime(), Date.parse(direct.calculatedAt)),
        );
        if (Date.parse(result.direct.arrivalAt) > Date.parse(request.arriveBy)) {
            result.outcome = 'DIRECT_LATE';
            return result;
        }
        let forecasts: CandidateForecast[] | undefined;
        if (options.loadWeather && routePairs.length) {
            const preview = { ...result, options: [], attributions: [] };
            appendAssessedOptions(request, routePairs, preview, {
                durationEvidence: options.durationEvidence,
                bufferSeconds,
                exclude: () => {},
            });
            forecasts = await options.loadWeather(preview.options);
            connection();
            refreshDirectEstimate(
                result,
                now().getTime(),
                Math.max(startedAt.getTime(), Date.parse(result.calculatedAt)),
            );
            if (Date.parse(result.direct.arrivalAt) > Date.parse(request.arriveBy)) {
                result.outcome = 'DIRECT_LATE';
                return result;
            }
        }
        appendAssessedOptions(request, routePairs, result, {
            durationEvidence: options.durationEvidence,
            bufferSeconds,
            exclude,
        });
        return finalizeSearchResult(result, forecasts);
    };
    try {
        return await Promise.race([run(), timeout]);
    } finally {
        stopped = true;
        clearTimeout(timer!);
        controller.abort();
        options.signal?.removeEventListener('abort', externalAbort);
    }
}
