import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RecommendationsRequest, ValidateItineraryRequest } from '../lib/api/types';
import { GoogleServiceError } from './google-http.ts';

export const OPTION_TOKEN_TTL_MS = 5 * 60000;
interface Claims {
    id: string;
    placeId: string;
    experienceId: string;
    binding: string;
    issued: number;
    expires: number;
}
export function hasSigningSecret(secret: string | undefined): secret is string {
    return (
        typeof secret === 'string' &&
        secret.length >= 32 &&
        secret.length <= 256 &&
        !/[\s\u0000-\u001f\u007f]/.test(secret)
    );
}
function signingSecret(secret: string | undefined): string {
    if (!hasSigningSecret(secret)) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    return secret;
}
function mac(value: string, secret: string): string {
    return createHmac('sha256', secret).update(value).digest('base64url');
}
// Origin may change for recalculation. No coordinates, query or visited history are stored in tokens.
function binding(input: RecommendationsRequest, secret: string): string {
    return mac(
        JSON.stringify([input.destination.placeId, Date.parse(input.arriveBy), input.travelMode]),
        secret,
    );
}

export function issueOptionToken(
    input: RecommendationsRequest,
    selection: { placeId: string; experienceId: string },
    secret: string | undefined,
    now: number,
) {
    const key = signingSecret(secret);
    if (!Number.isSafeInteger(now) || !Number.isFinite(now + OPTION_TOKEN_TTL_MS))
        throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const claims: Claims = {
        id: randomUUID(),
        ...selection,
        binding: binding(input, key),
        issued: now,
        expires: now + OPTION_TOKEN_TTL_MS,
    };
    const payload = `v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return { optionId: claims.id, optionToken: `${payload}.${mac(payload, key)}` };
}

/**
 * Verify a selection before fetching updated place and route information.
 *
 * @param input - Selected place and experience, plus the original destination, deadline and travel mode. The origin may change.
 * @param secret - The same server-side signing secret used to issue the token.
 * @param now - Server time in Unix milliseconds.
 * @returns The option ID and whether the matching token is valid or expired.
 * @throws {GoogleServiceError} When the secret, signature or selection binding is invalid.
 */
export function verifyOptionToken(
    input: ValidateItineraryRequest,
    secret: string | undefined,
    now: number,
): { status: 'valid' | 'expired'; optionId: string } {
    const key = signingSecret(secret);
    const invalid = () => new GoogleServiceError(400, 'INVALID_INPUT', false);
    const parts = input.optionToken.split('.');
    if (
        parts.length !== 3 ||
        parts[0] !== 'v1' ||
        !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
        !/^[A-Za-z0-9_-]{43}$/.test(parts[2]) ||
        input.optionToken.length > 4096
    )
        throw invalid();
    const expected = Buffer.from(mac(`${parts[0]}.${parts[1]}`, key));
    if (!timingSafeEqual(expected, Buffer.from(parts[2]))) throw invalid();
    let claims: Claims;
    try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Claims;
    } catch {
        throw invalid();
    }
    if (
        !claims ||
        typeof claims.id !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(claims.id) ||
        claims.placeId !== input.selectedPlaceId ||
        claims.experienceId !== input.experienceId ||
        claims.binding !== binding(input, key) ||
        !Number.isSafeInteger(claims.issued) ||
        !Number.isSafeInteger(claims.expires) ||
        claims.issued > now ||
        claims.expires - claims.issued !== OPTION_TOKEN_TTL_MS ||
        !Number.isSafeInteger(now)
    )
        throw invalid();
    return { status: now >= claims.expires ? 'expired' : 'valid', optionId: claims.id };
}
