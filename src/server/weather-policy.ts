/** Application policy for walking detours, not a weather warning standard. */
export interface WeatherAssessment {
    kind: 'dry' | 'exposed' | 'avoid' | 'unknown';
    reason: string;
}

const dryConditions = new Set([
    'CLEAR',
    'MOSTLY_CLEAR',
    'PARTLY_CLOUDY',
    'MOSTLY_CLOUDY',
    'CLOUDY',
]);
const exposedConditions = new Set([
    'WINDY',
    'WIND_AND_RAIN',
    'LIGHT_RAIN_SHOWERS',
    'CHANCE_OF_SHOWERS',
    'SCATTERED_SHOWERS',
    'RAIN_SHOWERS',
    'LIGHT_TO_MODERATE_RAIN',
    'RAIN',
    'LIGHT_RAIN',
    'LIGHT_SNOW_SHOWERS',
    'CHANCE_OF_SNOW_SHOWERS',
    'SCATTERED_SNOW_SHOWERS',
    'SNOW_SHOWERS',
    'LIGHT_TO_MODERATE_SNOW',
    'SNOW',
    'LIGHT_SNOW',
    'RAIN_AND_SNOW',
]);
const avoidConditions = new Set([
    'HEAVY_RAIN_SHOWERS',
    'MODERATE_TO_HEAVY_RAIN',
    'HEAVY_RAIN',
    'RAIN_PERIODICALLY_HEAVY',
    'HEAVY_SNOW_SHOWERS',
    'MODERATE_TO_HEAVY_SNOW',
    'HEAVY_SNOW',
    'SNOWSTORM',
    'SNOW_PERIODICALLY_HEAVY',
    'HEAVY_SNOW_STORM',
    'BLOWING_SNOW',
    'HAIL',
    'HAIL_SHOWERS',
    'THUNDERSTORM',
    'THUNDERSHOWER',
    'LIGHT_THUNDERSTORM_RAIN',
    'SCATTERED_THUNDERSTORMS',
    'HEAVY_THUNDERSTORM',
]);

export function classifyWeather(
    conditionType: unknown,
    probability: number | null,
): WeatherAssessment {
    if (typeof conditionType === 'string' && avoidConditions.has(conditionType)) {
        return {
            kind: 'avoid',
            reason: '訪問時間帯に雷雨・大雨・大雪等の予報があるため、屋外の寄り道を控えます',
        };
    }
    if (typeof conditionType === 'string' && exposedConditions.has(conditionType)) {
        return {
            kind: 'exposed',
            reason: '訪問時間帯に雨・雪・強風の予報があるため、屋外で過ごす見積もり時間が短い案を優先します',
        };
    }
    if (
        probability !== null &&
        Number.isFinite(probability) &&
        probability >= 50 &&
        probability <= 100
    ) {
        return {
            kind: 'exposed',
            reason: '訪問時間帯の降水確率が50%以上のため、屋外で過ごす見積もり時間が短い案を優先します',
        };
    }
    if (typeof conditionType === 'string' && dryConditions.has(conditionType)) {
        return { kind: 'dry', reason: '訪問時間帯の予報を確認しました' };
    }
    return { kind: 'unknown', reason: '天候による候補の比較に必要な予報を確認できませんでした' };
}
