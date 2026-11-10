import { selectForWeather, forecastForOption } from '../weather-selection.ts';
import { selectExperienceMix } from '../experience-mix.ts';
import type { CandidateForecast } from '../visit-forecasts';
import type { RecommendationsRequest, RecommendationsResponse } from '../../lib/api/types';
import type { DirectJourneyResult } from '../direct-journey';
import { GoogleServiceError } from '../google-http.ts';
import { assessCandidate, uniqueAttributions, uniqueWarnings } from '../candidate-assessment.ts';
import { createCandidateExperience } from './experience.ts';
import type { DetourSearchResult, RoutedCandidate, SearchOptions } from './types';
import type { PlaceCandidate } from '../nearby-candidates';
import type { JsonValue } from '../../lib/api/types';

export function createSearchResult(
    input: RecommendationsRequest,
    direct: DirectJourneyResult,
): DetourSearchResult {
    const context: RecommendationsResponse['context'] = {
        weather: {
            status: 'unknown',
            provider: null,
            retrievedAt: null,
            validAt: null,
            summary: '天候情報なし',
            sourceUrl: null,
        },
        crowd: {
            status: 'unknown',
            provider: null,
            retrievedAt: null,
            validAt: null,
            summary: '混雑情報なし',
            sourceUrl: null,
        },
    };
    const result: DetourSearchResult = {
        requestId: input.requestId,
        calculatedAt: direct.calculatedAt,
        arriveBy: input.arriveBy,
        outcome: direct.outcome === 'DIRECT_LATE' ? 'DIRECT_LATE' : 'NO_OPTIONS',
        direct: direct.direct,
        context,
        options: [],
        attributions: [...direct.attributions],
        warnings: uniqueWarnings([
            ...direct.warnings,
            { code: 'WEATHER_UNKNOWN', message: '天候情報は未取得です' },
            { code: 'CROWD_UNKNOWN', message: '混雑情報は未取得です' },
        ]),
        diagnostics: { discoveredCount: 0, evaluatedCount: 0, excludedCounts: {}, exclusions: [] },
    };

    return result;
}

/** Refresh after discovery and routing so network wait time cannot use an older departure clock. */
export function refreshDirectEstimate(
    result: DetourSearchResult,
    currentTimeMs: number,
    notBeforeMs: number,
): void {
    if (!Number.isFinite(currentTimeMs)) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const calculatedAtMs = Math.max(notBeforeMs, currentTimeMs);
    result.calculatedAt = new Date(calculatedAtMs).toISOString();
    result.direct = {
        durationSeconds: result.direct.durationSeconds,
        arrivalAt: new Date(calculatedAtMs + result.direct.durationSeconds * 1000).toISOString(),
    };
}

export function appendAssessedOptions(
    input: RecommendationsRequest,
    routePairs: RoutedCandidate[],
    result: DetourSearchResult,
    options: Pick<SearchOptions, 'durationEvidence'> & {
        bufferSeconds: number;
        exclude: (
            reason: string,
            candidate?: PlaceCandidate,
            facts?: Record<string, JsonValue>,
        ) => void;
    },
): void {
    for (const { candidate, legToStop, legToDestination } of routePairs) {
        const experience = createCandidateExperience(
            candidate,
            result.calculatedAt,
            options.durationEvidence ?? [],
            input.destination.placeId,
        );
        if (!experience) {
            options.exclude('EXPERIENCE_UNKNOWN', candidate);
            continue;
        }
        const assessment = assessCandidate({
            candidate,
            experience,
            calculatedAt: result.calculatedAt,
            arriveBy: input.arriveBy,
            directSeconds: result.direct.durationSeconds,
            legToStop,
            legToDestination,
            bufferSeconds: options.bufferSeconds,
        });
        if (assessment.eligible) {
            result.options.push(assessment.option);
            result.attributions.push(...assessment.attributions);
        } else
            options.exclude(assessment.reason, candidate, {
                legToStopSeconds: legToStop.durationSeconds,
                legToDestinationSeconds: legToDestination.durationSeconds,
                bufferSeconds: options.bufferSeconds,
                remainingSeconds: Math.floor(
                    (Date.parse(input.arriveBy) - Date.parse(result.calculatedAt)) / 1000,
                ),
                ...assessment.facts,
            });
    }
}

export function finalizeSearchResult(
    result: DetourSearchResult,
    forecasts?: readonly CandidateForecast[],
): DetourSearchResult {
    result.options.sort(
        (a, b) =>
            b.time.slackSeconds - a.time.slackSeconds ||
            a.place.placeId.localeCompare(b.place.placeId),
    );
    if (forecasts && result.options.length) {
        const beforeWeather = result.options;
        const selection = selectForWeather(result.options, forecasts);
        for (const option of beforeWeather.filter(
            (option) =>
                !selection.options.some(
                    (selected) => selected.place.placeId === option.place.placeId,
                ),
        )) {
            const forecast = forecasts.find(
                (item) => item.placeId === option.place.placeId,
            )?.forecast;
            result.diagnostics.exclusions.push({
                stage: 'weather',
                placeLabel: option.place.label,
                reason: 'WEATHER_UNSUITABLE',
                source: { provider: 'Google Weather', url: forecast?.weather.sourceUrl ?? null },
                facts: {
                    weatherSummary: forecast?.weather.summary ?? null,
                    assessment: forecast?.assessment.kind ?? null,
                },
            });
        }
        result.options = selection.options;
        if (selection.weather) {
            result.context.weather = selection.weather;
            result.warnings = result.warnings.filter(({ code }) => code !== 'WEATHER_UNKNOWN');
        }
        result.warnings.push(...selection.warnings);
        result.attributions.push(...selection.attributions);
        if (selection.excludedCount)
            result.diagnostics.excludedCounts.WEATHER_UNSUITABLE = selection.excludedCount;
    }
    const beforeMix = result.options;
    result.options = selectExperienceMix(result.options);
    for (const option of beforeMix.filter((option) => !result.options.includes(option))) {
        result.diagnostics.exclusions.push({
            stage: 'final-selection',
            placeLabel: option.place.label,
            reason: result.options.length ? 'DISPLAY_LIMIT' : 'EXTERIOR_REQUIRED',
            source: { provider: 'アプリの表示ルール', url: null },
            facts: { maximumDisplayed: 3, exteriorRequired: true },
        });
    }
    if (!result.options.length)
        result.warnings.push({
            code: 'EXTERIOR_REQUIRED',
            message:
                '時間・利用条件・天候を満たす外観観察の候補が見つからなかったため、寄り道候補は表示していません。条件を変えるか直行を選んでください',
        });
    if (forecasts && result.options.length) {
        const top = forecastForOption(result.options[0], forecasts);
        result.context.weather = top?.weather ?? {
            status: 'unknown',
            provider: null,
            retrievedAt: null,
            validAt: null,
            summary: '天候情報なし',
            sourceUrl: null,
        };
    }
    result.outcome = result.options.length ? 'OPTIONS' : 'NO_OPTIONS';
    if (Object.keys(result.diagnostics.excludedCounts).length)
        result.warnings.push({
            code: 'CANDIDATES_FILTERED',
            message:
                '時間・営業時間外・利用不可の条件・探索上限等により候補の一部を除外しました。未確認の条件だけでは除外していません',
        });
    if (
        Object.keys(result.diagnostics.excludedCounts).some(
            (reason) =>
                reason.startsWith('ACCESS_') ||
                reason === 'DESTINATION_RELATION_UNKNOWN' ||
                reason === 'ADMISSION_REQUIRED',
        )
    ) {
        result.warnings.push({
            code: 'ACCESS_UNVERIFIED',
            message: '目的地から独立した場所で体験を利用できる根拠が不足した候補は除外しました',
        });
    }
    result.attributions = uniqueAttributions(result.attributions);
    return result;
}
