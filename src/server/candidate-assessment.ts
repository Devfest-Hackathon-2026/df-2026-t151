import type { ApiWarning, Attribution, RecommendationOption } from '../lib/api/types';
import type { PlaceCandidate } from './nearby-candidates';
import type { WalkingRoute } from './routes';
import type { WaitEstimate } from './time-budget';
import { calculateTimeBudget, waitUpperSeconds } from './time-budget.ts';
import { selectExperienceDuration } from './duration-evidence.ts';
import type { DurationEvidence } from './duration-evidence';
import { isOpenForVisit } from './opening-hours.ts';
import { parseZonedDateTime } from './date-time.ts';
import { PUBLIC_EXTERIOR_ID } from './exterior-access.ts';
import { candidateConditions, isBusinessClosed } from './candidate-conditions.ts';
import { indoorProfileForId } from './experience-profiles.ts';
import type { JsonValue } from '../lib/api/types';

export interface CandidateExperience {
    experienceId: string;
    title: string;
    description: string;
    durationEvidence: DurationEvidence[];
    wait: WaitEstimate;
    admission: { status: 'not_applicable' } | { status: 'required'; lastEntryAt: string | null };
    accessDestinationPlaceId?: string;
}
export type UnsignedRecommendationOption = Omit<RecommendationOption, 'optionId' | 'optionToken'>;
export type CandidateAssessment =
    | { eligible: true; option: UnsignedRecommendationOption; attributions: Attribution[] }
    | { eligible: false; reason: string; facts: Record<string, JsonValue> };

export function uniqueAttributions(values: Attribution[]): Attribution[] {
    return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}
export function uniqueWarnings(values: ApiWarning[]): ApiWarning[] {
    return [...new Map(values.map((value) => [`${value.code}\n${value.message}`, value])).values()];
}

export function assessCandidate(input: {
    candidate: PlaceCandidate;
    experience: CandidateExperience;
    calculatedAt: string;
    arriveBy: string;
    directSeconds: number;
    legToStop: WalkingRoute;
    legToDestination: WalkingRoute;
    bufferSeconds: number;
}): CandidateAssessment {
    const facts: Record<string, JsonValue> = {};
    const reject = (reason: string): CandidateAssessment => ({ eligible: false, reason, facts });
    const { candidate, experience } = input;
    const accessEvidence = candidate.accessEvidence ?? candidate.interiorAccessEvidence;
    const now = parseZonedDateTime(input.calculatedAt);
    const retrieved = parseZonedDateTime(candidate.retrievedAt);
    if (now === null || retrieved === null || retrieved > now || now - retrieved > 15 * 60000)
        return reject('STALE_OR_INVALID_SOURCE');
    if (isBusinessClosed(candidate)) return reject('NOT_OPERATIONAL');
    const unknowns: ApiWarning[] = [];
    try {
        const arrivalMs = now + input.legToStop.durationSeconds * 1000;
        const rawWait = waitUpperSeconds(experience.wait);
        if (!Number.isSafeInteger(rawWait) || rawWait < 0) return reject('INVALID_TIME_DATA');
        const duration = selectExperienceDuration(experience.durationEvidence, {
            placeId: candidate.place.placeId,
            experienceId: experience.experienceId,
            visitStartAt: new Date(arrivalMs + rawWait * 1000).toISOString(),
            referenceAt: input.calculatedAt,
        });
        if (!duration) return reject('DURATION_UNKNOWN');
        Object.assign(facts, {
            experienceMaxSeconds: duration.maxSeconds,
            waitSeconds: rawWait,
            legToStopSeconds: input.legToStop.durationSeconds,
            legToDestinationSeconds: input.legToDestination.durationSeconds,
            bufferSeconds: input.bufferSeconds,
            remainingSeconds: Math.floor((Date.parse(input.arriveBy) - now) / 1000),
        });
        const budget = calculateTimeBudget({
            calculatedAt: input.calculatedAt,
            arriveBy: input.arriveBy,
            directSeconds: input.directSeconds,
            legToStopSeconds: input.legToStop.durationSeconds,
            legToDestinationSeconds: input.legToDestination.durationSeconds,
            experienceDuration: duration,
            wait: experience.wait,
            bufferSeconds: input.bufferSeconds,
        });
        if (budget.status === 'excluded') return reject(budget.reason);
        facts.requiredSeconds = budget.time.requiredSeconds;
        if (!budget.fitsDeadline) return reject('TIME_LIMIT');
        if (duration.includesWait && experience.wait.status === 'unknown')
            return reject('WAIT_START_UNKNOWN');
        const stopArrivalAt = new Date(arrivalMs).toISOString();
        const experienceStartAt = new Date(arrivalMs + rawWait * 1000).toISOString();
        const stopDepartureAt = new Date(
            Date.parse(budget.time.arrivalAt) - input.legToDestination.durationSeconds * 1000,
        ).toISOString();
        if (
            experience.experienceId === PUBLIC_EXTERIOR_ID ||
            indoorProfileForId(experience.experienceId)
        ) {
            const conditions = candidateConditions(
                candidate,
                experience.accessDestinationPlaceId ?? '',
                input.calculatedAt,
                stopDepartureAt,
                experience.experienceId,
            );
            if (conditions.blockedReason) return reject(conditions.blockedReason);
            unknowns.push(...conditions.unknowns);
        }
        const opening = isOpenForVisit(candidate.opening, stopArrivalAt, stopDepartureAt);
        if (opening === 'CLOSED') return reject('CLOSED_FOR_VISIT');
        if (opening === 'UNKNOWN')
            unknowns.push({
                code: 'UNCONFIRMED_OPENING',
                message: '訪問時間帯の営業時間は不明です。営業していることは確認できていません',
            });
        if (experience.admission.status === 'required') {
            const lastEntry = parseZonedDateTime(experience.admission.lastEntryAt);
            if (lastEntry === null)
                unknowns.push({
                    code: 'UNCONFIRMED_ENTRY_CUTOFF',
                    message: '最終入場・受付締切は不明です',
                });
            else if (Date.parse(experienceStartAt) > lastEntry) return reject('LAST_ENTRY_PASSED');
        }
        const warnings = uniqueWarnings([
            ...unknowns,
            ...input.legToStop.warnings,
            ...input.legToDestination.warnings,
            ...budget.warnings,
            ...(duration.sourceType === 'estimate'
                ? [
                      {
                          code: 'ESTIMATED_DURATION',
                          message: '体験時間は推定で、範囲の上限を使って計算しています',
                      },
                  ]
                : []),
            ...(candidate.accessEvidence && !unknowns.length
                ? [
                      {
                          code: 'ACCESS_SOURCE',
                          message:
                              '入場不要の外観観察として公開情報と照合しました。現地の利用条件を確認してください',
                      },
                  ]
                : []),
            ...(candidate.interiorAccessEvidence && !unknowns.length
                ? [
                      {
                          code: 'INDOOR_ACCESS_SOURCE',
                          message:
                              '屋内利用・予約不要・入場や注文条件を公開情報と照合しました。移動や入店待ちは屋外になる可能性があり、現地の条件確認が必要です',
                      },
                  ]
                : []),
            ...(candidate.groundedExperience
                ? [
                      {
                          code: 'AI_MAPS_GROUNDED',
                          message:
                              '体験内容・利用条件はGoogle Mapsを参照したAIによる提案です。現地の条件を確認してください',
                      },
                  ]
                : []),
            { code: 'CROWD_UNKNOWN', message: '混雑情報は取得していません' },
            {
                code: 'ARRIVAL_ESTIMATE',
                message: '到着時刻はAPI情報に基づく見積もりで、到着を保証するものではありません',
            },
        ]);
        return {
            eligible: true,
            option: {
                place: candidate.place,
                experienceId: experience.experienceId,
                title: experience.title,
                description: experience.description,
                recommendationReasons: [
                    '移動・体験・余裕の時間が到着期限内に収まる見積もりです',
                    opening === 'OPEN'
                        ? '取得した営業時間内に立ち寄れることを照合しました'
                        : '営業時間は不明のため、利用前に確認してください',
                ],
                experienceDuration: duration,
                time: {
                    ...budget.time,
                    isProvisional: budget.time.isProvisional || unknowns.length > 0,
                    stopArrivalAt,
                    experienceStartAt,
                    stopDepartureAt,
                },
                opening: {
                    status: opening === 'OPEN' ? 'verified_for_plan' : 'unknown',
                    provider: 'Google Places',
                    retrievedAt: candidate.retrievedAt,
                    sourceUrl: candidate.sourceUrl,
                },
                crowd: {
                    status: 'unknown',
                    provider: null,
                    retrievedAt: null,
                    validAt: null,
                    summary: '混雑情報なし',
                    sourceUrl: null,
                },
                cost: indoorProfileForId(experience.experienceId)
                    ? {
                          amount: null,
                          currency: 'JPY',
                          label:
                              experience.experienceId === 'small-exhibit-v1'
                                  ? '入場・利用料金は現地確認'
                                  : '飲食代別途（価格未確認）',
                      }
                    : { amount: null, currency: 'JPY', label: '費用不明' },
                sources: [
                    { provider: 'Google Places', url: candidate.sourceUrl },
                    { provider: 'Google Routes', url: 'https://maps.google.com/' },
                    ...(candidate.groundedExperience
                        ? candidate.groundedExperience.sources.map((source) => ({
                              provider: `Google Maps：${source.title}`,
                              url: source.url,
                          }))
                        : accessEvidence
                          ? [
                                {
                                    provider:
                                        accessEvidence.provider === 'grounded_maps'
                                            ? 'Gemini / Google Maps'
                                            : '登録済みの利用条件',
                                    url: accessEvidence.sourceUrl,
                                },
                            ]
                          : []),
                ],
                warnings,
            },
            attributions: uniqueAttributions([
                ...candidate.attributions,
                ...input.legToStop.attributions,
                ...input.legToDestination.attributions,
            ]),
        };
    } catch (error) {
        if (error instanceof RangeError) return reject('INVALID_TIME_DATA');
        throw error;
    }
}
