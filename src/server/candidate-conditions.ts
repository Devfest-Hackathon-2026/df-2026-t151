import type { ApiWarning } from '../lib/api/types';
import type { PlaceCandidate } from './nearby-candidates';
import { candidateAccessReason, candidateExperienceId } from './candidate-access.ts';
import { PUBLIC_EXTERIOR_ID } from './exterior-access.ts';
import { indoorProfileForId } from './experience-profiles.ts';

export const isBusinessClosed = (candidate: PlaceCandidate) =>
    candidate.businessStatus === 'CLOSED_TEMPORARILY' ||
    candidate.businessStatus === 'CLOSED_PERMANENTLY';

/** Unknown conditions remain provisional; positively incompatible conditions still exclude. */
export function candidateConditions(
    candidate: PlaceCandidate,
    destinationPlaceId: string,
    at: string,
    endAt = at,
    experienceId = candidateExperienceId(candidate),
): { blockedReason: string | null; unknowns: ApiWarning[] } {
    const unknowns: ApiWarning[] = [];
    const unknown = (field: string, message: string) =>
        unknowns.push({ code: `UNCONFIRMED_${field}`, message });
    const suppliedEvidence = candidate.interiorAccessEvidence ?? candidate.accessEvidence;
    const strict = candidateAccessReason(candidate, destinationPlaceId, at, endAt, experienceId);
    const sourceUnknown = ['ACCESS_UNKNOWN', 'ACCESS_STALE'].includes(strict ?? '');
    const evidence = sourceUnknown ? undefined : suppliedEvidence;
    if (strict === 'ACCESS_CONTEXT_MISMATCH' || strict === 'DESTINATION_INTERIOR')
        return { blockedReason: strict, unknowns };
    if (evidence?.outsideDestination !== true)
        unknown(
            'DESTINATION_RELATION',
            evidence?.outsideDestination === false
                ? 'AIが目的地内の可能性を示しました。目的地との包含関係は未確認です'
                : '目的地の敷地外で利用できるかは不明です',
        );
    if (sourceUnknown) unknown('ACCESS_SOURCE', '利用条件を裏付ける最新の根拠は不明です');
    if (experienceId === PUBLIC_EXTERIOR_ID) {
        const access = sourceUnknown ? undefined : candidate.accessEvidence;
        if (access?.publicExteriorWithoutAdmission === false)
            return { blockedReason: 'ADMISSION_REQUIRED', unknowns };
        if (access?.publicExteriorWithoutAdmission !== true)
            unknown('EXTERIOR_ACCESS', '入場せず外観を観察できるかは不明です');
    } else {
        const access = sourceUnknown ? undefined : candidate.interiorAccessEvidence;
        if (!indoorProfileForId(experienceId))
            return { blockedReason: 'EXPERIENCE_UNKNOWN', unknowns };
        for (const [key, code, message] of [
            ['indoorConfirmed', 'INDOOR', '屋内で利用できるかは不明です'],
            ['walkInAllowed', 'RESERVATION', '予約なしで利用できるかは不明です'],
            ['noFixedStart', 'START_TIME', '開始時刻の指定があるかは不明です'],
        ] as const) {
            if (access?.[key] === false)
                return {
                    blockedReason:
                        key === 'indoorConfirmed'
                            ? 'ACCESS_NOT_INDOOR'
                            : 'ACCESS_RESERVATION_REQUIRED',
                    unknowns,
                };
            if (access?.[key] !== true) unknown(code, message);
        }
        if (experienceId === 'small-exhibit-v1') {
            if (access?.smallExhibition === false)
                return { blockedReason: 'EXHIBITION_TOO_LARGE', unknowns };
            if (access?.smallExhibition !== true)
                unknown('EXHIBITION_SIZE', '短時間で鑑賞できる展示規模かは不明です');
        }
        if (typeof access?.admissionRequired !== 'boolean')
            unknown('ADMISSION', '入場料・利用料金の要否は不明です');
        if (!access || access.entryCutoff === null || strict === 'LAST_ENTRY_UNKNOWN')
            unknown('ENTRY_CUTOFF', '最終入場・ラストオーダー等の受付締切は不明です');
    }
    if (candidate.businessStatus !== 'OPERATIONAL' && !isBusinessClosed(candidate))
        unknown('BUSINESS_STATUS', '営業状態は不明です');
    return { blockedReason: null, unknowns };
}
