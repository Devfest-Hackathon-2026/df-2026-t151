import { googleMapsDirectionsUrl } from '@/lib/client/maps-directions';
import type { MapsDirectionsInput } from '@/lib/client/maps-directions';

export function MapsRouteLink(props: MapsDirectionsInput) {
    const href = googleMapsDirectionsUrl(props);
    if (!href)
        return <p className="subtle">ルートを開くには、出発地点を設定して再計算してください。</p>;
    return (
        <div className="maps-route">
            <a className="button primary" href={href} target="_blank" rel="noopener noreferrer">
                Googleマップで徒歩ルートを開く <span aria-hidden="true">↗</span>
            </a>
            <p className="subtle">
                出発地点{props.stop ? '・寄り道先' : ''}
                ・目的地をGoogleマップに渡します。経路と時間はGoogleマップで再計算されます。
            </p>
        </div>
    );
}
