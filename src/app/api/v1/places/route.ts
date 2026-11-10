import { createPlacesHandler } from '../../../../server/places-handler.ts';
import { cookieRateLimiter } from '../../../../server/cookie-rate-limit.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createPlacesHandler({ cookieLimiter: cookieRateLimiter });
