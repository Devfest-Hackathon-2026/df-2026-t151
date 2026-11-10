import { googlePlaceDetails, GoogleServiceError, upstreamUnavailable } from './google-http.ts';
import type { GoogleRequestOptions } from './google-http';
import { parseGooglePlace, parseAttributions } from './places.ts';
import { parsePlaceCandidate } from './nearby-candidates.ts';
import { parsePlaceRelations } from './place-relations.ts';

interface DetailsOptions extends GoogleRequestOptions {
    now?: () => Date;
}

export async function getDestination(placeId: string, options: DetailsOptions) {
    const payload = await googlePlaceDetails(placeId, false, options);
    const place = parseGooglePlace(payload);
    if (place.placeId !== placeId) throw upstreamUnavailable(false);
    const raw = payload as Record<string, unknown>;
    return {
        place,
        relations: parsePlaceRelations(raw),
        attributions: [
            { provider: 'Google Maps', providerUri: 'https://maps.google.com/' },
            ...parseAttributions(raw.attributions),
        ],
    };
}

export async function getCandidateDetails(placeId: string, options: DetailsOptions) {
    const now = options.now ?? (() => new Date());
    const started = now().getTime();
    if (!Number.isFinite(started)) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const payload = await googlePlaceDetails(placeId, true, options);
    const finished = now().getTime();
    if (!Number.isFinite(finished)) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const candidate = parsePlaceCandidate(
        payload,
        new Date(started).toISOString(),
        new Date(Math.max(started, finished)).toISOString(),
    );
    if (candidate.place.placeId !== placeId) throw upstreamUnavailable(false);
    return candidate;
}
