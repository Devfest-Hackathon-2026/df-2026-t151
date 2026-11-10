import type { ApiErrorCode } from '../lib/api/types';

/** Only static, public error information may leave the Google transport. */
export class GoogleServiceError extends Error {
    readonly status: 400 | 422 | 429 | 500 | 502 | 504;
    readonly code: ApiErrorCode;
    readonly retryable: boolean;

    constructor(status: GoogleServiceError['status'], code: ApiErrorCode, retryable: boolean) {
        super('Google service request failed');
        this.name = 'GoogleServiceError';
        this.status = status;
        this.code = code;
        this.retryable = retryable;
    }
}

export function upstreamUnavailable(retryable = true): GoogleServiceError {
    return new GoogleServiceError(502, 'UPSTREAM_UNAVAILABLE', retryable);
}
