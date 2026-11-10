import Image from 'next/image';
import { TripPlanner } from '@/components/trip-planner';

export const metadata = { title: 'よりみち | 新宿の寄り道プランナー' };

export default function Home() {
    return (
        <div className="site-shell">
            <main>
                <header className="site-header">
                    <h1 className="wordmark">
                        <Image
                            src="/yorimichi-icon.png"
                            alt=""
                            width={32}
                            height={32}
                            unoptimized
                        />
                        よりみち
                    </h1>
                </header>
                <TripPlanner />
            </main>
            <footer className="site-footer">
                <a className="privacy-link" href="/about" target="_blank" rel="noopener noreferrer">
                    位置情報の扱い（別タブ）
                </a>
            </footer>
        </div>
    );
}
