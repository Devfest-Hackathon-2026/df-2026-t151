/** Product planning defaults agreed with the user; these are not measured/provider durations. */
export const indoorProfiles = {
    cafe: {
        experienceId: 'cafe-break-v1',
        label: 'カフェ',
        activityMin: 15 * 60,
        activityMax: 25 * 60,
        waitMin: 5 * 60,
        waitMax: 15 * 60,
    },
    light_meal: {
        experienceId: 'light-meal-v1',
        label: '軽食',
        activityMin: 20 * 60,
        activityMax: 35 * 60,
        waitMin: 5 * 60,
        waitMax: 20 * 60,
    },
    small_exhibit: {
        experienceId: 'small-exhibit-v1',
        label: '小規模展示',
        activityMin: 15 * 60,
        activityMax: 30 * 60,
        waitMin: 0,
        waitMax: 10 * 60,
    },
} as const;
export const EXIT_SECONDS = 5 * 60;
export type IndoorKind = keyof typeof indoorProfiles;
export type IndoorExperienceId = (typeof indoorProfiles)[IndoorKind]['experienceId'];

export function indoorKind(value: unknown): IndoorKind | null {
    return typeof value === 'string' && Object.hasOwn(indoorProfiles, value)
        ? (value as IndoorKind)
        : null;
}
export function indoorProfileForId(id: string) {
    return Object.values(indoorProfiles).find((profile) => profile.experienceId === id) ?? null;
}
