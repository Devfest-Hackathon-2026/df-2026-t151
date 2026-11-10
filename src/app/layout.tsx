import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
    title: 'よりみち | 開発準備',
    description: '新宿で、次の予定までの時間を楽しむ',
    icons: { icon: { url: '/yorimichi-icon.png', type: 'image/png', sizes: '433x433' } },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang="ja">
            <body>{children}</body>
        </html>
    );
}
