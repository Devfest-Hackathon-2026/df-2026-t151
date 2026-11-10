'use client';

import { Children, useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** Native horizontal scrolling keeps touch gestures independent of candidate selection. */
export function OptionCarousel({ children }: { children: ReactNode }) {
    const slides = Children.toArray(children);
    const viewport = useRef<HTMLDivElement>(null);
    const [active, setActive] = useState(0);
    const viewportId = useId();
    const hintId = useId();

    useEffect(() => {
        const track = viewport.current;
        const slide = track?.children[active];
        if (!track || !(slide instanceof HTMLElement)) return;
        // Only the visible card determines height; expanded details still remain readable.
        const resize = new ResizeObserver(() => {
            track.style.height = `${slide.getBoundingClientRect().height}px`;
        });
        resize.observe(slide);
        return () => resize.disconnect();
    }, [active, slides.length]);

    if (!slides.length) return null;
    const multiple = slides.length > 1;

    function goTo(index: number) {
        const track = viewport.current;
        if (!track) return;
        const next = Math.max(0, Math.min(slides.length - 1, index));
        track.scrollTo({
            left: next * track.clientWidth,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 'instant'
                : 'smooth',
        });
    }

    return (
        <section
            className="option-carousel"
            role="region"
            aria-roledescription="カルーセル"
            aria-label="寄り道候補"
        >
            {multiple && (
                <div className="carousel-navigation">
                    <button
                        type="button"
                        className="carousel-arrow"
                        aria-label="前の候補"
                        aria-controls={viewportId}
                        disabled={active === 0}
                        onClick={() => goTo(active - 1)}
                    >
                        <span aria-hidden="true">←</span>
                    </button>
                    <p className="carousel-position" role="status" aria-atomic="true">
                        候補 {active + 1} / {slides.length}
                    </p>
                    <button
                        type="button"
                        className="carousel-arrow"
                        aria-label="次の候補"
                        aria-controls={viewportId}
                        disabled={active === slides.length - 1}
                        onClick={() => goTo(active + 1)}
                    >
                        <span aria-hidden="true">→</span>
                    </button>
                </div>
            )}
            {multiple && (
                <p id={hintId} className="subtle carousel-hint">
                    左右にスワイプ、または矢印で候補を切り替え
                </p>
            )}
            <div
                id={viewportId}
                ref={viewport}
                className="carousel-viewport"
                tabIndex={multiple ? 0 : undefined}
                aria-label="候補カード"
                aria-describedby={multiple ? hintId : undefined}
                onScroll={(event) => {
                    const track = event.currentTarget;
                    if (track.clientWidth)
                        setActive(
                            Math.max(
                                0,
                                Math.min(
                                    slides.length - 1,
                                    Math.round(track.scrollLeft / track.clientWidth),
                                ),
                            ),
                        );
                }}
                onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    const targets: Record<string, number> = {
                        ArrowLeft: active - 1,
                        ArrowRight: active + 1,
                        Home: 0,
                        End: slides.length - 1,
                    };
                    if (event.key in targets) {
                        event.preventDefault();
                        goTo(targets[event.key]);
                    }
                }}
            >
                {slides.map((slide, index) => (
                    <div
                        className="carousel-slide"
                        key={index}
                        role="group"
                        aria-roledescription="スライド"
                        aria-label={`${index + 1} / ${slides.length}`}
                        inert={index !== active}
                        aria-hidden={index !== active}
                    >
                        {slide}
                    </div>
                ))}
            </div>
            {multiple && (
                <div className="carousel-dots" role="group" aria-label="表示する候補">
                    {slides.map((_, index) => (
                        <button
                            key={index}
                            type="button"
                            className="carousel-dot"
                            aria-label={`候補${index + 1}を表示`}
                            aria-current={index === active ? 'true' : undefined}
                            aria-controls={viewportId}
                            onClick={() => goTo(index)}
                        >
                            <span aria-hidden="true" />
                        </button>
                    ))}
                </div>
            )}
        </section>
    );
}
