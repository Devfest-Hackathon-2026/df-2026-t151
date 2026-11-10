import type { Source } from '@/lib/api/types';

/** Maps grounding source titles and links must follow the generated content. */
export function GroundedSources({ sources }: { sources: Source[] }) {
    const entries = sources.filter(
        (source) => source.provider.startsWith('Google Maps：') && source.url,
    );
    if (!entries.length) return null;
    return (
        <div
            style={{
                fontFamily: 'sans-serif',
                fontSize: '0.75rem',
                color: '#5E5E5E',
                fontWeight: 400,
                fontStyle: 'normal',
                letterSpacing: 'normal',
            }}
        >
            <p>
                <span translate="no" style={{ whiteSpace: 'nowrap' }}>
                    Google Maps
                </span>
                を参照したAIによる提案
            </p>
            <details>
                <summary>Google Mapsの出典を見る</summary>
                <ul aria-label="AI提案のGoogle Maps出典">
                    {entries.map((source, index) => {
                        const url = URL.parse(source.url!);
                        if (!url || url.protocol !== 'https:' || url.username || url.password)
                            return null;
                        return (
                            <li key={index}>
                                <a
                                    href={url.href}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ color: '#5E5E5E' }}
                                >
                                    <span translate="no" style={{ whiteSpace: 'nowrap' }}>
                                        Google Maps
                                    </span>
                                    ：{source.provider.slice('Google Maps：'.length)}
                                </a>
                            </li>
                        );
                    })}
                </ul>
            </details>
        </div>
    );
}
