import type {
    ApiErrorCode,
    ApiErrorResponse,
    RecommendationsResponse,
    ValidateItineraryResponse,
} from '../lib/api/types';
import type { ValidationOptions, ValidationResult } from './request-validation';
import type { PlannerServiceOptions } from './recommendations';
import { GoogleServiceError } from './google-http.ts';
import { vertexAuthentication } from './vertex-auth.ts';
import type { VertexAuthentication } from './vertex-auth';
import { createCookieRateLimiter, cookieLimitResponse } from './cookie-rate-limit.ts';
import type { CookieLimitOperation } from './cookie-rate-limit';

type Payload = RecommendationsResponse | ValidateItineraryResponse;
interface Dependencies<T> {
    execute: (input: T, options: PlannerServiceOptions) => Promise<Payload>;
    validate: (input: unknown, options: ValidationOptions) => ValidationResult<T>;
    getApiKey?: () => string | undefined;
    getSigningSecret?: () => string | undefined;
    getVertexAuthentication?: () => VertexAuthentication | null;
    now?: () => number;
    bodyTimeoutMs?: number;
    limiter?: ReturnType<typeof createPlannerLimiter>;
    cookieLimiter?: ReturnType<typeof createCookieRateLimiter>;
    operation?: Exclude<CookieLimitOperation, 'places'>;
}
export function createPlannerLimiter(now: () => number = Date.now) {
    let start = now(),
        count = 0,
        active = 0;
    return {
        acquire() {
            const current = now();
            if (current < start || current - start >= 60000) {
                start = current;
                count = 0;
            }
            if (count >= 2000)
                return { retryAfter: Math.max(1, Math.ceil((start + 60000 - current) / 1000)) };
            if (active >= 2) return { retryAfter: 1 };
            count++;
            active++;
            let released = false;
            return {
                release() {
                    if (!released) {
                        active--;
                        released = true;
                    }
                },
            };
        },
    };
}
// Both POST routes share this process-wide allowance; no user/IP/location history.
const shared = globalThis as typeof globalThis & {
    __yorimichiPlannerLimiter?: ReturnType<typeof createPlannerLimiter>;
};
export const plannerLimiter = (shared.__yorimichiPlannerLimiter ??= createPlannerLimiter());
export function plannerJson(
    body: Payload | ApiErrorResponse,
    status = 200,
    retryAfter?: number,
): Response {
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'X-Content-Type-Options': 'nosniff',
            ...(retryAfter !== undefined && { 'Retry-After': String(retryAfter) }),
        },
    });
}
function errorResponse(
    id: string,
    status: number,
    code: ApiErrorCode,
    retryable: boolean,
    retryAfter?: number,
) {
    const messages: Record<ApiErrorCode, string> = {
        INVALID_INPUT: '検索条件と選択した候補を確認してください',
        UNSUPPORTED_MODE: 'この移動方法は現在対応していません',
        OUT_OF_AREA: '現在の対応エリアを確認してください',
        RATE_LIMITED: '検索が混み合っています。少し待って再試行してください',
        UPSTREAM_UNAVAILABLE: '経路や場所の情報を取得できませんでした',
        TIMEOUT: '処理に時間がかかっています。再試行してください',
        INTERNAL_ERROR: '検索を実行できませんでした',
    };
    return plannerJson(
        { requestId: id, error: { code, message: messages[code], field: null, retryable } },
        status,
        retryAfter,
    );
}
async function readBody(request: Request, timeoutMs: number): Promise<unknown> {
    if (!request.body) throw new GoogleServiceError(400, 'INVALID_INPUT', false);
    const reader = request.body.getReader();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0,
            text = '';
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 32768) throw new GoogleServiceError(400, 'INVALID_INPUT', false);
            text += decoder.decode(chunk.value, { stream: true });
        }
        return JSON.parse(text + decoder.decode()) as unknown;
    };
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GoogleServiceError(504, 'TIMEOUT', true)), timeoutMs);
    });
    try {
        return await Promise.race([read(), timeout]);
    } catch (error) {
        if (error instanceof GoogleServiceError) throw error;
        throw new GoogleServiceError(400, 'INVALID_INPUT', false);
    } finally {
        clearTimeout(timer!);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export function createPlannerPostHandler<T>(
    dependencies: Dependencies<T>,
): (request: Request) => Promise<Response> {
    const limiter = dependencies.limiter ?? createPlannerLimiter(dependencies.now);
    const now = dependencies.now ?? Date.now;
    const cookieLimiter = dependencies.cookieLimiter ?? createCookieRateLimiter({ now });
    return async (request) => {
        let requestId = '';
        let respond = (response: Response) => response;
        if (
            request.method !== 'POST' ||
            request.url.length > 2048 ||
            new URL(request.url).search ||
            !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') ||
            (request.headers.has('content-encoding') &&
                request.headers.get('content-encoding') !== 'identity') ||
            (request.headers.has('content-length') &&
                (!/^\d+$/.test(request.headers.get('content-length')!) ||
                    Number(request.headers.get('content-length')) > 32768))
        ) {
            return errorResponse('', 400, 'INVALID_INPUT', false);
        }
        let release: (() => void) | undefined;
        try {
            const body = await readBody(request, dependencies.bodyTimeoutMs ?? 2000);
            const validated = dependencies.validate(body, {
                now: new Date(now()),
                supportedTravelModes: ['WALK'],
            });
            if (!validated.ok) return plannerJson(validated.body, validated.status);
            requestId = (validated.value as { requestId: string }).requestId;
            const allowance = cookieLimiter.check(
                request,
                dependencies.operation ?? 'recommendations',
            );
            respond = allowance.apply;
            const limited = cookieLimitResponse(allowance, requestId);
            if (limited) return respond(limited);
            const slot = limiter.acquire();
            if ('retryAfter' in slot)
                return respond(
                    errorResponse(requestId, 429, 'RATE_LIMITED', true, slot.retryAfter),
                );
            release = slot.release;
            const result = await dependencies.execute(validated.value, {
                apiKey: (dependencies.getApiKey ?? (() => process.env.GOOGLE_MAPS_API_KEY))(),
                signingSecret: (
                    dependencies.getSigningSecret ?? (() => process.env.OPTION_TOKEN_SECRET)
                )(),
                vertexAuthentication: (
                    dependencies.getVertexAuthentication ?? vertexAuthentication
                )(),
                now: () => new Date(now()),
                signal: request.signal,
            });
            return respond(plannerJson(result));
        } catch (error) {
            if (error instanceof GoogleServiceError)
                return respond(
                    errorResponse(
                        requestId,
                        error.status,
                        error.code,
                        error.retryable,
                        error.status === 429 ? 60 : undefined,
                    ),
                );
            return respond(errorResponse(requestId, 500, 'INTERNAL_ERROR', false));
        } finally {
            release?.();
        }
    };
}
