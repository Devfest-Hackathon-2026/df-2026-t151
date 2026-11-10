import {
    createPlannerPostHandler,
    plannerLimiter,
} from '../../../../../server/planner-post-handler.ts';
import { revalidateItinerary } from '../../../../../server/itinerary-validation.ts';
import { validateItineraryRequest } from '../../../../../server/request-validation.ts';
import { cookieRateLimiter } from '../../../../../server/cookie-rate-limit.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createPlannerPostHandler({
    execute: revalidateItinerary,
    validate: validateItineraryRequest,
    limiter: plannerLimiter,
    cookieLimiter: cookieRateLimiter,
    operation: 'validation',
});
