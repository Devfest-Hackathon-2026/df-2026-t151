import type { Attribution, Place, PlaceSearchMatch, PlacesResponse } from '../lib/api/types';
import { validatePlacesQuery } from './request-validation.ts';
import {
    GoogleServiceError as PlacesServiceError,
    googlePostJson,
    upstreamUnavailable as unavailable,
} from './google-http.ts';
import type { GoogleRequestOptions } from './google-http';

export { GoogleServiceError as PlacesServiceError } from './google-http.ts';
const MAX_RESULTS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, limit: number): value is string {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= limit &&
        !/[\u0000-\u001f\u007f]/.test(value)
    );
}

export function parseAttributions(value: unknown): Attribution[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20) throw unavailable();
    return value.map((entry) => {
        if (!isRecord(entry) || !isText(entry.provider, 512)) throw unavailable();
        let providerUri: string | null = null;
        if (entry.providerUri !== undefined && entry.providerUri !== '') {
            if (!isText(entry.providerUri, 2048)) throw unavailable();
            const url = new URL(entry.providerUri);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
                throw unavailable();
            providerUri = entry.providerUri;
        }
        return { provider: entry.provider, providerUri };
    });
}

export function parseGooglePlace(raw: unknown): Place {
    if (
        !isRecord(raw) ||
        !isText(raw.id, 256) ||
        !isRecord(raw.displayName) ||
        !isText(raw.displayName.text, 512) ||
        !isRecord(raw.location)
    )
        throw unavailable();
    const { latitude, longitude } = raw.location;
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
        throw unavailable();
    return { placeId: raw.id, label: raw.displayName.text, latitude, longitude };
}

function parseResult(payload: unknown): Omit<PlacesResponse, 'requestId'> {
    if (!isRecord(payload) || 'error' in payload) throw unavailable();
    // Protobuf JSON may omit an empty repeated field.
    const rawPlaces = payload.places === undefined ? [] : payload.places;
    if (!Array.isArray(rawPlaces)) throw unavailable();
    const places: PlaceSearchMatch[] = [];
    const attributions: Attribution[] = [
        { provider: 'Google Maps', providerUri: 'https://maps.google.com/' },
    ];
    const attributionKeys = new Set(attributions.map((entry) => JSON.stringify(entry)));
    for (const raw of rawPlaces.slice(0, MAX_RESULTS)) {
        const place = parseGooglePlace(raw);
        if (!isRecord(raw)) throw unavailable();
        const address = raw.formattedAddress;
        const typeLabel = isRecord(raw.primaryTypeDisplayName)
            ? raw.primaryTypeDisplayName.text
            : undefined;
        places.push({
            ...place,
            ...(isText(address, 512) && { address: address.trim() }),
            ...(isText(typeLabel, 120) && { typeLabel: typeLabel.trim() }),
        });
        for (const attribution of parseAttributions(raw.attributions)) {
            const key = JSON.stringify(attribution);
            if (!attributionKeys.has(key)) {
                attributions.push(attribution);
                attributionKeys.add(key);
            }
        }
    }
    return { places, attributions };
}

/** One bounded request, no retries, persistence, logging or demo fallback. */
export async function searchPlaces(
    query: string,
    options: GoogleRequestOptions,
): Promise<Omit<PlacesResponse, 'requestId'>> {
    if (!validatePlacesQuery({ requestId: 'server-validation', query }).ok) {
        throw new PlacesServiceError(400, 'INVALID_INPUT', false);
    }
    try {
        return parseResult(
            await googlePostJson(
                'places',
                {
                    textQuery: query,
                    languageCode: 'ja',
                    regionCode: 'JP',
                    pageSize: MAX_RESULTS,
                },
                options,
            ),
        );
    } catch (error) {
        if (error instanceof PlacesServiceError) throw error;
        throw unavailable();
    }
}
