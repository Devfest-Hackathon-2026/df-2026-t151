import type { ApiWarning, Attribution, Place, RecommendationsRequest } from '../../lib/api/types';
import type { CandidateExclusion } from '../../lib/api/types';
import type { ExteriorAccessEvidence } from '../exterior-access';
import type { InteriorAccessEvidence } from '../interior-access';

export interface GroundedDetour {
    placeId: string;
    sourceTitle: string;
    sourceUrl: string;
    title: string;
    description: string;
    accessEvidence?: ExteriorAccessEvidence;
    interiorAccessEvidence?: InteriorAccessEvidence;
    sources: { title: string; url: string }[];
}
export interface GroundedDetoursResult {
    exclusions?: CandidateExclusion[];
    candidates: GroundedDetour[];
    warnings: ApiWarning[];
    attributions: Attribution[];
}
export interface GroundedDetourInput {
    request: RecommendationsRequest;
    destination: Place;
    selectedPlace?: Place;
    selectedExperienceId?: string;
}

export interface GroundingEvidence {
    answerText: string;
    metadata: Record<string, unknown>;
    sources: { placeId: string; title: string }[];
    statementRefs: Record<string, string>;
}
