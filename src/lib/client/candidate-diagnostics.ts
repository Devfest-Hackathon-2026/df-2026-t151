import type { CandidateExclusion } from '../api/types';

const reasons: Record<string, string> = {
    NOT_OPERATIONAL: '休業・閉業が確認された',
    CLOSED_FOR_WINDOW: '検索対象の時間帯に営業していない',
    CLOSED_FOR_VISIT: '訪問中に営業時間外になる',
    LAST_ENTRY_PASSED: '最終入場・受付締切に間に合わない',
    TIME_LIMIT: '移動・待ち・体験・余裕が到着期限に収まらない',
    OUTSIDE_SEARCH_AREA: '出発地点から3kmを超える',
    DESTINATION_INTERIOR: '目的地の内部にある',
    EXCLUDED_OR_DUPLICATE: '目的地・訪問済み・重複のいずれか',
    NO_ROUTE: '徒歩経路が見つからない',
    DETAILS_UNAVAILABLE: '施設の詳細情報を取得できない',
    MAPS_IDENTITY_UNVERIFIED: '実在地点とMaps出典を照合できない',
    ACCESS_RESERVATION_REQUIRED: '予約必須・開始時刻指定などの利用条件がある',
    WEATHER_UNSUITABLE: '訪問時間帯が雷雨・大雨等の予報',
    SEARCH_LIMIT: '経路評価の件数上限',
    DISPLAY_LIMIT: '最終表示の3件上限',
    EXTERIOR_REQUIRED: '外観観察の必須枠が成立しない',
};

/** Browser-only output from the server's allowlisted decision data, without request payloads. */
export function printCandidateExclusions(
    exclusions: CandidateExclusion[] | undefined,
    operation: string,
) {
    if (!Array.isArray(exclusions) || !exclusions.length) return;
    console.info(`候補の除外理由（${operation}）`);
    console.table(
        exclusions.slice(0, 64).map((item) => ({
            施設: item.placeLabel,
            段階: item.stage,
            除外理由: item.reason,
            説明: reasons[item.reason] ?? item.reason,
            情報源: item.source.provider,
            参照先: item.source.url ?? '該当なし',
            判断に使用した情報: JSON.stringify(item.facts),
        })),
    );
}
