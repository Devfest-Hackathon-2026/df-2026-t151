import { googleAdcHeaders, projectPattern, usableCredential } from './google-adc.ts';
import { GoogleServiceError } from './google-service-error.ts';

export interface MapsAuthSettings {
    GOOGLE_MAPS_AUTH_MODE?: string;
    GOOGLE_CLOUD_PROJECT?: string;
    GOOGLE_MAPS_API_KEY?: string;
}

export type MapsAuthentication =
    | { mode: 'api-key'; apiKey: string | undefined }
    | {
          mode: 'service-account';
          projectId: string;
          // Trusted server-side injection for tests; never populated from request data.
          getAccessToken?: () => Promise<string | null | undefined>;
      };

export function mapsAuthentication(
    settings: MapsAuthSettings = {
        GOOGLE_MAPS_AUTH_MODE: process.env.GOOGLE_MAPS_AUTH_MODE,
        GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
        GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
    },
): MapsAuthentication | null {
    const mode = settings.GOOGLE_MAPS_AUTH_MODE?.trim() || 'api-key';
    if (mode === 'service-account') {
        const projectId = settings.GOOGLE_CLOUD_PROJECT?.trim();
        return projectId && projectPattern.test(projectId) ? { mode, projectId } : null;
    }
    const apiKey = settings.GOOGLE_MAPS_API_KEY?.trim();
    return mode === 'api-key' && usableCredential(apiKey) ? { mode, apiKey } : null;
}

export function apiKeyHeaders(apiKey: string | undefined): Record<string, string> {
    const key = apiKey?.trim();
    if (!usableCredential(key)) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    return { 'X-Goog-Api-Key': key };
}

export async function mapsAuthHeaders(
    authentication: MapsAuthentication | null,
    signal: AbortSignal,
): Promise<Record<string, string>> {
    if (!authentication) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    if (authentication.mode === 'api-key') return apiKeyHeaders(authentication.apiKey);
    return googleAdcHeaders(authentication, signal);
}
