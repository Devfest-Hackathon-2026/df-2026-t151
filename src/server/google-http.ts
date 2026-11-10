import type { Coordinates } from '../lib/api/types';
import { GoogleServiceError, upstreamUnavailable } from './google-service-error.ts';
import { mapsAuthentication, mapsAuthHeaders } from './maps-auth.ts';
import type { MapsAuthentication } from './maps-auth';
import { googleAdcHeaders } from './google-adc.ts';
import { vertexAuthentication, vertexGenerateContentUrl } from './vertex-auth.ts';
import type { VertexAuthentication } from './vertex-auth';
export { GoogleServiceError, upstreamUnavailable } from './google-service-error.ts';

const SERVICES = {
    places: {
        url: 'https://places.googleapis.com/v1/places:searchText',
        fields: 'places.id,places.displayName,places.formattedAddress,places.primaryTypeDisplayName,places.location,places.attributions',
    },
    routes: {
        url: 'https://routes.googleapis.com/directions/v2:computeRoutes',
        fields: 'routes.duration,routes.distanceMeters,routes.warnings',
    },
    nearby: {
        url: 'https://places.googleapis.com/v1/places:searchNearby',
        fields: 'places.id,places.displayName,places.location,places.types,places.businessStatus,places.currentOpeningHours,places.utcOffsetMinutes,places.googleMapsUri,places.attributions,places.containingPlaces,places.subDestinations',
    },
    vertexMaps: {
        url: null,
        fields: '',
    },
} as const;

export interface GoogleRequestOptions {
    apiKey?: string;
    vertexAuthentication?: VertexAuthentication | null;
    mapsAuthentication?: MapsAuthentication;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
}

async function readJson(response: Response): Promise<unknown> {
    if (!response.body) throw upstreamUnavailable();
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 1024 * 1024) {
                await reader.cancel();
                throw upstreamUnavailable();
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
        return JSON.parse(text + decoder.decode()) as unknown;
    } finally {
        reader.releaseLock();
    }
}

/** Fixed Google services only. One request, bounded time/size, no raw errors or logging. */
export async function googlePostJson(
    service: keyof typeof SERVICES,
    body: Record<string, unknown>,
    options: GoogleRequestOptions,
): Promise<unknown> {
    const vertex =
        service === 'vertexMaps'
            ? options.vertexAuthentication === undefined
                ? vertexAuthentication()
                : options.vertexAuthentication
            : undefined;
    return googleRequest(
        service === 'vertexMaps'
            ? vertexGenerateContentUrl(vertex ?? null)
            : SERVICES[service].url!,
        SERVICES[service].fields,
        'POST',
        body,
        options,
        vertex,
    );
}

/** Place IDs cannot alter the fixed Google host or resource path. */
export async function googlePlaceDetails(
    placeId: string,
    includeHours: boolean,
    options: GoogleRequestOptions,
): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(placeId))
        throw new GoogleServiceError(400, 'INVALID_INPUT', false);
    const fields = includeHours
        ? 'id,displayName,location,types,businessStatus,currentOpeningHours,utcOffsetMinutes,googleMapsUri,attributions,containingPlaces,subDestinations'
        : 'id,displayName,location,attributions,containingPlaces,subDestinations';
    return googleRequest(
        `https://places.googleapis.com/v1/places/${placeId}?languageCode=ja`,
        fields,
        'GET',
        undefined,
        options,
    );
}

export function googleHourlyForecast(
    location: Coordinates,
    hours: number,
    options: GoogleRequestOptions,
): Promise<unknown> {
    const query = new URLSearchParams({
        'location.latitude': String(location.latitude),
        'location.longitude': String(location.longitude),
        hours: String(hours),
        pageSize: String(hours),
        languageCode: 'ja',
    });
    return googleRequest(
        `https://weather.googleapis.com/v1/forecast/hours:lookup?${query}`,
        '',
        'GET',
        undefined,
        options,
    );
}

async function googleRequest(
    url: string,
    fields: string,
    method: 'GET' | 'POST',
    body: Record<string, unknown> | undefined,
    options: GoogleRequestOptions,
    vertex?: VertexAuthentication | null,
): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
        throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        if (controller.signal.aborted) throw new GoogleServiceError(504, 'TIMEOUT', true);
        const authorization = vertex
            ? await googleAdcHeaders(vertex, controller.signal)
            : await mapsAuthHeaders(
                  options.mapsAuthentication ??
                      mapsAuthentication({
                          GOOGLE_MAPS_AUTH_MODE: process.env.GOOGLE_MAPS_AUTH_MODE,
                          GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
                          GOOGLE_MAPS_API_KEY: options.apiKey,
                      }),
                  controller.signal,
              );
        if (controller.signal.aborted) throw new GoogleServiceError(504, 'TIMEOUT', true);
        const response = await (options.fetch ?? globalThis.fetch)(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...authorization,
                ...(fields && { 'X-Goog-FieldMask': fields }),
            },
            ...(body !== undefined && { body: JSON.stringify(body) }),
            cache: 'no-store',
            redirect: 'error',
            signal: controller.signal,
        });
        if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            if (response.status === 429) throw new GoogleServiceError(429, 'RATE_LIMITED', true);
            if (response.status === 504 || response.status === 408)
                throw new GoogleServiceError(504, 'TIMEOUT', true);
            throw upstreamUnavailable(response.status >= 500);
        }
        return await readJson(response);
    } catch (error) {
        if (error instanceof GoogleServiceError) throw error;
        if (controller.signal.aborted) throw new GoogleServiceError(504, 'TIMEOUT', true);
        throw upstreamUnavailable();
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
    }
}
