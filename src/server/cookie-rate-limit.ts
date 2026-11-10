import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ApiErrorResponse } from '../lib/api/types';

export const COOKIE_NAME = 'yorimichi_usage';
export const COOKIE_LIMITS = {
    places: { minute: 2000, day: 10000 },
    recommendations: { minute: 300, day: 1000 },
    validation: { minute: 1000, day: 3000 },
} as const;
export type CookieLimitOperation = keyof typeof COOKIE_LIMITS;
type Counter = { minute: number; minuteCount: number; dayCount: number };
type Usage = { counters: Partial<Record<CookieLimitOperation, Counter>> };
const DAY_MS = 86400000;
const JST_MS = 9 * 3600000;
const dayNumber = (time: number) => Math.floor((time + JST_MS) / DAY_MS);

/** Temporary process-local quotas. Cookies carry identity, never trusted counters. */
export function createCookieRateLimiter(
    options: {
        now?: () => number;
        getSecret?: () => string;
        maxVisitors?: number;
    } = {},
) {
    const now = options.now ?? Date.now;
    const fallbackSecret = randomBytes(32).toString('base64url');
    const getSecret =
        options.getSecret ?? (() => process.env.OPTION_TOKEN_SECRET || fallbackSecret);
    const visitors = new Map<string, Usage>();
    let lastDay = dayNumber(now());
    const signature = (id: string) =>
        createHmac('sha256', getSecret()).update(`yorimichi-usage-v1:${id}`).digest('base64url');

    return {
        check(request: Request, operation: CookieLimitOperation) {
            const time = now();
            const day = dayNumber(time);
            // Daily expiry bounds retention; do not evict active quotas to admit a new ID.
            if (day !== lastDay) {
                visitors.clear();
                lastDay = day;
            }
            const raw = request.headers.get('cookie') ?? '';
            const values =
                raw.length <= 8192
                    ? raw
                          .split(';')
                          .map((part) => part.trim())
                          .filter((part) => part.startsWith(`${COOKIE_NAME}=`))
                    : [];
            const token = values.length === 1 ? values[0].slice(COOKIE_NAME.length + 1) : '';
            const match =
                /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(
                    token,
                );
            const id =
                match && timingSafeEqual(Buffer.from(match[2]), Buffer.from(signature(match[1])))
                    ? match[1]
                    : null;
            let setCookie: string | undefined;
            const apply = (response: Response) => {
                if (setCookie) response.headers.append('Set-Cookie', setCookie);
                response.headers.set('Cache-Control', 'private, no-store, max-age=0');
                return response;
            };
            let usage = id ? visitors.get(id) : undefined;
            if (!usage) {
                // Untracked visitors still pass through the process-wide request limits.
                if (visitors.size >= (options.maxVisitors ?? 10000)) {
                    return { apply };
                }
                const visitorId = id ?? randomUUID();
                if (!id) {
                    setCookie = `${COOKIE_NAME}=${visitorId}.${signature(visitorId)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
                }
                usage = { counters: {} };
                visitors.set(visitorId, usage);
            }
            const minute = Math.floor(time / 60000);
            const counter = (usage.counters[operation] ??= { minute, minuteCount: 0, dayCount: 0 });
            if (counter.minute !== minute) {
                counter.minute = minute;
                counter.minuteCount = 0;
            }
            const limit = COOKIE_LIMITS[operation];
            if (counter.dayCount >= limit.day) {
                return {
                    apply,
                    retryAfter: Math.max(1, Math.ceil(((day + 1) * DAY_MS - JST_MS - time) / 1000)),
                    message: '本日の利用上限に達しました。明日0時（日本時間）以降にお試しください',
                };
            }
            if (counter.minuteCount >= limit.minute) {
                return {
                    apply,
                    retryAfter: Math.max(1, Math.ceil(((minute + 1) * 60000 - time) / 1000)),
                    message: '短時間の利用上限に達しました。1分ほど待って再試行してください',
                };
            }
            // Reserve synchronously before awaiting work, including failed attempts.
            counter.minuteCount++;
            counter.dayCount++;
            return { apply };
        },
    };
}

const shared = globalThis as typeof globalThis & {
    __yorimichiCookieRateLimiter?: ReturnType<typeof createCookieRateLimiter>;
};
export const cookieRateLimiter = (shared.__yorimichiCookieRateLimiter ??=
    createCookieRateLimiter());

export function cookieLimitResponse(
    allowance: ReturnType<ReturnType<typeof createCookieRateLimiter>['check']>,
    requestId: string,
): Response | null {
    if (allowance.retryAfter === undefined) return null;
    const body: ApiErrorResponse = {
        requestId,
        error: { code: 'RATE_LIMITED', message: allowance.message!, field: null, retryable: true },
    };
    return Response.json(body, {
        status: 429,
        headers: {
            'Retry-After': String(allowance.retryAfter),
            'X-Content-Type-Options': 'nosniff',
        },
    });
}
