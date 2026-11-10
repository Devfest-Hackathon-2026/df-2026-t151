import { googlePostJson, GoogleServiceError } from './google-http.ts';
import type { GoogleRequestOptions } from './google-http';
import type { GroundedDetourInput, GroundedDetoursResult } from './grounded-detours/types';
import {
    parseGroundedDetours,
    prepareGroundingEvidence,
    restoreStatementReferences,
} from './grounded-detours/response.ts';
import {
    buildMapsDiscoveryRequest,
    buildCandidateExtractionRequest,
} from './grounded-detours/requests.ts';

export type {
    GroundedDetour,
    GroundedDetourInput,
    GroundedDetoursResult,
} from './grounded-detours/types';
export { parseGroundedDetours } from './grounded-detours/response.ts';

interface GroundingOptions extends GoogleRequestOptions {
    now?: () => Date;
}
const TOTAL_GENERATION_TIMEOUT_MS = 18000;
const MAPS_DISCOVERY_TIMEOUT_MS = 14000;
const EXTRACTION_TIMEOUT_MS = 5000;

/** Two bounded calls: discover with Maps, extract, then verify against original evidence. */
export async function discoverGroundedDetours(
    input: GroundedDetourInput,
    options: GroundingOptions,
): Promise<GroundedDetoursResult> {
    const now = options.now ?? (() => new Date());
    const started = now().getTime();
    if (!Number.isFinite(started)) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const startMonotonic = performance.now();
    const totalMs = options.timeoutMs ?? TOTAL_GENERATION_TIMEOUT_MS;

    const payload = await googlePostJson('vertexMaps', buildMapsDiscoveryRequest(input), {
        ...options,
        timeoutMs: Math.min(totalMs, MAPS_DISCOVERY_TIMEOUT_MS),
    });
    const evidence = prepareGroundingEvidence(payload);
    if ('candidates' in evidence) return evidence;

    const remaining = Math.floor(totalMs - (performance.now() - startMonotonic));
    if (remaining <= 0) throw new GoogleServiceError(504, 'TIMEOUT', true);
    const structured = await googlePostJson(
        'vertexMaps',
        buildCandidateExtractionRequest(input, evidence),
        {
            ...options,
            timeoutMs: Math.min(EXTRACTION_TIMEOUT_MS, remaining),
        },
    );
    const combined = restoreStatementReferences(
        structured,
        evidence.metadata,
        evidence.statementRefs,
    );
    const finished = now().getTime();
    if (!Number.isFinite(finished)) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    return parseGroundedDetours(
        combined,
        input,
        new Date(Math.max(started, finished)).toISOString(),
    );
}
