/** Browser-safe API contract. Import types from this module with `import type`. */
export const TRAVEL_MODES = ['WALK', 'TRANSIT', 'DRIVE', 'BICYCLE'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];
export type DataMode = 'live' | 'demo';
export type DateTimeString = string;

export interface Coordinates {
    latitude: number;
    longitude: number;
}

export interface Place extends Coordinates {
    placeId: string;
    label: string;
}

export interface PlacesQuery {
    requestId: string;
    query: string;
}

export interface RecommendationsRequest {
    requestId: string;
    origin: Coordinates;
    destination: { placeId: string };
    arriveBy: DateTimeString;
    travelMode: TravelMode;
    excludedPlaceIds: string[];
}

export interface ValidateItineraryRequest extends RecommendationsRequest {
    selectedPlaceId: string;
    experienceId: string;
    optionToken: string;
}

export interface CapabilitiesResponse {
    apiVersion: 'v1';
    supportedTravelModes: TravelMode[];
    areaLabel: string;
    areaBoundaryConfigured: boolean;
    dataMode: DataMode;
}

export type ApiErrorCode =
    | 'INVALID_INPUT'
    | 'UNSUPPORTED_MODE'
    | 'OUT_OF_AREA'
    | 'RATE_LIMITED'
    | 'UPSTREAM_UNAVAILABLE'
    | 'TIMEOUT'
    | 'INTERNAL_ERROR';

export interface ApiErrorResponse {
    requestId: string;
    error: {
        code: ApiErrorCode;
        message: string;
        field: string | null;
        retryable: boolean;
    };
}

export interface ApiWarning {
    code: string;
    message: string;
}

export interface CandidateExclusion {
    stage: string;
    placeLabel: string;
    reason: string;
    source: Source;
    facts: Record<string, JsonValue>;
}

export interface Source {
    provider: string;
    url: string | null;
}

/** Structured attributions must be adapted to the selected provider's terms. */
export type Attribution = string | { [key: string]: JsonValue };
export type JsonValue =
    null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ContextInformation<Status extends string> {
    status: Status;
    provider: string | null;
    retrievedAt: DateTimeString | null;
    validAt: DateTimeString | null;
    summary: string;
    sourceUrl: string | null;
}

export type WeatherInformation = ContextInformation<'available' | 'unknown' | 'unavailable'>;
export type CrowdInformation = ContextInformation<
    'observed' | 'historical' | 'estimated' | 'unknown' | 'unavailable'
>;

export interface ExperienceDuration {
    minSeconds: number;
    maxSeconds: number;
    sourceType: 'registered' | 'official' | 'external_statistics' | 'estimate';
    sourceUrl: string | null;
    checkedAt: DateTimeString;
    includesWait: boolean | null;
    conditions: string;
}

export interface OptionTime {
    legToStopSeconds: number;
    /** Additional queue allowance; estimated values carry ESTIMATED_WAIT and isProvisional. */
    waitSeconds: number | null;
    waitTreatment: 'separate' | 'included' | 'not_applicable' | 'unknown';
    experienceSeconds: number;
    legToDestinationSeconds: number;
    bufferSeconds: number;
    requiredSeconds: number;
    extraTravelSeconds: number;
    stopArrivalAt: DateTimeString;
    experienceStartAt: DateTimeString;
    stopDepartureAt: DateTimeString;
    arrivalAt: DateTimeString;
    slackSeconds: number;
    isProvisional: boolean;
}

export interface RecommendationOption {
    optionId: string;
    optionToken: string;
    place: Place;
    experienceId: string;
    title: string;
    description: string;
    recommendationReasons: string[];
    experienceDuration: ExperienceDuration;
    time: OptionTime;
    opening: {
        status: 'verified_for_plan' | 'unknown';
        provider: string;
        retrievedAt: DateTimeString;
        sourceUrl: string | null;
    };
    crowd: CrowdInformation;
    cost: { amount: number | null; currency: string; label: string };
    sources: Source[];
    warnings: ApiWarning[];
}

export interface PlaceSearchMatch extends Place {
    address?: string;
    typeLabel?: string;
}

export interface PlacesResponse {
    requestId: string;
    places: PlaceSearchMatch[];
    attributions: Attribution[];
}

export interface RecommendationsResponse {
    exclusions?: CandidateExclusion[];
    requestId: string;
    dataMode: DataMode;
    calculatedAt: DateTimeString;
    arriveBy: DateTimeString;
    outcome: 'OPTIONS' | 'NO_OPTIONS' | 'DIRECT_LATE';
    destination: Place;
    direct: { durationSeconds: number; arrivalAt: DateTimeString };
    context: { weather: WeatherInformation; crowd: CrowdInformation };
    options: RecommendationOption[];
    warnings: ApiWarning[];
    attributions: Attribution[];
}

export type ValidateItineraryResponse = {
    exclusions?: CandidateExclusion[];
    requestId: string;
    calculatedAt: DateTimeString;
    warnings: ApiWarning[];
    attributions: Attribution[];
} & (
    | { status: 'VALID'; option: RecommendationOption }
    | { status: 'NO_LONGER_FEASIBLE' | 'EXPIRED'; option: null }
);
