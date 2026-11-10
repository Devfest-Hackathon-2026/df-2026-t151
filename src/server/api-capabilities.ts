import type { CapabilitiesResponse } from '../lib/api/types';
import { hasSigningSecret } from './option-token.ts';
import { vertexAuthentication } from './vertex-auth.ts';
import { mapsAuthentication } from './maps-auth.ts';

export function apiCapabilities(
    settings: {
        GOOGLE_MAPS_API_KEY?: string;
        GOOGLE_MAPS_AUTH_MODE?: string;
        GOOGLE_CLOUD_PROJECT?: string;
        OPTION_TOKEN_SECRET?: string;
        GOOGLE_CLOUD_LOCATION?: string;
    } = {
        GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
        GOOGLE_MAPS_AUTH_MODE: process.env.GOOGLE_MAPS_AUTH_MODE,
        GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
        OPTION_TOKEN_SECRET: process.env.OPTION_TOKEN_SECRET,
        GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION,
    },
): CapabilitiesResponse {
    const enabled =
        !!mapsAuthentication(settings) &&
        hasSigningSecret(settings.OPTION_TOKEN_SECRET) &&
        !!vertexAuthentication(settings);
    return {
        apiVersion: 'v1',
        supportedTravelModes: enabled ? ['WALK'] : [],
        areaLabel: '新宿',
        areaBoundaryConfigured: false,
        dataMode: enabled ? 'live' : 'demo',
    };
}
