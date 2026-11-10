import type { UnsignedRecommendationOption } from './candidate-assessment';
import { PUBLIC_EXTERIOR_ID } from './exterior-access.ts';

/** Input is already ranked and verified. Never create an exterior just to fill its slot. */
export function selectExperienceMix(
    ranked: readonly UnsignedRecommendationOption[],
): UnsignedRecommendationOption[] {
    const exteriors = ranked.filter((option) => option.experienceId === PUBLIC_EXTERIOR_ID);
    if (!exteriors.length) return [];
    const otherExperiences = ranked.filter((option) => option.experienceId !== PUBLIC_EXTERIOR_ID);
    return [exteriors[0], ...otherExperiences, ...exteriors.slice(1)].slice(0, 3);
}
