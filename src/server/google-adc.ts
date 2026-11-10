import { GoogleAuth } from 'google-auth-library';
import { GoogleServiceError, upstreamUnavailable } from './google-service-error.ts';

export const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export interface AdcAuthentication {
    projectId: string;
    // Trusted server-side injection for tests; never populated from request data.
    getAccessToken?: () => Promise<string | null | undefined>;
}
export function usableCredential(value: string | undefined | null): value is string {
    return typeof value === 'string' && value.length > 0 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

// Cloud Run uses its attached identity. No service-account private key is issued.
const adc = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    clientOptions: { transporterOptions: { timeout: 2000, retry: false } },
});

function tokenBeforeAbort(
    getAccessToken: NonNullable<AdcAuthentication['getAccessToken']>,
    signal: AbortSignal,
): Promise<string | null | undefined> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new GoogleServiceError(504, 'TIMEOUT', true));
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
        // Observe late failures after a timeout, without exposing provider error details.
        Promise.resolve()
            .then(getAccessToken)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
    });
}

export async function googleAdcHeaders(
    authentication: AdcAuthentication,
    signal: AbortSignal,
): Promise<Record<string, string>> {
    if (!projectPattern.test(authentication.projectId))
        throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    try {
        const token = await tokenBeforeAbort(
            authentication.getAccessToken ?? (() => adc.getAccessToken()),
            signal,
        );
        if (!usableCredential(token)) throw upstreamUnavailable(false);
        return {
            Authorization: `Bearer ${token}`,
            'X-Goog-User-Project': authentication.projectId,
        };
    } catch (error) {
        if (error instanceof GoogleServiceError) throw error;
        if (signal.aborted) throw new GoogleServiceError(504, 'TIMEOUT', true);
        throw upstreamUnavailable();
    }
}
