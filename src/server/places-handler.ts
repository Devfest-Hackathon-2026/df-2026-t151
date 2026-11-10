import type { ApiErrorCode, ApiErrorResponse, PlacesResponse } from '../lib/api/types';
import { PlacesServiceError, searchPlaces } from './places.ts';
import { validatePlacesQuery } from './request-validation.ts';
import { createCookieRateLimiter, cookieLimitResponse } from './cookie-rate-limit.ts';

interface HandlerDependencies {
    search?: typeof searchPlaces;
    getApiKey?: () => string | undefined;
    now?: () => number;
    cookieLimiter?: ReturnType<typeof createCookieRateLimiter>;
}

function json(
    body: PlacesResponse | ApiErrorResponse,
    status = 200,
    retryAfter?: number,
): Response {
    const headers: Record<string, string> = {
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
    };
    if (retryAfter !== undefined) headers['Retry-After'] = String(retryAfter);
    return Response.json(body, { status, headers });
}

function errorResponse(
    requestId: string,
    status: number,
    code: ApiErrorCode,
    retryable: boolean,
    field: string | null = null,
    retryAfter?: number,
): Response {
    const messages: Record<ApiErrorCode, string> = {
        INVALID_INPUT: '検索条件を確認してください',
        UNSUPPORTED_MODE: 'この移動方法は現在対応していません',
        OUT_OF_AREA: '現在の対応エリアを確認してください',
        RATE_LIMITED: '場所検索が混み合っています。少し待って再試行してください',
        UPSTREAM_UNAVAILABLE: '場所の情報を取得できませんでした',
        TIMEOUT: '場所検索に時間がかかっています。再試行してください',
        INTERNAL_ERROR: '場所検索を実行できませんでした',
    };
    return json(
        { requestId, error: { code, message: messages[code], field, retryable } },
        status,
        retryAfter,
    );
}

/** Limits are shared by all requests to this handler instance; no IP or query history is kept. */
export function createPlacesHandler(
    dependencies: HandlerDependencies = {},
): (request: Request) => Promise<Response> {
    const search = dependencies.search ?? searchPlaces;
    const getApiKey = dependencies.getApiKey ?? (() => process.env.GOOGLE_MAPS_API_KEY);
    const now = dependencies.now ?? Date.now;
    const cookieLimiter = dependencies.cookieLimiter ?? createCookieRateLimiter({ now });
    let windowStart = now();
    let count = 0;
    let inFlight = 0;

    return async (request: Request): Promise<Response> => {
        // Bounds parsing work. Field limits below are tighter than this URL limit.
        if (new TextEncoder().encode(request.url).byteLength > 4096) {
            return errorResponse('', 400, 'INVALID_INPUT', false);
        }
        const params = new URL(request.url).searchParams;
        if (params.getAll('requestId').length > 1) {
            return errorResponse('', 400, 'INVALID_INPUT', false, 'requestId');
        }
        const validated = validatePlacesQuery({
            requestId: params.get('requestId'),
            query: params.get('query'),
        });
        if (!validated.ok) return json(validated.body, validated.status);
        const { requestId, query } = validated.value;
        if (params.getAll('query').length > 1) {
            return errorResponse(requestId, 400, 'INVALID_INPUT', false, 'query');
        }

        const allowance = cookieLimiter.check(request, 'places');
        const respond = allowance.apply;
        const limited = cookieLimitResponse(allowance, requestId);
        if (limited) return respond(limited);
        const currentTime = now();
        if (currentTime - windowStart >= 60000 || currentTime < windowStart) {
            windowStart = currentTime;
            count = 0;
        }
        if (count >= 6000) {
            return respond(
                errorResponse(
                    requestId,
                    429,
                    'RATE_LIMITED',
                    true,
                    null,
                    Math.max(1, Math.ceil((windowStart + 60000 - currentTime) / 1000)),
                ),
            );
        }
        if (inFlight >= 4)
            return respond(errorResponse(requestId, 429, 'RATE_LIMITED', true, null, 1));
        count++;
        inFlight++;
        try {
            const result = await search(query, { apiKey: getApiKey() });
            return respond(
                json({ requestId, places: result.places, attributions: result.attributions }),
            );
        } catch (error) {
            if (error instanceof PlacesServiceError) {
                return respond(
                    errorResponse(
                        requestId,
                        error.status,
                        error.code,
                        error.retryable,
                        null,
                        error.status === 429 ? 60 : undefined,
                    ),
                );
            }
            return respond(errorResponse(requestId, 500, 'INTERNAL_ERROR', false));
        } finally {
            inFlight--;
        }
    };
}
