import type { ApiWarning, Attribution, WeatherInformation } from '../lib/api/types';
import type { UnsignedRecommendationOption } from './candidate-assessment';
import type { CandidateForecast } from './visit-forecasts';
import type { VisitWeatherResult } from './weather';
import { indoorProfileForId } from './experience-profiles.ts';

const HOUR_MS = 3_600_000;

/** A forecast for another hour must never be used after network waiting changes the plan. */
export function forecastForOption(
    option: UnsignedRecommendationOption,
    forecasts: readonly CandidateForecast[],
): VisitWeatherResult | null {
    const match = forecasts.find((item) => item.placeId === option.place.placeId)?.forecast;
    if (!match) return null;
    if (match.weather.status !== 'available') return match;
    return Date.parse(match.weather.validAt ?? '') ===
        Math.floor(Date.parse(option.time.experienceStartAt) / HOUR_MS) * HOUR_MS
        ? match
        : null;
}

function outdoorSeconds(option: UnsignedRecommendationOption): number {
    const profile = indoorProfileForId(option.experienceId);
    // Included queues add no budget seconds, but their location is still unknown.
    const waiting =
        profile && option.time.waitTreatment === 'included'
            ? profile.waitMax
            : (option.time.waitSeconds ?? 0);
    return (
        option.time.legToStopSeconds +
        (profile ? 0 : option.time.experienceSeconds) +
        waiting +
        option.time.legToDestinationSeconds
    );
}

export function selectForWeather(
    options: readonly UnsignedRecommendationOption[],
    forecasts: readonly CandidateForecast[],
): {
    options: UnsignedRecommendationOption[];
    weather: WeatherInformation | null;
    warnings: ApiWarning[];
    attributions: Attribution[];
    excludedCount: number;
} {
    const entries = options.map((option) => ({
        option,
        forecast: forecastForOption(option, forecasts),
    }));
    const remaining = entries.filter((entry) => entry.forecast?.assessment.kind !== 'avoid');
    const excludedCount = entries.length - remaining.length;
    const warnings: ApiWarning[] = [];
    if (excludedCount)
        warnings.push({
            code: 'WEATHER_UNSUITABLE',
            message:
                '訪問時間帯に雷雨・大雨・大雪等の予報がある徒歩移動を含む寄り道を除外しました。直行の見積もりも現地の安全を保証するものではありません',
        });
    const comparable = remaining.every(
        (entry) =>
            entry.forecast?.weather.status === 'available' &&
            entry.forecast.assessment.kind !== 'unknown',
    );
    if (comparable && remaining.some((entry) => entry.forecast?.assessment.kind === 'exposed')) {
        remaining.sort((a, b) => {
            const aExposed = a.forecast?.assessment.kind === 'exposed';
            const bExposed = b.forecast?.assessment.kind === 'exposed';
            const rank = (entry: (typeof remaining)[number], exposed: boolean) =>
                !exposed ? 0 : indoorProfileForId(entry.option.experienceId) ? 1 : 2;
            return (
                rank(a, aExposed) - rank(b, bExposed) ||
                (aExposed ? outdoorSeconds(a.option) - outdoorSeconds(b.option) : 0)
            );
        });
    } else if (!comparable && remaining.length) {
        warnings.push({
            code: 'WEATHER_COMPARISON_UNKNOWN',
            message:
                '一部の訪問時間帯の天候を比較できないため、天候による順位変更は行わず時間条件の順位を維持しました',
        });
    }
    const selected = remaining.map(({ option, forecast }) => {
        if (forecast?.weather.status !== 'available' || forecast.assessment.kind === 'unknown')
            return option;
        const indoors = indoorProfileForId(option.experienceId) !== null;
        const reason =
            comparable && forecast.assessment.kind === 'exposed'
                ? indoors
                    ? `${forecast.weather.summary}。利用条件を確認できた屋内体験を優先しています。移動・待ち時間は屋外になる可能性があります`
                    : `${forecast.weather.summary}。${forecast.assessment.reason}`
                : `${forecast.weather.summary}。天候を確認して選定しています`;
        return {
            ...option,
            recommendationReasons: [...option.recommendationReasons, reason],
            sources: [...option.sources, { provider: 'Google Weather API', url: null }],
        };
    });
    const top = remaining[0]?.forecast ?? entries[0]?.forecast;
    if (remaining.some((entry) => entry.forecast?.weather.status === 'unavailable'))
        warnings.push({
            code: 'WEATHER_UNAVAILABLE',
            message: '一部の訪問時間帯の天候予報を取得できませんでした',
        });
    if (remaining.some((entry) => !entry.forecast || entry.forecast.weather.status === 'unknown'))
        warnings.push({ code: 'WEATHER_UNKNOWN', message: '一部の訪問時間帯の天候予報は不明です' });
    return {
        options: selected,
        weather: top?.weather ?? null,
        warnings,
        attributions: forecasts.flatMap((item) => item.forecast.attributions),
        excludedCount,
    };
}
