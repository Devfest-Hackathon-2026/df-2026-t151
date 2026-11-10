'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiAttributions, PlaceLookup, type PlaceSelection } from '@/components/place-lookup';
import { ExperienceSummary } from '@/components/experience-summary';
import { MapsRouteLink } from '@/components/maps-route-link';
import { OptionCarousel } from '@/components/option-carousel';
import { OptionEstimateNotice } from '@/components/option-estimate-notice';
import { LoadingSpinner } from '@/components/loading-spinner';
import type {
    Coordinates,
    RecommendationOption,
    RecommendationsResponse,
    ValidateItineraryResponse,
} from '@/lib/api/types';
import { displayTime, initialDeadline, minutes } from '@/lib/client/trip-format';
import {
    loadRecommendations,
    PlannerApiError,
    requestTimeoutMs,
    validateItinerary,
} from '@/lib/client/planner-api';
import {
    applyItineraryValidation,
    planFromSearch,
    type SearchEstimate,
    type TripPlan,
    type TripView,
} from '@/lib/client/trip-estimates';

type TripOrigin = {
    label: string;
    placeId?: string;
    coordinates?: Coordinates;
    gps?: boolean;
    place?: PlaceSelection;
};

type FormError = { field: 'destination' | 'deadline' | 'origin'; message: string };

type SearchConditions = {
    arriveBy: number;
    origin: TripOrigin;
    destinationId: string;
    excludedPlaceIds: string[];
};
type Operation = SearchConditions &
    (
        | { kind: 'search' }
        | {
              kind: 'itinerary';
              search: SearchEstimate<TripOrigin>;
              option: RecommendationOption | null;
          }
    );
type RequestState =
    | { status: 'pending'; operation: Operation }
    | { status: 'failed'; operation: Operation; message: string; retryable: boolean };

const steps = ['条件', '候補', '行程'];

async function requestApi(
    operation: Operation,
    signal: AbortSignal,
): Promise<RecommendationsResponse | ValidateItineraryResponse> {
    if (!operation.origin.coordinates)
        throw new PlannerApiError('出発地点を選び直してください。', false);
    const { latitude, longitude } = operation.origin.coordinates;
    const input = {
        origin: { latitude, longitude },
        destination: { placeId: operation.destinationId },
        arriveBy: new Date(operation.arriveBy).toISOString(),
        travelMode: 'WALK' as const,
        excludedPlaceIds: operation.excludedPlaceIds,
    };
    if (operation.kind === 'search' || !operation.option) return loadRecommendations(input, signal);

    const { option } = operation;
    return validateItinerary(
        {
            ...input,
            selectedPlaceId: option.place.placeId,
            experienceId: option.experienceId,
            optionToken: option.optionToken,
        },
        signal,
    );
}

function OptionFacts({ option }: { option: RecommendationOption }) {
    const { time, experienceDuration } = option;
    const durationSource = {
        registered: '登録値',
        official: '公式情報',
        external_statistics: '外部統計',
        estimate: '推定',
    }[experienceDuration.sourceType];
    return (
        <dl className="facts">
            <div>
                <dt>移動合計</dt>
                <dd>
                    {minutes(time.legToStopSeconds + time.legToDestinationSeconds)}分{' '}
                    <small>（直行比 +{minutes(time.extraTravelSeconds)}分）</small>
                </dd>
            </div>
            <div>
                <dt>体験時間の目安</dt>
                <dd>
                    {minutes(experienceDuration.minSeconds)}〜
                    {minutes(experienceDuration.maxSeconds)}分 <small>（{durationSource}）</small>
                </dd>
            </div>
            <div>
                <dt>到着後の余裕</dt>
                <dd>
                    {minutes(time.slackSeconds)}分 <small>（到着見込みから希望時刻まで）</small>
                </dd>
            </div>
            {time.waitTreatment !== 'not_applicable' && (
                <div>
                    <dt>待ち時間</dt>
                    <dd>
                        {time.waitTreatment === 'included'
                            ? '体験時間に含む（二重加算なし）'
                            : time.waitSeconds === null
                              ? '不明'
                              : `${minutes(time.waitSeconds)}分`}
                        {option.warnings.some(({ code }) => code === 'ESTIMATED_WAIT') && (
                            <small>（計画用の推定）</small>
                        )}
                    </dd>
                </div>
            )}
            <div>
                <dt>計算に確保した余裕</dt>
                <dd>{minutes(time.bufferSeconds)}分</dd>
            </div>
        </dl>
    );
}

function OptionDetails({ option }: { option: RecommendationOption }) {
    return (
        <details className="source-details">
            <summary>体験・時間の詳細</summary>
            <p>{option.recommendationReasons.join('。')}</p>
            <OptionFacts option={option} />
            <p>
                {option.cost.label} ／ {option.crowd.summary}
            </p>
            <p>
                {option.experienceDuration.conditions}（確認{' '}
                {displayTime(option.experienceDuration.checkedAt)}）
            </p>
            <ul>
                {option.warnings.map(({ code, message }) => (
                    <li key={`${code}:${message}`}>{message}</li>
                ))}
            </ul>
            <ApiAttributions
                entries={option.sources
                    .filter(({ provider }) => !provider.startsWith('Google Maps：'))
                    .map(({ provider, url }) => ({ provider, providerUri: url }))}
            />
        </details>
    );
}

function LocationPrivacyNotice() {
    return (
        <p id="location-purpose" className="subtle">
            検索・再計算では、端末が返す現在地の座標などを、よりみちのサーバーとGoogleへ送り、経路計算や寄り道の提案に使います。GeminiがGoogleマップの情報を使って候補を探すときは、入力と生成結果がGoogleに30日間保存されます。出発地点は手動でも指定できます。{' '}
            <a
                className="privacy-link"
                href="/about#privacy"
                target="_blank"
                rel="noopener noreferrer"
            >
                詳しい案内（別タブ）
            </a>
        </p>
    );
}

export function TripPlanner() {
    const [view, setView] = useState<TripView<TripOrigin>>({ stage: 'input' });
    const [destination, setDestination] = useState<PlaceSelection | null>(null);
    const [deadline, setDeadline] = useState('');
    const [origin, setOrigin] = useState<TripOrigin | null>(null);
    const [visitedStops, setVisitedStops] = useState<PlaceSelection[]>([]);
    const [showManual, setShowManual] = useState(false);
    const [locating, setLocating] = useState(false);
    const [locationMessage, setLocationMessage] = useState('');
    const [error, setError] = useState<FormError | null>(null);
    const [notice, setNotice] = useState('');
    const [requestState, setRequestState] = useState<RequestState | null>(null);
    const activeRequest = useRef<AbortController | null>(null);
    const locationAttempt = useRef(0);
    const heading = useRef<HTMLHeadingElement>(null);
    const form = useRef<HTMLFormElement>(null);
    const firstView = useRef(true);
    const step = view.stage === 'input' ? 0 : view.stage === 'results' ? 1 : 2;
    const pending = requestState?.status === 'pending';
    const pendingOperation = requestState?.status === 'pending' ? requestState.operation : null;
    const busy = locating || pending;
    const excludedPlaceIds = visitedStops.map((place) => place.placeId);

    useEffect(() => {
        setDeadline(initialDeadline());
    }, []);
    useEffect(
        () => () => {
            locationAttempt.current++;
            const controller = activeRequest.current;
            activeRequest.current = null;
            controller?.abort();
        },
        [],
    );
    useEffect(() => {
        if (firstView.current) firstView.current = false;
        else heading.current?.focus();
    }, [step]);

    function clearError(field: FormError['field']) {
        setError((previous) => (previous?.field === field ? null : previous));
    }

    function cancelRequest() {
        const controller = activeRequest.current;
        activeRequest.current = null;
        controller?.abort();
        setRequestState(null);
    }

    function editConditions() {
        cancelRequest();
        locationAttempt.current++;
        setLocating(false);
        setNotice('');
        setView({ stage: 'input' });
    }

    function startNewTrip() {
        editConditions();
        setVisitedStops([]);
        setOrigin(null);
        setShowManual(false);
        setDestination(null);
        setDeadline(initialDeadline());
        setError(null);
        setLocationMessage('');
        heading.current?.focus();
    }

    function useManualOrigin() {
        cancelRequest();
        locationAttempt.current++;
        setLocating(false);
        setShowManual(true);
        setOrigin(null);
        setLocationMessage('');
    }

    function locate(onLocated?: (origin: TripOrigin) => void) {
        cancelRequest();
        const attempt = ++locationAttempt.current;
        setLocating(true);
        setLocationMessage('');
        if (!onLocated) setOrigin(null);
        clearError('origin');
        const unavailable = () => {
            if (attempt !== locationAttempt.current) return;
            setLocating(false);
            setShowManual(true);
            setOrigin(null);
            setLocationMessage('現在地を取得できませんでした。');
            setView({ stage: 'input' });
        };
        if (!navigator.geolocation) {
            unavailable();
            return;
        }
        navigator.geolocation.getCurrentPosition(
            ({ coords }) => {
                if (attempt !== locationAttempt.current) return;
                setLocating(false);
                setShowManual(false);
                const currentOrigin: TripOrigin = {
                    label: '現在地',
                    gps: true,
                    coordinates: { latitude: coords.latitude, longitude: coords.longitude },
                };
                setOrigin(currentOrigin);
                onLocated?.(currentOrigin);
            },
            unavailable,
            { timeout: 8000, maximumAge: 0 },
        );
    }

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        search();
    }

    function search() {
        if (locating || activeRequest.current) return;
        const arriveBy = Date.parse(`${deadline}+09:00`);
        let issue: FormError | null = null;
        if (!destination) {
            issue = { field: 'destination', message: '一覧から目的地を選んでください。' };
        } else if (!Number.isFinite(arriveBy) || arriveBy <= Date.now()) {
            issue = { field: 'deadline', message: '現在より後の到着日時を指定してください。' };
        } else if (!origin) {
            issue = { field: 'origin', message: '現在地を取得するか、出発地点を選んでください。' };
        }
        setError(issue);
        if (issue || !origin || !destination) {
            cancelRequest();
            if (issue)
                form.current?.querySelector<HTMLElement>(`[data-field="${issue.field}"]`)?.focus();
            return;
        }
        void runRequest({
            kind: 'search',
            arriveBy,
            origin,
            destinationId: destination.placeId,
            excludedPlaceIds,
        });
    }

    async function runRequest(operation: Operation) {
        if (activeRequest.current) return;
        const controller = new AbortController();
        activeRequest.current = controller;
        setNotice('');
        setRequestState({ status: 'pending', operation });

        const timeout = window.setTimeout(() => {
            controller.abort(new DOMException('Request timed out', 'TimeoutError'));
        }, requestTimeoutMs);
        const aborted = new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
                once: true,
            });
        });
        const { origin } = operation;

        try {
            const latest = await Promise.race([requestApi(operation, controller.signal), aborted]);
            if (activeRequest.current !== controller) return;
            setRequestState(null);
            if ('status' in latest) {
                if (operation.kind !== 'itinerary' || !operation.option) {
                    throw new PlannerApiError('行程再検証の応答を確認できませんでした。', true);
                }
                const update = applyItineraryValidation(
                    operation.search,
                    origin,
                    operation.option,
                    latest,
                );
                setNotice(update.notice);
                setView(update.view);
                return;
            }
            if (operation.kind === 'search') {
                setView({ stage: 'results', result: latest, origin });
                return;
            }

            setView(planFromSearch({ result: latest, origin }, null));
        } catch (cause) {
            if (activeRequest.current !== controller) return;
            const message =
                cause instanceof PlannerApiError
                    ? cause.message
                    : cause instanceof DOMException && cause.name === 'TimeoutError'
                      ? '通信がタイムアウトしました。'
                      : '通信エラーが発生しました。';
            setRequestState({
                status: 'failed',
                operation,
                message,
                retryable: !(cause instanceof PlannerApiError) || cause.retryable,
            });
        } finally {
            window.clearTimeout(timeout);
            if (activeRequest.current === controller) activeRequest.current = null;
        }
    }

    function recalculate(
        search: SearchEstimate<TripOrigin>,
        origin: TripOrigin,
        option: RecommendationOption | null,
    ) {
        if (locating || activeRequest.current) return;
        const { result } = search;
        const refresh = (currentOrigin: TripOrigin) => {
            void runRequest({
                kind: 'itinerary',
                arriveBy: Date.parse(result.arriveBy),
                origin: currentOrigin,
                destinationId: result.destination.placeId,
                search,
                option,
                excludedPlaceIds,
            });
        };
        if (view.stage === 'plan' && origin.gps) locate(refresh);
        else refresh(origin);
    }

    function completeStop({ search, option, attributions }: TripPlan<TripOrigin>) {
        if (!option || locating || activeRequest.current) return;
        const { result } = search;
        const place = { ...option.place, attributions };
        const nextOrigin = {
            label: place.label,
            placeId: place.placeId,
            coordinates: place,
            place,
        };
        setVisitedStops([...visitedStops, place]);
        setOrigin(nextOrigin);
        setShowManual(true);
        setLocationMessage('');
        // The completed stop remains recorded even if the remaining route cannot be loaded.
        setView({ stage: 'input' });
        void runRequest({
            kind: 'itinerary',
            arriveBy: Date.parse(result.arriveBy),
            origin: nextOrigin,
            destinationId: result.destination.placeId,
            search,
            option: null,
            excludedPlaceIds: [...excludedPlaceIds, place.placeId],
        });
    }

    function selectDestination(place: PlaceSelection | null) {
        cancelRequest();
        setDestination(place);
        clearError('destination');
    }

    function selectManualOrigin(place: PlaceSelection | null) {
        cancelRequest();
        locationAttempt.current++;
        setLocating(false);
        setOrigin(
            place
                ? { label: place.label, placeId: place.placeId, coordinates: place, place }
                : null,
        );
        setLocationMessage('');
        clearError('origin');
    }

    const fieldError = (field: FormError['field']) =>
        error?.field === field ? 'field-error' : undefined;
    const feedback = busy ? (
        <div className="request-pending">
            <div className="request-progress" role="status" aria-atomic="true">
                <LoadingSpinner />
                <div>
                    <strong>
                        {locating
                            ? '現在地を取得しています'
                            : pendingOperation?.kind === 'search'
                              ? '寄り道候補を探しています'
                              : '行程を確認しています'}
                    </strong>
                    <p>
                        {locating
                            ? '位置情報の確認が終わるまでお待ちください。'
                            : pendingOperation?.kind === 'search'
                              ? '場所・徒歩経路・天気を確認中です。そのままお待ちください。'
                              : '最新の情報で到着見込みを計算中です。'}
                    </p>
                </div>
            </div>
            <button
                type="button"
                className="button text-button"
                onClick={() => {
                    locationAttempt.current++;
                    setLocating(false);
                    cancelRequest();
                }}
            >
                キャンセル
            </button>
        </div>
    ) : requestState?.status === 'failed' ? (
        <div className="alert request-failure">
            <p role="alert">{requestState.message}</p>
            {requestState.retryable && (
                <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                        if (requestState.operation.kind === 'search') search();
                        else void runRequest(requestState.operation);
                    }}
                >
                    再試行
                </button>
            )}
        </div>
    ) : null;

    return (
        <section className="planner" aria-label="寄り道プランナー" data-busy={busy}>
            <ol className="steps" aria-label="進み具合">
                {steps.map((label, index) => (
                    <li
                        key={label}
                        aria-current={index === step ? 'step' : undefined}
                        data-complete={index < step}
                    >
                        <span aria-hidden="true">{index + 1}</span>
                        {label}
                    </li>
                ))}
            </ol>

            {view.stage === 'input' && (
                <div className="panel">
                    <div className="panel-heading">
                        <h2 ref={heading} tabIndex={-1}>
                            寄り道を探す
                        </h2>
                        <span className="mode-badge">徒歩のみ</span>
                    </div>
                    {notice && (
                        <p className="alert" role="status">
                            {notice}
                        </p>
                    )}
                    {visitedStops.length > 0 && (
                        <div className="empty-state">
                            <p>訪問済み</p>
                            <ul>
                                {visitedStops.map((place) => (
                                    <li key={place.placeId}>{place.label}</li>
                                ))}
                            </ul>
                            <button
                                type="button"
                                className="button text-button"
                                onClick={startNewTrip}
                            >
                                新しい行程を始める
                            </button>
                        </div>
                    )}
                    <form ref={form} onSubmit={submit} noValidate className="trip-form">
                        <PlaceLookup
                            key={visitedStops.length ? 'destination-in-trip' : 'destination'}
                            id="destination"
                            label="目的地"
                            selected={destination}
                            onSelect={selectDestination}
                        />
                        <div className="field">
                            <label htmlFor="deadline">
                                到着希望 <small>日本時間</small>
                            </label>
                            <input
                                id="deadline"
                                data-field="deadline"
                                type="datetime-local"
                                required
                                value={deadline}
                                aria-invalid={error?.field === 'deadline'}
                                aria-describedby={fieldError('deadline')}
                                onChange={(event) => {
                                    cancelRequest();
                                    setDeadline(event.target.value);
                                    clearError('deadline');
                                }}
                            />
                        </div>
                        <fieldset className="origin">
                            <legend>出発地点</legend>
                            <LocationPrivacyNotice />
                            <div className="actions">
                                <button
                                    type="button"
                                    className="button secondary"
                                    onClick={() => locate()}
                                    disabled={locating}
                                    data-field={showManual ? undefined : 'origin'}
                                    aria-describedby={[
                                        'location-purpose',
                                        fieldError('origin'),
                                        locationMessage && 'location-error',
                                    ]
                                        .filter(Boolean)
                                        .join(' ')}
                                >
                                    {locating && <LoadingSpinner />}
                                    {locating
                                        ? '取得中…'
                                        : origin?.gps
                                          ? '✓ 現在地を使用'
                                          : '現在地を取得'}
                                </button>
                                {!showManual && (
                                    <button
                                        type="button"
                                        className="button text-button"
                                        onClick={useManualOrigin}
                                    >
                                        場所を指定
                                    </button>
                                )}
                            </div>
                            {locationMessage && (
                                <p id="location-error" className="subtle" role="status">
                                    {locationMessage}
                                </p>
                            )}
                            {showManual && (
                                <PlaceLookup
                                    id="origin"
                                    label="出発地点"
                                    selected={origin?.place ?? null}
                                    onSelect={selectManualOrigin}
                                    hideLabel
                                />
                            )}
                        </fieldset>
                        {error && (
                            <p id="field-error" className="alert" role="alert">
                                {error.message}
                            </p>
                        )}
                        <button type="submit" className="button primary" disabled={busy}>
                            {pendingOperation?.kind === 'search' ? (
                                <>
                                    <LoadingSpinner /> 候補を検索中…
                                </>
                            ) : (
                                <>
                                    候補を見る <span aria-hidden="true">→</span>
                                </>
                            )}
                        </button>
                        {feedback}
                    </form>
                </div>
            )}

            {view.stage === 'results' && (
                <div className="panel result-panel">
                    <h2 ref={heading} tabIndex={-1}>
                        寄り道候補
                    </h2>
                    <p className="route-summary">
                        {view.origin.label} <span aria-label="から">→</span>{' '}
                        {view.result.destination.label}
                    </p>
                    <div className="summary">
                        <div>
                            <span>直行で到着</span>
                            <strong>{displayTime(view.result.direct.arrivalAt)}</strong>
                            <span>徒歩 {minutes(view.result.direct.durationSeconds)}分</span>
                        </div>
                        <div>
                            <span>到着希望</span>
                            <strong>{displayTime(view.result.arriveBy)}</strong>
                        </div>
                    </div>
                    {view.result.context.weather.status === 'available' && (
                        <p className="subtle">{view.result.context.weather.summary}</p>
                    )}
                    <ApiAttributions entries={view.result.attributions} />
                    {notice && (
                        <p className="alert" role="status">
                            {notice}
                        </p>
                    )}
                    {view.result.outcome === 'DIRECT_LATE' && (
                        <p className="alert">直行でも到着希望時刻を過ぎる見込みです。</p>
                    )}
                    {view.result.outcome === 'NO_OPTIONS' && !notice && (
                        <p className="empty-state">
                            {view.result.warnings.find(({ code }) => code === 'EXTERIOR_REQUIRED')
                                ?.message ??
                                (visitedStops.length
                                    ? '訪問済みの地点を除くと、条件に合う寄り道がありません。'
                                    : '条件に合う寄り道候補が見つかりませんでした。')}
                        </p>
                    )}
                    {view.result.outcome === 'OPTIONS' && (
                        <p className="subtle">
                            外観観察の候補を含む{view.result.options.length}
                            件の体験から、気になる1件を選んでください。
                        </p>
                    )}
                    <OptionCarousel key={view.result.requestId}>
                        {view.result.options.map((option) => (
                            <article
                                className="option-card"
                                key={option.optionId}
                                data-exterior={option.experienceId === 'public-exterior-v2'}
                            >
                                <ExperienceSummary option={option} />
                                <OptionEstimateNotice option={option} />
                                <dl className="option-metrics">
                                    <div>
                                        <dt>到着見込み</dt>
                                        <dd>{displayTime(option.time.arrivalAt)}</dd>
                                    </div>
                                    <div>
                                        <dt>立ち寄り</dt>
                                        <dd>
                                            約
                                            {minutes(
                                                option.time.experienceSeconds +
                                                    (option.time.waitSeconds ?? 0),
                                            )}
                                            分
                                            {(option.time.waitSeconds ?? 0) > 0 && (
                                                <small>（待ち含む）</small>
                                            )}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>到着の余裕</dt>
                                        <dd>{minutes(option.time.slackSeconds)}分</dd>
                                    </div>
                                </dl>
                                <button
                                    type="button"
                                    className="button primary"
                                    disabled={busy}
                                    onClick={() => recalculate(view, view.origin, option)}
                                >
                                    {pendingOperation?.kind === 'itinerary' &&
                                    pendingOperation.option?.place.placeId ===
                                        option.place.placeId ? (
                                        <>
                                            <LoadingSpinner /> 行程を確認中…
                                        </>
                                    ) : (
                                        <>
                                            行程を見る <span aria-hidden="true">→</span>
                                        </>
                                    )}
                                </button>
                                <OptionDetails option={option} />
                            </article>
                        ))}
                    </OptionCarousel>
                    <div className="actions">
                        <button
                            type="button"
                            className="button secondary"
                            disabled={busy}
                            onClick={() => {
                                setNotice('');
                                setRequestState(null);
                                setView(planFromSearch(view, null));
                            }}
                        >
                            直行の行程を見る
                        </button>
                        <button
                            type="button"
                            className="button text-button"
                            onClick={editConditions}
                        >
                            条件を変更
                        </button>
                    </div>
                    {feedback}
                    <details className="source-details">
                        <summary>検索の詳細</summary>
                        <p>
                            計算 {displayTime(view.result.calculatedAt)} ／{' '}
                            {view.result.context.crowd.summary}
                        </p>
                        {view.result.context.weather.status !== 'available' && (
                            <p>{view.result.context.weather.summary}</p>
                        )}
                    </details>
                </div>
            )}

            {view.stage === 'plan' && (
                <div className="panel result-panel">
                    <h2 ref={heading} tabIndex={-1}>
                        {view.option ? '寄り道の行程' : '直行の行程'}
                    </h2>
                    <p className="route-summary">
                        到着希望 {displayTime(view.search.result.arriveBy)}
                    </p>
                    {!view.option && view.search.result.outcome === 'DIRECT_LATE' && (
                        <p className="alert">直行でも到着希望時刻を過ぎる見込みです。</p>
                    )}
                    {view.option && <ExperienceSummary option={view.option} />}
                    {view.option && (
                        <OptionEstimateNotice option={view.option} showUnknownDetails />
                    )}
                    <ol className="timeline">
                        <li>
                            <strong>{view.origin.label}</strong>
                            <span>出発 {displayTime(view.calculatedAt)}</span>
                        </li>
                        {view.option && (
                            <li>
                                <strong>{view.option.place.label}</strong>
                                <span>
                                    {displayTime(view.option.time.stopArrivalAt)} 着 →{' '}
                                    {displayTime(view.option.time.stopDepartureAt)} 発
                                </span>
                            </li>
                        )}
                        <li>
                            <strong>{view.search.result.destination.label}</strong>
                            <span>
                                到着見込み{' '}
                                {displayTime(
                                    view.option?.time.arrivalAt ??
                                        view.search.result.direct.arrivalAt,
                                )}
                            </span>
                        </li>
                    </ol>
                    <MapsRouteLink
                        origin={view.origin.coordinates}
                        originPlaceId={view.origin.placeId}
                        originLabel={view.origin.label}
                        destination={view.search.result.destination}
                        stop={view.option?.place}
                    />
                    {view.option && <OptionDetails option={view.option} />}
                    <ApiAttributions entries={view.attributions} />
                    {view.option && (
                        <button
                            type="button"
                            className="button primary"
                            disabled={busy}
                            onClick={() => completeStop(view)}
                        >
                            寄り道を終えて直行 <span aria-hidden="true">→</span>
                        </button>
                    )}
                    {view.origin.gps && <LocationPrivacyNotice />}
                    <div className="actions">
                        <button
                            type="button"
                            className="button secondary"
                            disabled={busy}
                            aria-describedby={view.origin.gps ? 'location-purpose' : undefined}
                            onClick={() => recalculate(view.search, view.origin, view.option)}
                        >
                            {busy && <LoadingSpinner />}
                            {locating ? '現在地を取得中…' : pending ? '再計算中…' : '再計算'}
                        </button>
                        {view.option && (
                            <button
                                type="button"
                                className="button text-button"
                                disabled={busy}
                                aria-describedby={view.origin.gps ? 'location-purpose' : undefined}
                                onClick={() => recalculate(view.search, view.origin, null)}
                            >
                                直行に変更
                            </button>
                        )}
                        <button
                            type="button"
                            className="button text-button"
                            onClick={editConditions}
                        >
                            条件を変更
                        </button>
                    </div>
                    {feedback}
                </div>
            )}
        </section>
    );
}
