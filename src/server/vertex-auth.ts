import { GoogleServiceError } from './google-service-error.ts';
import { projectPattern } from './google-adc.ts';
import type { AdcAuthentication } from './google-adc';

export interface VertexAuthSettings {
    GOOGLE_CLOUD_PROJECT?: string;
    GOOGLE_CLOUD_LOCATION?: string;
}
export interface VertexAuthentication extends AdcAuthentication {
    location: string;
}
const locationPattern = /^(?:global|[a-z]+(?:-[a-z]+)+[1-9][0-9]*)$/;
function validLocation(location: string): boolean {
    return location.length <= 63 && locationPattern.test(location);
}

export function vertexAuthentication(
    settings: VertexAuthSettings = {
        GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
        GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION,
    },
): VertexAuthentication | null {
    const projectId = settings.GOOGLE_CLOUD_PROJECT?.trim();
    const location = settings.GOOGLE_CLOUD_LOCATION?.trim() || 'global';
    return projectId && projectPattern.test(projectId) && validLocation(location)
        ? { projectId, location }
        : null;
}

/** Only the validated project/location vary; service, model and operation stay server-owned. */
export function vertexGenerateContentUrl(authentication: VertexAuthentication | null): string {
    if (
        !authentication ||
        !projectPattern.test(authentication.projectId) ||
        !validLocation(authentication.location)
    )
        throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const host =
        authentication.location === 'global'
            ? 'aiplatform.googleapis.com'
            : `${authentication.location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${authentication.projectId}/locations/${authentication.location}/publishers/google/models/gemini-3.5-flash:generateContent`;
}
