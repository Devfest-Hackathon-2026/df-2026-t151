import { TRAVEL_MODES } from '../lib/api/types.ts';
import type {
    ApiErrorResponse,
    PlacesQuery,
    RecommendationsRequest,
    TravelMode,
    ValidateItineraryRequest,
} from '../lib/api/types';
import { parseZonedDateTime } from './date-time.ts';

export type ValidationResult<T> =
    { ok: true; value: T } | { ok: false; status: 400 | 422; body: ApiErrorResponse };

export interface ValidationOptions {
    /** Inject server time in tests. A client-provided calculatedAt is never used. */
    now?: Date;
    /** Must match capabilities. Default [] keeps unconnected travel modes disabled. */
    supportedTravelModes?: readonly TravelMode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maxLength: number): value is string {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= maxLength &&
        !/[\u0000-\u001f\u007f]/.test(value)
    );
}

function failure(
    requestId: string,
    field: string | null,
    message: string,
    code: 'INVALID_INPUT' | 'UNSUPPORTED_MODE' = 'INVALID_INPUT',
): ValidationResult<never> {
    return {
        ok: false,
        status: code === 'UNSUPPORTED_MODE' ? 422 : 400,
        body: { requestId, error: { code, message, field, retryable: false } },
    };
}

function requestIdOf(value: unknown): string {
    return isRecord(value) && isText(value.requestId, 128) ? value.requestId : '';
}

export function validatePlacesQuery(input: unknown): ValidationResult<PlacesQuery> {
    const requestId = requestIdOf(input);
    if (!isRecord(input)) return failure('', null, '検索条件を確認してください');
    if (!requestId) return failure('', 'requestId', '要求IDを確認してください');
    if (!isText(input.query, 200)) return failure(requestId, 'query', '場所名を確認してください');
    return { ok: true, value: { requestId, query: input.query } };
}

export function validateRecommendationsRequest(
    input: unknown,
    options: ValidationOptions = {},
): ValidationResult<RecommendationsRequest> {
    const requestId = requestIdOf(input);
    if (!isRecord(input)) return failure('', null, '検索条件を確認してください');
    if (!requestId) return failure('', 'requestId', '要求IDを確認してください');

    const origin = input.origin;
    if (!isRecord(origin)) return failure(requestId, 'origin', '出発地点を確認してください');
    if (
        typeof origin.latitude !== 'number' ||
        !Number.isFinite(origin.latitude) ||
        origin.latitude < -90 ||
        origin.latitude > 90
    ) {
        return failure(requestId, 'origin.latitude', '出発地点の緯度を確認してください');
    }
    if (
        typeof origin.longitude !== 'number' ||
        !Number.isFinite(origin.longitude) ||
        origin.longitude < -180 ||
        origin.longitude > 180
    ) {
        return failure(requestId, 'origin.longitude', '出発地点の経度を確認してください');
    }

    const destination = input.destination;
    if (!isRecord(destination) || !isText(destination.placeId, 256)) {
        return failure(requestId, 'destination.placeId', '目的地を選び直してください');
    }

    const nowMs = (options.now ?? new Date()).getTime();
    if (!Number.isFinite(nowMs)) throw new RangeError('Invalid server time');
    const arriveByMs = parseZonedDateTime(input.arriveBy);
    if (arriveByMs === null || arriveByMs <= nowMs) {
        return failure(requestId, 'arriveBy', '到着日時は時差付きの未来日時で指定してください');
    }

    const travelMode = TRAVEL_MODES.find((mode) => mode === input.travelMode);
    if (!travelMode) return failure(requestId, 'travelMode', '移動方法を確認してください');
    if (!(options.supportedTravelModes ?? []).includes(travelMode)) {
        return failure(
            requestId,
            'travelMode',
            'この移動方法は現在対応していません',
            'UNSUPPORTED_MODE',
        );
    }

    const excludedPlaceIds = input.excludedPlaceIds;
    if (
        !Array.isArray(excludedPlaceIds) ||
        excludedPlaceIds.length > 50 ||
        !excludedPlaceIds.every((id): id is string => isText(id, 256))
    ) {
        return failure(requestId, 'excludedPlaceIds', '訪問済み地点を確認してください');
    }

    return {
        ok: true,
        value: {
            requestId,
            origin: { latitude: origin.latitude, longitude: origin.longitude },
            destination: { placeId: destination.placeId },
            arriveBy: input.arriveBy as string,
            travelMode,
            excludedPlaceIds: [...excludedPlaceIds],
        },
    };
}

export function validateItineraryRequest(
    input: unknown,
    options: ValidationOptions = {},
): ValidationResult<ValidateItineraryRequest> {
    const base = validateRecommendationsRequest(input, options);
    if (!base.ok) return base;
    // Successful base validation proves the body is an object.
    const selection = input as Record<string, unknown>;
    for (const field of ['selectedPlaceId', 'experienceId', 'optionToken'] as const) {
        if (!isText(selection[field], field === 'optionToken' ? 4096 : 256)) {
            return failure(base.value.requestId, field, '選択した候補を確認してください');
        }
    }
    return {
        ok: true,
        value: {
            ...base.value,
            selectedPlaceId: selection.selectedPlaceId as string,
            experienceId: selection.experienceId as string,
            optionToken: selection.optionToken as string,
        },
    };
}
