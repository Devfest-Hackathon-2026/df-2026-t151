import type { Coordinates, Place } from '../api/types';

export interface MapsDirectionsInput {
    origin: Coordinates | undefined;
    originPlaceId?: string;
    originLabel?: string;
    destination: Place;
    stop?: Place | null;
}

function validCoordinates(point: Coordinates | undefined): point is Coordinates {
    return (
        typeof point?.latitude === 'number' &&
        Number.isFinite(point.latitude) &&
        Math.abs(point.latitude) <= 90 &&
        typeof point?.longitude === 'number' &&
        Number.isFinite(point.longitude) &&
        Math.abs(point.longitude) <= 180
    );
}
function validPlaceId(id: string): boolean {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id);
}
function validPlace(place: Place): boolean {
    return validCoordinates(place) && validPlaceId(place.placeId);
}
function coordinates(point: Coordinates): string {
    return `${point.latitude},${point.longitude}`;
}
function usableLabel(label: unknown): label is string {
    return typeof label === 'string' && !!label.trim() && !/[|\u0000-\u001f\u007f]/.test(label);
}
function placeText(place: Place): string {
    return usableLabel(place.label) ? place.label : coordinates(place);
}

/** Build only the route the user is viewing; no keys, tokens or arrival promises go to Maps. */
export function googleMapsDirectionsUrl({
    origin,
    originPlaceId,
    originLabel,
    destination,
    stop,
}: MapsDirectionsInput): string | null {
    if (
        !validCoordinates(origin) ||
        !validPlace(destination) ||
        (stop && !validPlace(stop)) ||
        (originPlaceId !== undefined && !validPlaceId(originPlaceId))
    )
        return null;
    const url = new URL('https://www.google.com/maps/dir/');
    url.search = new URLSearchParams({
        api: '1',
        origin: originPlaceId && usableLabel(originLabel) ? originLabel : coordinates(origin),
        destination: placeText(destination),
        destination_place_id: destination.placeId,
        travelmode: 'walking',
    }).toString();
    if (originPlaceId) url.searchParams.set('origin_place_id', originPlaceId);
    if (stop) {
        url.searchParams.set('waypoints', placeText(stop));
        url.searchParams.set('waypoint_place_ids', stop.placeId);
    }
    if (url.href.length > 2048) {
        // Keep all place identities, replacing only display/geocoding text to meet the URL limit.
        url.searchParams.set('origin', coordinates(origin));
        url.searchParams.set('destination', coordinates(destination));
        if (stop) url.searchParams.set('waypoints', coordinates(stop));
    }
    return url.href.length <= 2048 ? url.href : null;
}
