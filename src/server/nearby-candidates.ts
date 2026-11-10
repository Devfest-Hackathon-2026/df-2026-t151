import type { Attribution, Coordinates, Place } from '../lib/api/types';
import { GoogleServiceError, googlePostJson, upstreamUnavailable } from './google-http.ts';
import type { GoogleRequestOptions } from './google-http';
import { parseAttributions, parseGooglePlace } from './places.ts';
import { parseOpeningSchedule } from './opening-hours.ts';
import type { OpeningSchedule } from './opening-hours';
import { parsePlaceRelations } from './place-relations.ts';
import type { PlaceRelations } from './place-relations';
import type { ExteriorAccessEvidence } from './exterior-access';
import type { InteriorAccessEvidence } from './interior-access';

export interface PlaceCandidate {
    proposedExperienceId?: string;
    place: Place;
    types: string[];
    businessStatus: string | null;
    opening: OpeningSchedule;
    sourceUrl: string | null;
    retrievedAt: string;
    attributions: Attribution[];
    relations: PlaceRelations;
    accessEvidence?: ExteriorAccessEvidence;
    interiorAccessEvidence?: InteriorAccessEvidence;
    groundedExperience?: {
        title: string;
        description: string;
        sourceTitle: string;
        sourceUrl: string;
        sources: { title: string; url: string }[];
    };
}
interface NearbyOptions extends GoogleRequestOptions {
    radiusMeters?: number;
    now?: () => Date;
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function searchNearbyCandidates(
    origin: Coordinates,
    options: NearbyOptions,
): Promise<PlaceCandidate[]> {
    const radius = options.radiusMeters ?? 3000;
    if (
        !origin ||
        typeof origin.latitude !== 'number' ||
        !Number.isFinite(origin.latitude) ||
        Math.abs(origin.latitude) > 90 ||
        typeof origin.longitude !== 'number' ||
        !Number.isFinite(origin.longitude) ||
        Math.abs(origin.longitude) > 180 ||
        !Number.isSafeInteger(radius) ||
        radius < 1 ||
        radius > 3000
    )
        throw new GoogleServiceError(400, 'INVALID_INPUT', false);
    const now = options.now ?? (() => new Date());
    const startedAt = now();
    if (!Number.isFinite(startedAt.getTime()))
        throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const payload = await googlePostJson(
        'nearby',
        {
            includedTypes: ['park', 'tourist_attraction', 'museum', 'art_gallery'],
            maxResultCount: 6,
            rankPreference: 'DISTANCE',
            languageCode: 'ja',
            locationRestriction: {
                circle: {
                    center: { latitude: origin.latitude, longitude: origin.longitude },
                    radius,
                },
            },
        },
        options,
    );
    if (
        !record(payload) ||
        'error' in payload ||
        (payload.places !== undefined && !Array.isArray(payload.places))
    )
        throw upstreamUnavailable();
    const finishedAt = now().getTime();
    if (!Number.isFinite(finishedAt)) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const retrievedAt = new Date(Math.max(startedAt.getTime(), finishedAt)).toISOString();
    return ((payload.places ?? []) as unknown[])
        .slice(0, 6)
        .map((value) => parsePlaceCandidate(value, startedAt.toISOString(), retrievedAt));
}

export function parsePlaceCandidate(
    value: unknown,
    requestedAt: string,
    retrievedAt: string,
): PlaceCandidate {
    const place = parseGooglePlace(value);
    if (!record(value)) throw upstreamUnavailable();
    const types = value.types ?? [];
    if (
        !Array.isArray(types) ||
        types.length > 100 ||
        !types.every((type) => typeof type === 'string' && type.length <= 100)
    )
        throw upstreamUnavailable();
    let sourceUrl: string | null = null;
    if (value.googleMapsUri !== undefined) {
        if (typeof value.googleMapsUri !== 'string' || value.googleMapsUri.length > 2048)
            throw upstreamUnavailable();
        try {
            const url = new URL(value.googleMapsUri);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
                throw upstreamUnavailable();
            sourceUrl = value.googleMapsUri;
        } catch {
            throw upstreamUnavailable();
        }
    }
    return {
        place,
        types: [...types],
        businessStatus: typeof value.businessStatus === 'string' ? value.businessStatus : null,
        relations: parsePlaceRelations(value),
        opening: parseOpeningSchedule(
            value.currentOpeningHours,
            value.utcOffsetMinutes,
            requestedAt,
        ),
        sourceUrl,
        retrievedAt,
        attributions: [
            { provider: 'Google Maps', providerUri: 'https://maps.google.com/' },
            ...parseAttributions(value.attributions),
        ],
    };
}
