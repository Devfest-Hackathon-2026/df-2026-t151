import type { ApiWarning, ExperienceDuration, OptionTime } from '../lib/api/types';
import { parseZonedDateTime } from './date-time.ts';

export type WaitEstimate =
    | { status: 'known'; seconds: number }
    | { status: 'estimated'; minSeconds: number; maxSeconds: number }
    | { status: 'not_applicable' }
    | { status: 'unknown'; unavoidable: boolean };

export interface TimeBudgetInput {
    /** Both timestamps must be generated/validated on the server. */
    calculatedAt: string;
    arriveBy: string;
    directSeconds: number;
    legToStopSeconds: number;
    legToDestinationSeconds: number;
    experienceDuration: Pick<ExperienceDuration, 'minSeconds' | 'maxSeconds' | 'includesWait'>;
    wait: WaitEstimate;
    /** Explicit policy input, rather than a hidden or user-supplied allowance. */
    bufferSeconds: number;
}

// Admission/departure timestamps need the actual wait breakdown and opening hours.
// This subtotal deliberately cannot be used as a complete API OptionTime.
export type TimeBudget = Omit<
    OptionTime,
    'stopArrivalAt' | 'experienceStartAt' | 'stopDepartureAt'
>;
type DirectTime = { durationSeconds: number; arrivalAt: string };

export type TimeBudgetResult =
    | {
          status: 'calculated';
          direct: DirectTime;
          time: TimeBudget;
          fitsDeadline: boolean;
          warnings: ApiWarning[];
      }
    | {
          status: 'excluded';
          direct: DirectTime;
          reason:
              'DIRECT_LATE' | 'INCONSISTENT_ROUTE' | 'INCONSISTENT_WAIT' | 'UNKNOWN_REQUIRED_WAIT';
      };

function assertSeconds(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('Durations must be nonnegative safe integer seconds');
    }
}

function addSeconds(timestamp: number, seconds: number): number {
    const result = timestamp + seconds * 1000;
    if (!Number.isSafeInteger(result) || !Number.isFinite(new Date(result).getTime())) {
        throw new RangeError('Calculated timestamp is outside the supported range');
    }
    return result;
}

/**
 * Evaluate the time budget separately from route acquisition, opening hours and final selection.
 *
 * @param input - Zoned server timestamps, route and experience durations in seconds, and wait evidence.
 * @returns The direct estimate and either a time budget or a time-based exclusion.
 * @throws {RangeError} When timestamps, durations or wait inputs are invalid.
 */
export function calculateTimeBudget(input: TimeBudgetInput): TimeBudgetResult {
    const calculatedAtMs = parseZonedDateTime(input.calculatedAt);
    const arriveByMs = parseZonedDateTime(input.arriveBy);
    if (calculatedAtMs === null || arriveByMs === null) {
        throw new RangeError('An explicit zoned date-time is required');
    }
    const duration = input.experienceDuration;
    for (const seconds of [
        input.directSeconds,
        input.legToStopSeconds,
        input.legToDestinationSeconds,
        input.bufferSeconds,
        duration.minSeconds,
        duration.maxSeconds,
    ]) {
        assertSeconds(seconds);
    }
    if (duration.minSeconds > duration.maxSeconds)
        throw new RangeError('Duration range is reversed');
    if (
        duration.includesWait !== true &&
        duration.includesWait !== false &&
        duration.includesWait !== null
    ) {
        throw new RangeError('Wait inclusion must be true, false or null');
    }

    const wait = input.wait;
    if (wait.status === 'known') assertSeconds(wait.seconds);
    else if (wait.status === 'estimated') {
        assertSeconds(wait.minSeconds);
        assertSeconds(wait.maxSeconds);
        if (wait.minSeconds > wait.maxSeconds) throw new RangeError('Wait range is reversed');
    } else if (wait.status === 'unknown') {
        if (typeof wait.unavoidable !== 'boolean')
            throw new RangeError('Unknown wait needs an unavoidable flag');
    } else if (wait.status !== 'not_applicable') throw new RangeError('Invalid wait status');

    const directArrivalMs = addSeconds(calculatedAtMs, input.directSeconds);
    const direct = {
        durationSeconds: input.directSeconds,
        arrivalAt: new Date(directArrivalMs).toISOString(),
    };
    if (directArrivalMs > arriveByMs) return { status: 'excluded', reason: 'DIRECT_LATE', direct };

    const travelSeconds = input.legToStopSeconds + input.legToDestinationSeconds;
    assertSeconds(travelSeconds);
    const extraTravelSeconds = travelSeconds - input.directSeconds;
    if (extraTravelSeconds < 0) return { status: 'excluded', reason: 'INCONSISTENT_ROUTE', direct };
    if (wait.status === 'unknown' && wait.unavoidable) {
        return { status: 'excluded', reason: 'UNKNOWN_REQUIRED_WAIT', direct };
    }

    const warnings: ApiWarning[] = [];
    let waitSeconds: number | null;
    let waitTreatment: TimeBudget['waitTreatment'];
    let isProvisional = wait.status === 'estimated';
    if (wait.status === 'estimated')
        warnings.push({
            code: 'ESTIMATED_WAIT',
            message: `待ち時間は実測ではなく種類別の計画用推定（${wait.minSeconds / 60}〜${wait.maxSeconds / 60}分）です。上限を使って計算していますが、実際には超過する場合があります`,
        });
    const plannedWait = waitUpperSeconds(wait);
    if (duration.includesWait === true) {
        if (plannedWait > duration.maxSeconds) {
            return { status: 'excluded', reason: 'INCONSISTENT_WAIT', direct };
        }
        // Zero additional seconds does not assert that the actual queue has no wait.
        waitSeconds = 0;
        waitTreatment = 'included';
    } else if (wait.status === 'not_applicable') {
        waitSeconds = 0;
        waitTreatment = 'not_applicable';
    } else if (wait.status === 'known' || wait.status === 'estimated') {
        waitSeconds = plannedWait;
        waitTreatment = 'separate';
        if (duration.includesWait === null) {
            isProvisional = true;
            warnings.push({
                code: 'WAIT_INCLUSION_UNKNOWN',
                message: '体験時間への待ち時間の含有が不明なため、別途加算した保守的な見積もりです',
            });
        }
    } else {
        waitSeconds = null;
        waitTreatment = 'unknown';
        isProvisional = true;
        warnings.push({
            code: 'WAIT_UNKNOWN',
            message: '待ち時間が不明なため、既知部分だけの暫定見積もりです',
        });
    }

    const experienceSeconds = duration.maxSeconds;
    const elapsedSeconds = travelSeconds + experienceSeconds + (waitSeconds ?? 0);
    const requiredSeconds = elapsedSeconds + input.bufferSeconds;
    assertSeconds(elapsedSeconds);
    assertSeconds(requiredSeconds);
    const arrivalMs = addSeconds(calculatedAtMs, elapsedSeconds);
    const bufferedArrivalMs = addSeconds(calculatedAtMs, requiredSeconds);

    return {
        status: 'calculated',
        direct,
        fitsDeadline: bufferedArrivalMs <= arriveByMs,
        time: {
            legToStopSeconds: input.legToStopSeconds,
            waitSeconds,
            waitTreatment,
            experienceSeconds,
            legToDestinationSeconds: input.legToDestinationSeconds,
            bufferSeconds: input.bufferSeconds,
            requiredSeconds,
            extraTravelSeconds,
            arrivalAt: new Date(arrivalMs).toISOString(),
            // Conservative integer seconds for display. The comparison above keeps milliseconds.
            slackSeconds: Math.floor((arriveByMs - arrivalMs) / 1000),
            isProvisional,
        },
        warnings,
    };
}

/** An estimate is a planning allowance, never an observed queue length. */
export function waitUpperSeconds(wait: WaitEstimate): number {
    return wait.status === 'known'
        ? wait.seconds
        : wait.status === 'estimated'
          ? wait.maxSeconds
          : 0;
}
