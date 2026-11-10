'use client';

import { useEffect, useRef, useState } from 'react';
import type { Attribution, PlaceSearchMatch, PlacesResponse } from '@/lib/api/types';
import { lookupPlaces, PlannerApiError, requestTimeoutMs } from '@/lib/client/planner-api';
import { LoadingSpinner } from '@/components/loading-spinner';

export type PlaceSelection = PlaceSearchMatch & { attributions?: Attribution[] };

function shortAddress(place: PlaceSearchMatch) {
    return place.address?.replace(/^日本[、,]\s*/, '').replace(/^〒\d{3}-\d{4}\s*/, '') ?? '';
}

function PlaceMapLink({ place, label }: { place: PlaceSearchMatch; label: string }) {
    const params = new URLSearchParams({
        api: '1',
        query: `${place.latitude},${place.longitude}`,
        query_place_id: place.placeId,
    });
    return (
        <a
            className="button map-link"
            href={`https://www.google.com/maps/search/?${params}`}
            target="_blank"
            rel="noreferrer"
            aria-label={label}
        >
            地図 ↗
        </a>
    );
}

export function ApiAttributions({ entries = [] }: { entries?: Attribution[] }) {
    if (!entries.length) return null;
    return (
        <ul className="api-attributions" aria-label="データ提供元" translate="no">
            {entries.map((entry, index) => {
                const label = typeof entry === 'string' ? entry : entry.provider;
                if (typeof label !== 'string' || !label) return null;
                const uri =
                    typeof entry === 'object' && typeof entry.providerUri === 'string'
                        ? URL.parse(entry.providerUri)
                        : null;
                const href =
                    uri &&
                    (uri.protocol === 'https:' || uri.protocol === 'http:') &&
                    !uri.username &&
                    !uri.password
                        ? uri.href
                        : null;
                return (
                    <li key={index}>
                        {href ? (
                            <a href={href} target="_blank" rel="noreferrer">
                                {label}
                            </a>
                        ) : (
                            label
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

export function PlaceLookup({
    id,
    label,
    selected,
    onSelect,
    hideLabel = false,
}: {
    id: 'destination' | 'origin';
    label: string;
    selected: PlaceSelection | null;
    onSelect: (place: PlaceSelection | null) => void;
    hideLabel?: boolean;
}) {
    const [query, setQuery] = useState(selected?.label ?? '');
    const [result, setResult] = useState<PlacesResponse | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const active = useRef<AbortController | null>(null);
    const queryInput = useRef<HTMLInputElement>(null);
    const selection = useRef<HTMLElement>(null);
    const text = query.trim();

    useEffect(
        () => () => {
            const controller = active.current;
            active.current = null;
            controller?.abort();
        },
        [],
    );

    async function search() {
        if (!text || active.current || result || selected) return;
        const controller = new AbortController();
        active.current = controller;
        setPending(true);
        setError('');
        const timer = window.setTimeout(() => {
            controller.abort(new DOMException('Request timed out', 'TimeoutError'));
        }, requestTimeoutMs);
        try {
            const response = await lookupPlaces(text, controller.signal);
            if (active.current === controller) setResult(response);
        } catch (cause) {
            if (active.current !== controller) return;
            setError(
                cause instanceof PlannerApiError
                    ? cause.message
                    : cause instanceof DOMException && cause.name === 'TimeoutError'
                      ? '場所検索がタイムアウトしました。'
                      : '場所を検索できませんでした。',
            );
        } finally {
            window.clearTimeout(timer);
            if (active.current === controller) {
                active.current = null;
                setPending(false);
            }
        }
    }

    if (selected) {
        const detail = shortAddress(selected) || selected.typeLabel;
        return (
            <div className="field">
                {!hideLabel && <span className="field-label">{label}</span>}
                <div className="selected-place">
                    <div>
                        <strong ref={selection} tabIndex={-1}>
                            ✓ {selected.label}
                        </strong>
                        {detail && <p className="subtle">{detail}</p>}
                        <ApiAttributions entries={selected.attributions} />
                    </div>
                    <button
                        type="button"
                        className="button text-button"
                        aria-label={`${label}を変更`}
                        onClick={() => {
                            onSelect(null);
                            requestAnimationFrame(() => queryInput.current?.focus());
                        }}
                    >
                        変更
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="field">
            <label htmlFor={`${id}-query`} className={hideLabel ? 'sr-only' : undefined}>
                {label}
            </label>
            <div className="lookup-query">
                <input
                    ref={queryInput}
                    id={`${id}-query`}
                    data-field={id}
                    value={query}
                    maxLength={200}
                    placeholder="場所名または住所"
                    onChange={(event) => {
                        const value = event.target.value;
                        setQuery(value);
                        if (value.trim() === text) return;
                        const controller = active.current;
                        active.current = null;
                        controller?.abort();
                        setPending(false);
                        setResult(null);
                        setError('');
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        void search();
                    }}
                />
                <button
                    type="button"
                    className="button secondary"
                    aria-label={`${label}を検索`}
                    disabled={!text || pending || !!result}
                    onClick={() => void search()}
                >
                    {pending && <LoadingSpinner />}
                    {pending ? '検索中…' : '検索'}
                </button>
            </div>
            {pending && (
                <p role="status" className="lookup-pending">
                    <LoadingSpinner />
                    {label}を検索しています…
                </p>
            )}
            {error && (
                <p role="alert" className="alert">
                    {error}
                </p>
            )}
            {result &&
                (result.places.length ? (
                    <div className="place-results">
                        <p className="subtle" role="status">
                            {label}を選択
                        </p>
                        <ul className="place-list" aria-label={`${label}の候補`}>
                            {result.places.map((place, index) => {
                                const address = shortAddress(place);
                                const duplicates = result.places.filter(
                                    (other) => other.label === place.label,
                                );
                                const ambiguous =
                                    duplicates.filter(
                                        (other) =>
                                            shortAddress(other) === address &&
                                            other.typeLabel === place.typeLabel,
                                    ).length > 1;
                                const qualifier = [
                                    address,
                                    (duplicates.length > 1 || !address) && place.typeLabel,
                                ]
                                    .filter(Boolean)
                                    .join(' · ');
                                const mapLabel = `${place.label} ${qualifier} 候補${index + 1}の地図`;
                                return (
                                    <li key={place.placeId} className="place-row">
                                        <button
                                            type="button"
                                            className="place-choice"
                                            onClick={() => {
                                                onSelect({
                                                    ...place,
                                                    attributions: result.attributions,
                                                });
                                                requestAnimationFrame(() =>
                                                    selection.current?.focus(),
                                                );
                                            }}
                                        >
                                            <strong>{place.label}</strong>
                                            <span>
                                                {qualifier || '住所情報なし'}
                                                {ambiguous && ` · 候補${index + 1}`}
                                            </span>
                                        </button>
                                        <PlaceMapLink place={place} label={mapLabel} />
                                    </li>
                                );
                            })}
                        </ul>
                        <ApiAttributions entries={result.attributions} />
                    </div>
                ) : (
                    <p role="status" className="subtle">
                        見つかりませんでした。場所名か住所を変えてください。
                    </p>
                ))}
        </div>
    );
}
