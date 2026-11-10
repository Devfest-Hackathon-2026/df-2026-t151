import { classifyWeather } from './weather-policy.ts';
import type { WeatherAssessment } from './weather-policy';

import type { Attribution, Place, WeatherInformation } from '../lib/api/types';
import { parseZonedDateTime } from './date-time.ts';
import { googleHourlyForecast, upstreamUnavailable } from './google-http.ts';
import { withRequestBudget } from './request-budget.ts';
import type { BudgetOptions } from './request-budget';

export interface VisitWeatherResult {
    weather: WeatherInformation;
    attributions: Attribution[];
    assessment: WeatherAssessment;
}

const hourMs = 3_600_000;
const maxHours = 24;
const provider = 'Google Weather API';
const weathernewsAttribution: Attribution = {
    provider: '気象データ提供：株式会社ウェザーニューズ',
    providerUri: 'https://jp.weathernews.com/',
};

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function missingWeather(
    status: 'unknown' | 'unavailable',
    summary: string,
    retrievedAt: string | null = null,
): VisitWeatherResult {
    return {
        weather: {
            status,
            provider: retrievedAt || status === 'unavailable' ? provider : null,
            retrievedAt,
            validAt: null,
            summary,
            sourceUrl: null,
        },
        attributions: [],
        assessment: classifyWeather(null, null),
    };
}

export function unavailableVisitWeather(): VisitWeatherResult {
    return missingWeather('unavailable', '訪問予定時刻の天候予報を取得できませんでした');
}

export async function getVisitWeather(
    place: Place,
    visitAt: string,
    options: BudgetOptions & { now?: () => Date },
): Promise<VisitWeatherResult> {
    const now = options.now ?? (() => new Date());
    const currentHour = Math.floor(now().getTime() / hourMs) * hourMs;
    const visit = parseZonedDateTime(visitAt);
    if (
        !Number.isFinite(currentHour) ||
        visit === null ||
        !Number.isFinite(place.latitude) ||
        Math.abs(place.latitude) > 90 ||
        !Number.isFinite(place.longitude) ||
        Math.abs(place.longitude) > 180
    ) {
        return missingWeather('unknown', '訪問予定時刻の天候は不明です');
    }
    const visitHour = Math.floor(visit / hourMs) * hourMs;
    const hours = (visitHour - currentHour) / hourMs + 1;
    if (hours < 1 || hours > maxHours)
        return missingWeather('unknown', '訪問予定時刻は時間別予報の取得範囲外です');

    try {
        const raw = await withRequestBudget(
            { ...options, workTimeoutMs: options.workTimeoutMs ?? 1500 },
            (scope) => googleHourlyForecast(place, hours, scope.connection()),
        );
        const payload = record(raw);
        if (!Array.isArray(payload?.forecastHours)) throw upstreamUnavailable();
        const retrievedAt = now().toISOString();
        if (record(payload.timeZone)?.id !== 'Asia/Tokyo') {
            return missingWeather(
                'unknown',
                '日本時間の訪問予報を確認できませんでした',
                retrievedAt,
            );
        }

        for (const item of payload.forecastHours) {
            const forecast = record(item);
            const interval = record(forecast?.interval);
            if (
                parseZonedDateTime(interval?.startTime) !== visitHour ||
                parseZonedDateTime(interval?.endTime) !== visitHour + hourMs
            )
                continue;

            const condition = record(record(forecast?.weatherCondition)?.description)?.text;
            if (
                typeof condition !== 'string' ||
                !condition.trim() ||
                condition.length > 120 ||
                /[\u0000-\u001f\u007f]/.test(condition)
            )
                break;

            const chance = record(record(forecast?.precipitation)?.probability)?.percent;
            const precipitation =
                typeof chance === 'number' &&
                Number.isInteger(chance) &&
                chance >= 0 &&
                chance <= 100
                    ? `・降水確率${chance}%`
                    : '';
            const probability =
                typeof chance === 'number' &&
                Number.isInteger(chance) &&
                chance >= 0 &&
                chance <= 100
                    ? chance
                    : null;
            return {
                assessment: classifyWeather(record(forecast?.weatherCondition)?.type, probability),
                weather: {
                    status: 'available',
                    provider,
                    retrievedAt,
                    validAt: new Date(visitHour).toISOString(),
                    summary: `${place.label}の訪問時間帯の予報　${condition.trim()}${precipitation}`,
                    sourceUrl: null,
                },
                attributions: [
                    'Source: Includes weather data from Google.',
                    weathernewsAttribution,
                ],
            };
        }
        return missingWeather('unknown', '訪問予定時刻に対応する天候予報がありません', retrievedAt);
    } catch {
        // Weather is supplemental. Do not pass upstream failures or raw data to the planner response.
        return unavailableVisitWeather();
    }
}
