import { GoogleServiceError } from '../google-http.ts';
import { PUBLIC_EXTERIOR_ID } from '../exterior-access.ts';
import type { CandidateExperience } from '../candidate-assessment';
import type { PlaceCandidate } from '../nearby-candidates';
import type { DurationEvidence } from '../duration-evidence';
import { candidateExperienceId } from '../candidate-access.ts';
import { candidateConditions } from '../candidate-conditions.ts';
import { indoorProfileForId, EXIT_SECONDS } from '../experience-profiles.ts';
const categories = [
    { type: 'museum', min: 300, max: 600 },
    { type: 'art_gallery', min: 300, max: 600 },
    { type: 'park', min: 600, max: 1200 },
    { type: 'tourist_attraction', min: 300, max: 900 },
] as const;

export function exteriorExperience(
    candidate: PlaceCandidate,
    at: string,
    evidence: readonly DurationEvidence[],
    destinationPlaceId: string,
): CandidateExperience | null {
    if (candidateConditions(candidate, destinationPlaceId, at).blockedReason) return null;
    const category = categories.find((item) => candidate.types.includes(item.type));
    if (!category) return null;
    const experienceId = PUBLIC_EXTERIOR_ID;
    const provisional = candidateConditions(candidate, destinationPlaceId, at).unknowns.length > 0;
    const matching = evidence.filter(
        (item) => item.placeId === candidate.place.placeId && item.experienceId === experienceId,
    );
    if (matching.length > 63) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    return {
        experienceId,
        title:
            candidate.groundedExperience?.title ??
            `${candidate.place.label}の外観・周辺の景観を見比べる`,
        description:
            candidate.groundedExperience?.description ??
            (provisional
                ? '外観や周辺景観を観察する案です。入場せず利用できるかなど、未確認の条件は行程画面で確認してください。'
                : '公開情報に基づき、入場を伴わず外観や周辺景観を観察する体験として選定しました。飲食・予約は含めません。現地の表示に従ってください。'),
        accessDestinationPlaceId: destinationPlaceId,
        wait: { status: 'not_applicable' },
        admission: { status: 'not_applicable' },
        durationEvidence: [
            ...matching,
            {
                placeId: candidate.place.placeId,
                experienceId,
                conditionsMatched: true,
                validFrom: at,
                validUntil: new Date(Date.parse(at) + 86400000).toISOString(),
                duration: {
                    minSeconds: category.min,
                    maxSeconds: category.max,
                    sourceType: 'estimate',
                    sourceUrl: null,
                    checkedAt: at,
                    includesWait: false,
                    conditions:
                        'カテゴリ別の暫定目安。入場・館内利用・飲食・予約や行列待ちは体験に含めない。実測値や施設公表値ではありません',
                },
            },
        ],
    };
}

export function hasExteriorCategory(candidate: PlaceCandidate): boolean {
    return categories.some((item) => candidate.types.includes(item.type));
}

export function hasSupportedCategory(candidate: PlaceCandidate): boolean {
    const id = candidateExperienceId(candidate);
    if (id === PUBLIC_EXTERIOR_ID) return hasExteriorCategory(candidate);
    const types =
        id === 'small-exhibit-v1'
            ? ['museum', 'art_gallery', 'cultural_center']
            : id === 'cafe-break-v1'
              ? ['cafe', 'coffee_shop', 'tea_house', 'bakery']
              : [
                    'cafe',
                    'bakery',
                    'sandwich_shop',
                    'deli',
                    'restaurant',
                    'fast_food_restaurant',
                    'meal_takeaway',
                ];
    return types.some((type) => candidate.types.includes(type));
}

export function createCandidateExperience(
    candidate: PlaceCandidate,
    at: string,
    evidence: readonly DurationEvidence[],
    destinationPlaceId: string,
): CandidateExperience | null {
    if (
        candidateConditions(candidate, destinationPlaceId, at).blockedReason ||
        !hasSupportedCategory(candidate)
    )
        return null;
    const conditions = candidateConditions(candidate, destinationPlaceId, at);
    const access = conditions.unknowns.some(
        (warning) => warning.code === 'UNCONFIRMED_ACCESS_SOURCE',
    )
        ? undefined
        : candidate.interiorAccessEvidence;
    const provisional = conditions.unknowns.length > 0;
    if (candidateExperienceId(candidate) === PUBLIC_EXTERIOR_ID)
        return exteriorExperience(candidate, at, evidence, destinationPlaceId);
    const profile = indoorProfileForId(candidateExperienceId(candidate));
    if (!profile) return null;
    const matching = evidence.filter(
        (item) =>
            item.placeId === candidate.place.placeId && item.experienceId === profile.experienceId,
    );
    if (matching.length > 63) throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    return {
        experienceId: profile.experienceId,
        title:
            candidate.groundedExperience?.title ??
            `${candidate.place.label}で${profile.label}を楽しむ`,
        description:
            candidate.groundedExperience?.description ??
            (provisional
                ? '短時間の館内体験の案です。屋内利用・予約などの未確認条件は行程画面で確認してください。待ち時間・体験時間は計画用の推定です。'
                : '出典で利用条件を照合した短時間の屋内体験です。待ち時間・体験時間は計画用の推定です。'),
        accessDestinationPlaceId: destinationPlaceId,
        wait: { status: 'estimated', minSeconds: profile.waitMin, maxSeconds: profile.waitMax },
        admission:
            access?.entryCutoff === 'known' && access.lastEntryAt !== null
                ? { status: 'required', lastEntryAt: access.lastEntryAt }
                : { status: 'not_applicable' },
        durationEvidence: [
            ...matching,
            {
                placeId: candidate.place.placeId,
                experienceId: profile.experienceId,
                conditionsMatched: true,
                validFrom: at,
                validUntil: new Date(Date.parse(at) + 86400000).toISOString(),
                duration: {
                    minSeconds: profile.activityMin + EXIT_SECONDS,
                    maxSeconds: profile.activityMax + EXIT_SECONDS,
                    sourceType: 'estimate',
                    sourceUrl: null,
                    checkedAt: at,
                    includesWait: false,
                    conditions: `${profile.label}の種類別の計画用推定。会計・退出5分を含み、待ち時間は別途加算。実測値・施設公表値・実際の上限保証ではありません`,
                },
            },
        ],
    };
}
