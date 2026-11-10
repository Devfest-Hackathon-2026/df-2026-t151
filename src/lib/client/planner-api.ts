import type {
    ApiErrorResponse,
    PlacesResponse,
    RecommendationsRequest,
    RecommendationsResponse,
    ValidateItineraryRequest,
    ValidateItineraryResponse,
} from '../api/types';
import { printCandidateExclusions } from './candidate-diagnostics.ts';

export const requestTimeoutMs = 30_000;

export class PlannerApiError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable: boolean) {
        super(message);
        this.retryable = retryable;
    }
}

function requestId() {
    return `planner-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`;
}

async function request<T extends { requestId: string }>(
    path: string,
    id: string,
    signal: AbortSignal,
    body?: object,
): Promise<T> {
    const response = await fetch(`/api/v1${path}`, {
        signal,
        cache: 'no-store',
        ...(body && {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    });
    if (response.status === 404 || response.status === 405) {
        throw new PlannerApiError('この環境では対象のAPIがまだ利用できません。', false);
    }
    if (response.status === 504) {
        throw new DOMException('Request timed out', 'TimeoutError');
    }

    const payload: T | ApiErrorResponse | null = await response.json().catch(() => null);
    signal.throwIfAborted();
    if (!response.ok) {
        if (
            payload?.requestId === id &&
            'error' in payload &&
            typeof payload.error?.message === 'string'
        ) {
            throw new PlannerApiError(payload.error.message, payload.error.retryable === true);
        }
        throw new PlannerApiError('通信エラーが発生しました。', response.status >= 500);
    }
    if (!payload || payload.requestId !== id || 'error' in payload) {
        throw new PlannerApiError('APIの応答を確認できませんでした。', true);
    }
    return payload;
}

export async function lookupPlaces(query: string, signal: AbortSignal) {
    const id = requestId();
    const result = await request<PlacesResponse>(
        `/places?${new URLSearchParams({ query, requestId: id })}`,
        id,
        signal,
    );
    if (!Array.isArray(result.places) || !Array.isArray(result.attributions)) {
        throw new PlannerApiError('場所検索の応答を確認できませんでした。', true);
    }
    return result;
}

export async function loadRecommendations(
    input: Omit<RecommendationsRequest, 'requestId'>,
    signal: AbortSignal,
) {
    const id = requestId();
    const result = await request<RecommendationsResponse>('/recommendations', id, signal, {
        ...input,
        requestId: id,
    });
    if (
        result.dataMode !== 'live' ||
        !['OPTIONS', 'NO_OPTIONS', 'DIRECT_LATE'].includes(result.outcome) ||
        !Array.isArray(result.options) ||
        !result.destination ||
        !result.direct ||
        !result.context?.weather ||
        !result.context.crowd ||
        !Array.isArray(result.warnings) ||
        !Array.isArray(result.attributions)
    ) {
        throw new PlannerApiError('候補検索の応答を確認できませんでした。', true);
    }
    printCandidateExclusions(result.exclusions, '候補検索');
    return result;
}

export async function validateItinerary(
    input: Omit<ValidateItineraryRequest, 'requestId'>,
    signal: AbortSignal,
) {
    const id = requestId();
    const result = await request<ValidateItineraryResponse>('/itineraries/validate', id, signal, {
        ...input,
        requestId: id,
    });
    if (
        !Array.isArray(result.warnings) ||
        !Array.isArray(result.attributions) ||
        (result.status === 'VALID'
            ? !result.option ||
              result.option.place?.placeId !== input.selectedPlaceId ||
              result.option.experienceId !== input.experienceId
            : !['NO_LONGER_FEASIBLE', 'EXPIRED'].includes(result.status) || result.option !== null)
    ) {
        throw new PlannerApiError('行程再検証の応答を確認できませんでした。', true);
    }
    printCandidateExclusions(result.exclusions, '行程の再検証');
    return result;
}
