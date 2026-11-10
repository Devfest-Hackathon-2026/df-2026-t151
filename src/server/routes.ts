import { TRAVEL_MODES } from '../lib/api/types.ts';
import type { ApiWarning, Attribution, Coordinates, TravelMode } from '../lib/api/types';
import { GoogleServiceError, googlePostJson, upstreamUnavailable } from './google-http.ts';
import type { GoogleRequestOptions } from './google-http';

export type RouteWaypoint = Coordinates | { placeId: string };
export interface WalkingRouteInput {
    origin: RouteWaypoint;
    destination: RouteWaypoint;
    travelMode: TravelMode;
}
export interface WalkingRoute {
    travelMode: 'WALK';
    durationSeconds: number;
    distanceMeters: number;
    provider: 'Google Routes';
    warnings: ApiWarning[];
    attributions: Attribution[];
}

export class RouteNotFoundError extends GoogleServiceError {
    readonly reason = 'NO_ROUTE';
    constructor() {
        super(502, 'UPSTREAM_UNAVAILABLE', false);
        this.name = 'RouteNotFoundError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function waypoint(value: unknown): Record<string, unknown> {
    const invalid = () => new GoogleServiceError(400, 'INVALID_INPUT', false);
    if (!isRecord(value)) throw invalid();
    if ('placeId' in value) {
        if (
            typeof value.placeId !== 'string' ||
            value.placeId.trim().length === 0 ||
            value.placeId.length > 256 ||
            /[\u0000-\u001f\u007f]/.test(value.placeId) ||
            'latitude' in value ||
            'longitude' in value
        )
            throw invalid();
        return { placeId: value.placeId };
    }
    const { latitude, longitude } = value;
    if (
        typeof latitude !== 'number' ||
        !Number.isFinite(latitude) ||
        latitude < -90 ||
        latitude > 90 ||
        typeof longitude !== 'number' ||
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180
    )
        throw invalid();
    return { location: { latLng: { latitude, longitude } } };
}

/** Round fractional provider seconds upward without floating-point truncation. */
function durationSeconds(value: unknown): number {
    if (typeof value !== 'string') throw upstreamUnavailable();
    const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,9}))?s$/.exec(value);
    if (!match) throw upstreamUnavailable();
    const whole = Number(match[1]);
    if (whole > 315576000000) throw upstreamUnavailable();
    return whole + (/[1-9]/.test(match[2] ?? '') ? 1 : 0);
}

/** Obtain one walking estimate. Other travel modes are explicitly unsupported. */
export async function computeWalkingRoute(
    input: WalkingRouteInput,
    options: GoogleRequestOptions,
): Promise<WalkingRoute> {
    if (!TRAVEL_MODES.some((mode) => mode === input.travelMode))
        throw new GoogleServiceError(400, 'INVALID_INPUT', false);
    if (input.travelMode !== 'WALK') throw new GoogleServiceError(422, 'UNSUPPORTED_MODE', false);
    const origin = waypoint(input.origin);
    const destination = waypoint(input.destination);
    const payload = await googlePostJson(
        'routes',
        {
            origin,
            destination,
            travelMode: 'WALK',
            computeAlternativeRoutes: false,
            languageCode: 'ja',
            units: 'METRIC',
        },
        options,
    );
    if (!isRecord(payload) || 'error' in payload) throw upstreamUnavailable();
    if (
        payload.routes === undefined ||
        (Array.isArray(payload.routes) && payload.routes.length === 0)
    ) {
        throw new RouteNotFoundError();
    }
    if (
        !Array.isArray(payload.routes) ||
        payload.routes.length !== 1 ||
        !isRecord(payload.routes[0])
    )
        throw upstreamUnavailable();
    const route = payload.routes[0];
    const seconds = durationSeconds(route.duration);
    if (
        typeof route.distanceMeters !== 'number' ||
        !Number.isSafeInteger(route.distanceMeters) ||
        route.distanceMeters < 0
    ) {
        throw upstreamUnavailable();
    }
    const rawWarnings = route.warnings ?? [];
    if (
        !Array.isArray(rawWarnings) ||
        rawWarnings.length > 32 ||
        !rawWarnings.every(
            (warning) =>
                typeof warning === 'string' && warning.trim().length > 0 && warning.length <= 2048,
        )
    ) {
        throw upstreamUnavailable();
    }
    return {
        travelMode: 'WALK',
        durationSeconds: seconds,
        distanceMeters: route.distanceMeters,
        provider: 'Google Routes',
        warnings: [
            {
                code: 'WALKING_BETA',
                message:
                    '徒歩経路はベータ版で、歩道や歩行者用通路の情報が不足している場合があります。現地の状況を確認してください',
            },
            ...[...new Set<string>(rawWarnings)].map((message) => ({
                code: 'ROUTE_WARNING',
                message,
            })),
        ],
        attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com/' }],
    };
}
