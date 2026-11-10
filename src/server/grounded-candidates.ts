import type { RecommendationsRequest, Place } from '../lib/api/types';
import { discoverGroundedDetours } from './grounded-detours.ts';
import type { GroundedDetour, GroundedDetourInput } from './grounded-detours';
import { getCandidateDetails } from './place-details.ts';
import type { PlaceCandidate } from './nearby-candidates';
import type { GoogleRequestOptions } from './google-http';
import { GoogleServiceError } from './google-http.ts';
import { uniqueAttributions } from './candidate-assessment.ts';
import { candidateExclusion } from './candidate-diagnostics.ts';

interface CandidateOptions {
    connection: () => GoogleRequestOptions;
    remainingMs: () => number;
    now: () => Date;
    discover?: typeof discoverGroundedDetours;
    getDetails?: typeof getCandidateDetails;
}
function enrich(candidate: PlaceCandidate, proposal: GroundedDetour): PlaceCandidate {
    return {
        ...candidate,
        accessEvidence: proposal.accessEvidence,
        interiorAccessEvidence: proposal.interiorAccessEvidence,
        groundedExperience: {
            title: proposal.title,
            description: proposal.description,
            sourceTitle: proposal.sourceTitle,
            sourceUrl: proposal.sourceUrl,
            sources: proposal.sources,
        },
        attributions: uniqueAttributions([
            ...candidate.attributions,
            { provider: `Google Maps：${proposal.sourceTitle}`, providerUri: proposal.sourceUrl },
        ]),
    };
}
async function discover(input: GroundedDetourInput, options: CandidateOptions) {
    return (options.discover ?? discoverGroundedDetours)(input, {
        ...options.connection(),
        timeoutMs: Math.min(18000, options.remainingMs()),
        now: options.now,
    });
}
// A spatial search bound only. Actual walking time and route validity are checked by Routes.
function searchDistanceMeters(origin: RecommendationsRequest['origin'], place: Place): number {
    const rad = Math.PI / 180;
    const a =
        Math.sin(((place.latitude - origin.latitude) * rad) / 2) ** 2 +
        Math.cos(origin.latitude * rad) *
            Math.cos(place.latitude * rad) *
            Math.sin(((place.longitude - origin.longitude) * rad) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, a)));
}
export async function loadGroundedCandidates(
    input: GroundedDetourInput,
    options: CandidateOptions,
) {
    const result = await discover(input, options);
    const exclusions = [...(result.exclusions ?? [])];
    const candidates: PlaceCandidate[] = [];
    const failures: GoogleServiceError[] = [];
    let cursor = 0;
    const worker = async () => {
        while (cursor < result.candidates.length) {
            const proposal = result.candidates[cursor++];
            let candidate: PlaceCandidate;
            try {
                candidate = await (options.getDetails ?? getCandidateDetails)(proposal.placeId, {
                    ...options.connection(),
                    now: options.now,
                });
            } catch (error) {
                if (!(error instanceof GoogleServiceError) || error.code !== 'UPSTREAM_UNAVAILABLE')
                    throw error;
                failures.push(error);
                exclusions.push({
                    stage: 'discovery',
                    placeLabel: proposal.sourceTitle,
                    reason: 'DETAILS_UNAVAILABLE',
                    source: { provider: 'Google Places', url: null },
                    facts: { retryable: error.retryable },
                });
                continue;
            }
            const distanceMeters = searchDistanceMeters(input.request.origin, candidate.place);
            if (distanceMeters <= 3000 + Number.EPSILON * 3000 * 4)
                candidates.push(enrich(candidate, proposal));
            else {
                exclusions.push(
                    candidateExclusion('OUTSIDE_SEARCH_AREA', candidate, 'discovery', {
                        searchRadiusMeters: 3000,
                        distanceMeters: Math.round(distanceMeters),
                    }),
                );
                result.warnings.push({
                    code: 'AI_CANDIDATE_OUTSIDE_SEARCH',
                    message: '探索範囲を超えるAI候補は除外しました',
                });
            }
        }
    };
    await Promise.all([worker(), worker()]);
    // An outage must remain retryable when no usable candidate survived hydration.
    const retryableFailure = failures.find((error) => error.retryable);
    if (!candidates.length && retryableFailure) throw retryableFailure;
    if (failures.length)
        result.warnings.push({
            code: 'AI_CANDIDATE_DETAILS_UNAVAILABLE',
            message: '施設の詳細情報を取得できなかったAI候補は除外しました',
        });
    candidates.sort(
        (a, b) =>
            result.candidates.findIndex((item) => item.placeId === a.place.placeId) -
            result.candidates.findIndex((item) => item.placeId === b.place.placeId),
    );
    return { candidates, warnings: result.warnings, attributions: result.attributions, exclusions };
}
export async function refreshGroundedCandidate(
    candidate: PlaceCandidate,
    input: GroundedDetourInput,
    options: CandidateOptions,
) {
    const result = await discover({ ...input, selectedPlace: candidate.place }, options);
    const proposal = result.candidates.find(
        (item) =>
            item.placeId === candidate.place.placeId &&
            (!input.selectedExperienceId ||
                (item.interiorAccessEvidence?.experienceId ?? item.accessEvidence?.experienceId) ===
                    input.selectedExperienceId),
    );
    return {
        candidate: proposal
            ? enrich(candidate, proposal)
            : {
                  ...candidate,
                  accessEvidence: undefined,
                  interiorAccessEvidence: undefined,
                  groundedExperience: undefined,
              },
        warnings: result.warnings,
        attributions: result.attributions,
        exclusions: result.exclusions ?? [],
    };
}
