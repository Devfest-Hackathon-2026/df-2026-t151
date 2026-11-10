import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: '位置情報の扱い | よりみち',
    description: 'よりみちで現在地を使うときの送信先、用途、保存期間について。',
};

export default function About() {
    return (
        <main className="site-shell">
            <header className="site-header">
                <a className="privacy-link" href="/">
                    よりみちを開く
                </a>
            </header>
            <article id="privacy" className="panel privacy-panel" aria-labelledby="privacy-title">
                <h1 id="privacy-title">位置情報の扱い</h1>
                <section>
                    <h2>現在地を取得するタイミング</h2>
                    <p>
                        「現在地を取得」を押すと、ブラウザの許可に基づいて現在地を取得します。現在地を出発地点にした行程では、「再計算」や「直行に変更」を押したときにも取得します。取得は操作ごとに1回です。
                    </p>
                    <p>
                        「場所を指定」から出発地点を手動で選べます。位置情報の許可は、ブラウザのサイト設定から取り消せます。
                    </p>
                </section>
                <section>
                    <h2>送信先と使い道</h2>
                    <p>
                        候補検索や行程の再計算では、端末から受け取った現在地の緯度・経度、目的地、到着希望時刻などを、よりみちのサーバーへ送ります。サーバーからは、必要な座標や地点情報をGoogleの場所検索・経路計算・天気予報、Geminiによる寄り道候補の探索に送ります。
                    </p>
                    <p>
                        「Googleマップで徒歩ルートを開く」を押すと、出発地点・目的地と、選択している寄り道先の情報がGoogleマップに渡ります。
                    </p>
                </section>
                <section>
                    <h2>Googleでの保存期間</h2>
                    <p>
                        GeminiがGoogleマップの情報を使って候補を探す機能では、Googleが現在地などの入力、関連情報、生成結果を30日間保存し、機能の信頼性を保つために使います。Googleの他のサービスでの取り扱いは、Googleのプライバシーポリシーをご確認ください。
                    </p>
                    <ul>
                        <li>
                            <a
                                className="privacy-link"
                                href="https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention"
                            >
                                Geminiのデータ保存に関するGoogleの説明
                            </a>
                        </li>
                        <li>
                            <a
                                className="privacy-link"
                                href="https://policies.google.com/privacy?hl=ja"
                            >
                                Googleのプライバシーポリシー
                            </a>
                        </li>
                    </ul>
                </section>
            </article>
        </main>
    );
}
