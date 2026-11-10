import type {
    Attribution,
    Coordinates,
    RecommendationOption,
    RecommendationsResponse,
    ValidateItineraryResponse,
} from '../api/types';

export type SearchEstimate<Origin> = { result: RecommendationsResponse; origin: Origin };

export type TripPlan<Origin> = {
    stage: 'plan';
    search: SearchEstimate<Origin>;
    origin: Origin;
    option: RecommendationOption | null;
    calculatedAt: string;
    attributions: Attribution[];
};

export type TripView<Origin> =
    { stage: 'input' } | ({ stage: 'results' } & SearchEstimate<Origin>) | TripPlan<Origin>;

export function planFromSearch<Origin>(
    search: SearchEstimate<Origin>,
    option: RecommendationOption | null,
): TripPlan<Origin> {
    return {
        stage: 'plan',
        search,
        origin: search.origin,
        option,
        calculatedAt: search.result.calculatedAt,
        attributions: search.result.attributions,
    };
}

export function applyItineraryValidation<Origin extends { coordinates?: Coordinates }>(
    search: SearchEstimate<Origin>,
    origin: Origin,
    selected: RecommendationOption,
    validation: ValidateItineraryResponse,
): { view: TripView<Origin>; notice: string } {
    if (validation.status === 'VALID') {
        return {
            view: {
                stage: 'plan',
                search,
                origin,
                option: validation.option,
                calculatedAt: validation.calculatedAt,
                attributions: [...search.result.attributions, ...validation.attributions],
            },
            notice: '',
        };
    }

    const previous = search.origin.coordinates;
    const current = origin.coordinates;
    if (
        !previous ||
        !current ||
        previous.latitude !== current.latitude ||
        previous.longitude !== current.longitude
    ) {
        return {
            view: { stage: 'input' },
            notice: '選んだ寄り道を確定できませんでした。出発地点が変わったため、更新した出発地点で検索してください。',
        };
    }

    const options = search.result.options.filter(
        (option) =>
            option.place.placeId !== selected.place.placeId ||
            option.experienceId !== selected.experienceId,
    );
    return {
        view: {
            stage: 'results',
            origin: search.origin,
            result: {
                ...search.result,
                options,
                outcome: options.length ? 'OPTIONS' : 'NO_OPTIONS',
            },
        },
        notice:
            validation.status === 'EXPIRED'
                ? '選んだ候補の有効期限が切れました。検索し直すか、直行の見積もりを確認してください。'
                : '選んだ寄り道は到着希望時刻に収まらなくなりました。条件を変更するか、直行の見積もりを確認してください。',
    };
}
