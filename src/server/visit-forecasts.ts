import type { Place } from '../lib/api/types';
import type { GoogleRequestOptions } from './google-http';
import { getVisitWeather, unavailableVisitWeather } from './weather.ts';
import type { VisitWeatherResult } from './weather';
import { withRequestBudget } from './request-budget.ts';

export interface CandidateVisit {
    place: Place;
    visitAt: string;
}
export interface CandidateForecast {
    placeId: string;
    forecast: VisitWeatherResult;
}
interface ForecastScope {
    connection: () => GoogleRequestOptions;
    remainingMs: () => number;
    now: () => Date;
}

/** Optional work: at most four lookups, two concurrent, 1.5 seconds total, with time to respond. */
export async function loadVisitForecasts(
    visits: readonly CandidateVisit[],
    options: ForecastScope,
): Promise<CandidateForecast[]> {
    if (!visits.length) return [];
    const budgetMs = Math.min(1500, options.remainingMs() - 500);
    if (budgetMs <= 0) return [];
    const selected = visits.slice(0, 4);
    const results: CandidateForecast[] = [];
    const attempted = new Set<string>();
    let cursor = 0;
    try {
        await withRequestBudget(
            { ...options.connection(), workTimeoutMs: budgetMs },
            async (scope) => {
                const worker = async () => {
                    while (cursor < selected.length) {
                        const visit = selected[cursor++];
                        const connection = scope.connection();
                        attempted.add(visit.place.placeId);
                        const forecast = await getVisitWeather(visit.place, visit.visitAt, {
                            ...connection,
                            now: options.now,
                            workTimeoutMs: scope.remainingMs(),
                        });
                        results.push({ placeId: visit.place.placeId, forecast });
                    }
                };
                await Promise.all([worker(), worker()]);
            },
        );
    } catch {
        // Return completed forecasts only. The caller still checks its parent budget/cancellation.
    }
    const completed = results.slice();
    for (const visit of selected) {
        if (
            attempted.has(visit.place.placeId) &&
            !completed.some((item) => item.placeId === visit.place.placeId)
        ) {
            completed.push({ placeId: visit.place.placeId, forecast: unavailableVisitWeather() });
        }
    }
    return completed;
}
