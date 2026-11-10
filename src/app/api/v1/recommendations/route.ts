import {
    createPlannerPostHandler,
    plannerLimiter,
} from '../../../../server/planner-post-handler.ts';
import { getRecommendations } from '../../../../server/recommendations.ts';
import { validateRecommendationsRequest } from '../../../../server/request-validation.ts';
import { cookieRateLimiter } from '../../../../server/cookie-rate-limit.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createPlannerPostHandler({
    execute: getRecommendations,
    validate: validateRecommendationsRequest,
    limiter: plannerLimiter,
    cookieLimiter: cookieRateLimiter,
    operation: 'recommendations',
});
