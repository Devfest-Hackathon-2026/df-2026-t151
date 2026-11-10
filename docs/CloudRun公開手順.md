# Cloud Run公開の作業記録

初回デプロイは2026年11月8日。一般公開と本番の実API検証は2026年11月9日（日本時間）に完了。

## 提出向けAPI制限100倍版の公開（2026年11月10日）

- ユーザーの提出向け増枠の依頼と50倍または100倍の指定を受け、100倍版のa212451a77467e12e77ee9fb7426c72ca545677cを固定して公開した。Cookie単位は場所2,000回/分・10,000回/日、候補300回/分・1,000回/日、再検証1,000回/分・3,000回/日。プロセス全体は場所6,000回/分、候補と再検証合計2,000回/分。同時処理は場所4件・候補と再検証合計2件を維持。
- Node.js 24.22.2のネットワーク・秘密設定なしDocker環境で全459テスト、本番ビルド、型チェック、全体整形チェックが成功。100倍版のGitHub CI（Check #216）も成功した。
- コミット済み155ファイルだけをアップロードし、ローカル秘密設定・ADC・認証フォルダ・依存・ビルド生成物を含まないことを確認。Cloud Build d0c53670-21b8-4f9a-a0de-e5e4a998e259はSUCCESS。
- 通常トラフィックなしのyorimichi-00024-qudで画面・案内・health・capabilities・Placesが200、Secure Cookieを確認。候補検索は200・OPTIONS・3件、天候available・直行経路あり（約10.2秒）、選択後は200・VALID・同じ地点と体験（約6.3秒）。
- 切替直前に通常トラフィックが00015-td9へ100%であることと新リビジョンを再確認し、00024-qudへ100%切替、検証タグを削除。通常公開URLでも画面・案内・health・capabilities・Places・Secure Cookieを確認した。同じリビジョンのため有料の候補生成・再検証を通常URLでは繰り返していない。
- CPU1・512Mi・最大1台・同時8件・60秒、実行IDと既存認証を維持。Google側のクォータ・IAM・ログ・Secret値は変更していない。今回の回数はアプリの操作上限であり、外部API全体の課金上限ではない。
- 本番で上限まで大量の有料APIを呼ぶ負荷試験、実ブラウザ全操作・GPS・スマートフォン実機・現地利用は未実施。上限境界と日替わりは自動テストで確認した。PR #52で変更と公開結果を共有し、mainへのマージは代行しない。

## デプロイ先と設定

| 項目                     | 確認済みの設定                                              |
| ------------------------ | ----------------------------------------------------------- |
| プロジェクト             | gdgoc-hackathone-2026                                       |
| リージョン・サービス     | asia-northeast1（東京）・yorimichi                          |
| URL                      | https://yorimichi-1044029411710.asia-northeast1.run.app     |
| Readyリビジョン          | yorimichi-00024-qud                                         |
| CPU・メモリ              | 1 CPU・512Mi                                                |
| インスタンス             | 最小0・最大1                                                |
| 同時リクエスト・上限時間 | 8・60秒（アプリの検索上限25秒とは別）                       |
| 実行アカウント           | yorimichi-run@gdgoc-hackathone-2026.iam.gserviceaccount.com |
| Maps認証                 | service-account・課金先gdgoc-hackathone-2026                |
| 現在の秘密参照           | OPTION_TOKEN_SECRET（バージョン1）のみ                      |
| アクセス                 | 一般公開。未認証のhealth・画面は200                         |

通常の `/` から実APIを利用し、架空デモ・modeによる切り替えは削除済み。旧 `/?mode=api`・`/?mode=demo` も同じ実API画面になる。最大1インスタンスでも更新時のリビジョン併存・再起動等があるため、プロセス内制限を全体の課金上限とは扱わない。

Vertex AIもADC、GOOGLE_CLOUD_LOCATION=globalを使用。実行アカウントには推論のみのカスタムロールとService Usage Consumerを付与し、Google APIキーの環境参照はない。

## 最新mainの公開（2026年11月9日）

ユーザーのデプロイ依頼により、最新mainのe45e2f4d2f7c738f7389ee5d813016f0953a525dを固定スナップショットから公開した。候補の暫定表示・3km探索と除外診断、詳細取得の部分失敗への対応、Cookie制限の容量時フォールバック、位置情報の案内画面など、マージ済みの更新を含む。未マージのブランチは取り込んでいない。

- 同じロックファイルの依存を使い、Node 24.11.1のネットワークなしDocker環境で全459件のテスト、本番ビルド、型チェック、全体format:checkが成功。
- アップロード153ファイルにローカル秘密設定・ADC・認証フォルダ・検証専用スクリプトなし。検証で生成した型ファイルをアップロード元から除いた。Cloud Build eed3bfd3-9afa-4757-ba7f-d626fb273525はSUCCESS。
- yorimichi-00016-cirを通常トラフィックなしで作成。検証用URLで画面・位置情報案内・health・capabilities・Placesが200、live・WALK。Secure Cookieの発行と同じCookieでの後続リクエストを確認した。
- 公開地点による候補検索は200・OPTIONS・3件、天候available・直行経路あり、約10.9秒。選択後は200・VALID・同一地点と体験を維持し、約6.3秒。今回の実応答に暫定候補はなく、暫定判定や容量時フォールバック等の境界は自動テストで確認している。
- 切替直前にも、本番00011-m8q・新リビジョン00016-cirを読み取り確認。00016-cirへ100%切替し、検証タグlatest-checkを削除した。通常公開URLでも画面・位置情報案内・health・capabilities・Placesが200、場所候補2件、Secure Cookieを確認。同じリビジョンのため、有料の生成・再検証を通常URLでは繰り返していない。
- Maps・Vertex AIのADC、署名用Secret OPTION_TOKEN_SECRET:1、実行アカウント、CPU1・512Mi・最大1台・同時8件・60秒を維持。IAM・ログ・旧キー・Secret値・旧リビジョンは変更・削除していない。
- 実ブラウザでの全操作・GPS許可操作・スマートフォン実機・現地利用は未確認。HTTP確認と自動テストの範囲を、実機の確認と区別する。

## ADC版の実接続と公開（2026年11月9日）

- 最小カスタムロールprojects/gdgoc-hackathone-2026/roles/yorimichiVertexPredictorを作成し、実行アカウントへプロジェクト上で付与した。含む権限はaiplatform.endpoints.predictのみ、GA。既存のService Usage Consumerを維持する。
- 作業中に同じアカウントへのroles/aiplatform.editor付与が見つかり、ユーザーは実接続確認後に外すことを承認した。削除操作の時点では対象バインディングが既になく、再読取でカスタムロールとService Usage Consumerのみを確認した。エージェントがEditorの削除に成功したとは扱わない。
- efe13c8のソースをCloud Build c3e81283-ae8c-46c2-b74a-86ecf3e2dcaaでビルドしSUCCESS。143ファイルのアップロードに秘密設定・ADC・認証用フォルダを含まず、yorimichi-00010-sinを通常トラフィックなしで配置した。GOOGLE_CLOUD_LOCATION=globalを設定し、GEMINI_API_KEYのSecret参照を外した。
- 検証用URLでhealth・capabilities・公開地点のPlacesが200、ok・live・WALK。候補探索は200・OPTIONS・2件・天候available・直行経路ありで約10.8秒。選択後は200・VALID・同一地点と体験を維持し約5.1秒だった。APIキーを参照しない実行IDでGemini・Mapsの実処理を確認した。
- Editorの付与がないことを読み取り確認した時点でも、候補探索200・OPTIONS・1件・天候available・直行経路ありで約7.3秒、選択後200・VALID・同一地点と体験で約5.2秒を確認。生成候補数は時点と応答により変わる。
- 確認後に00010-sinへ100%切替し、検証タグvertex-adc-checkを削除。通常公開URLでもhealth・capabilities・Placesが200、ok・live・WALK、場所候補2件を確認。同じリビジョンのため、通常URLで有料の生成・再検証は繰り返していない。
- CPU1・512Mi・最大1台・同時8件・60秒と実行アカウント、Mapsのservice-account設定を維持。現在のSecret参照はOPTION_TOKEN_SECRETのバージョン1のみ。ログ設定は変更せず、旧APIキー・Secret値・旧リビジョンは削除・失効していない。
- 全430テスト・本番ビルド・型チェック・整形チェックと実装コミットのGitHub CI成功を確認。実ブラウザ全操作・現地利用・ローカルADCは未確認。mainへのマージは代行していない。

## Maps認証移行版の公開（2026年11月9日）

2442b66までのソースをCloud Build 57e2e7e0-fa14-4a7e-ad76-018c83de5995でビルドしてSUCCESS。138ファイルのアップロード対象に秘密設定・ADC認証情報・検証専用コードを含めず、yorimichi-00008-gufをトラフィックなしで作成した。GOOGLE_MAPS_AUTH_MODE=service-accountとGOOGLE_CLOUD_PROJECTを指定し、新リビジョンのGOOGLE_MAPS_API_KEY参照を外した。

検証用タグのURLで、未認証のhealth・capabilities・新宿駅と新宿御苑のPlacesが200、ok・live・WALK。現在から180分後の寄り道検索は200・OPTIONS・外観1件・直行経路あり・天候availableで約8.8秒。選択後は200・VALID・同じ地点と体験を維持し、約6.7秒だった。これにより、キーを参照しないCloud Run実行IDでPlaces・経路・天候を使う実処理を確認した。別途Geminiのキーも使用する。

確認後に00008-gufへトラフィック100%を切り替え、検証用タグを削除。通常の公開URLでもhealth・capabilities・Placesが200、ok・live・WALK、新宿駅2候補を確認した。同じリビジョンのため通常URLで有料の候補検索と再検証は繰り返していない。実ブラウザ・現地利用・実機タッチ・ローカルADCは今回未確認。

CPU1・512Mi・最大1台・同時8件・60秒・専用実行アカウントを維持し、Gemini・署名秘密値の既存バージョン1参照も維持。IAM・ログシンク・既存キーの制限はエージェントが変更していない。MapsのSecret Managerの値と旧リビジョンは削除していない。旧方式の記録や下記の3秘密項目のうち、Mapsキーは現在のリビジョンでは参照しない。設定・ローカルでの開発方法は[Maps認証設定](Maps認証設定.md)を参照する。

確認用スクリプトの初回リクエストは、日時の小数が6桁だったため400となった。APIの許容するミリ秒精度に直し、上記の実処理を確認した。アプリ側の入力検証は緩めていない。秘密値・実地点ID・座標・候補トークン・生応答はGitや通常の診断出力へ記録していない。

## 候補横スワイプ版の公開（2026年11月9日）

候補を1枚ずつ横スワイプ・矢印・ドットで切り替える表示を、1ef34c6までのソースからデプロイした。アップロード134ファイルに秘密設定・認証情報・隔離プレビューを含まないことを確認。ビルドとデプロイが成功し、yorimichi-00007-mpfがトラフィック100%を処理する。

CPU1・512Mi・最大1台・同時8件・60秒・専用実行アカウントとSecret Managerの3つのバージョン1参照を維持し、ログ設定は変更していない。公開の未認証HTTPで画面・health・capabilitiesが200、ok・live・WALK。画面のJavaScript7本とCSS1本からカルーセル・次ボタン・スワイプ案内・Scroll Snapの配信と、Googleマップのルートリンクの維持を確認した。架空デモ表示はない。

切り替え操作は公開ソース外の架空データ明示ページで確認済み。公開後の実API取得から行程までのブラウザ再操作・実機タッチは未確認。サーバー処理を変更していないため、有料の候補探索は再実行していない。PR #34へまとめ、マージは代行していない。

## Googleマップ連携版の公開（2026年11月9日）

行程の最新の出発地点・選択した寄り道先・最終目的地をGoogleマップの徒歩検索へ渡すリンクを、d73c506までのソースからデプロイした。アップロード133ファイルに秘密設定・認証情報・隔離プレビューを含まないことを確認。ビルドとデプロイが成功し、yorimichi-00006-kjzが100%のトラフィックを処理する。

既存のCPU1・512Mi・最大1台・同時8件・60秒・専用実行アカウントとSecret Managerの3つのバージョン1参照を維持。ログ設定は変更していない。未認証の公開HTTPで画面・health・capabilitiesが200、health=ok・live・WALKを確認。公開画面が読み込む7本のJavaScriptにルートボタン・固定のMaps Directions URL・waypoint_place_idsが含まれ、架空デモ表示がないことを確認した。

Googleマップでの公開3地点と徒歩経路の表示は隔離した部品確認で実施済み。本番の実ブラウザでの行程全操作・スマートフォン実機のアプリ起動は未確認。サーバーの動作は変更していないため、公開後に候補探索等の有料API呼び出しは繰り返していない。

## 外観必須枠・体験見出しの公開（2026年11月9日）

外観観察を先頭の必須1件として、追加体験と合わせ最大3件にする変更と、大きな体験名・説明を常時表示する変更をb24a79dまでのソースからデプロイした。アップロード130ファイルに秘密設定・認証情報・隔離プレビューを含まないことを確認。Cloud Build 7b270e87-b77e-437b-a158-288a5a75db70はSUCCESS。yorimichi-00005-57dへ100%切替済み。

既存のCPU1・512Mi・最大1台・同時8件・60秒と3つのSecret Manager参照を維持し、ログ設定は変更していない。本番HTTPで通常画面・health・capabilities・Placesが200、live・WALKを確認。新宿駅→新宿御苑・120分後の検索は200・NO_OPTIONS・EXTERIOR_REQUIREDとなり、条件を満たさない外観を捏造せず候補なしにした。この実行では候補なしのため本番の選択後再検証を省略した。

同じコードのローカル実API確認では外観1件→選択後VALID・同一地点と体験保持を確認済み。候補の成立は取得時の根拠等で変動する。混合3件は自動テスト、体験の大きな表示は公開ソース外の部品プレビューで確認し、本番の実ブラウザでの全操作・現地利用とは分ける。

## 架空デモ削除版の公開（2026年11月9日）

ユーザーの架空デモ削除依頼に対し、通常URLを実API専用とする変更を35198e7でコミット・Pushし、既存サービスへソースデプロイした。アップロード対象127ファイルにローカル秘密設定が含まれないことを確認。既存Dockerfileでのビルド・デプロイが完了し、yorimichi-00004-f7jがトラフィック100%を処理する。

認証なしのHTTPで `/`・`/?mode=demo`・`/?mode=api` が全て200、実在場所の検索入力あり、APIテスト・架空デモ・通信シミュレーターの表示なしを確認。healthはok、capabilitiesはlive・WALK、Placesの新宿駅検索は2件を取得した。CPU1・512Mi・最大1台・同時8件・60秒とSecret Managerの既存3参照は維持し、ログ設定は変更していない。

今回の公開後確認はHTTPによる画面・設定・場所検索まで。ブラウザ確認はローカル本番モードで実施し、GPS許可操作・実機スマートフォン・公開後の候補検索から再検証までの再操作は未実施。

## ソースデプロイによる更新（2026年11月9日）

ユーザーの明示依頼で、リポジトリルートから `gcloud run deploy yorimichi --source . --project gdgoc-hackathone-2026 --region asia-northeast1 --quiet` を実行した。公開対象はfeat/api-indoor-experiencesの298d18b（天候による選定・飲食と館内体験を含む）。PR #27・#28のマージは行っていない。

アップロード対象126ファイルにローカル秘密設定・認証設定が含まれないことを確認。Cloud Build c49159df-53e9-4b2e-be7d-207af210e19bが既存DockerfileをビルドしてSUCCESSとなり、yorimichi-00003-554へ100%のトラフィックを切り替えた。更新前はyorimichi-00002-6rm。

既存のCPU・メモリ・最大1台・同時8件・60秒・実行アカウントと3つのSecret Managerバージョン1参照を維持。ログ除外は有効な既存設定を読み取り確認し、変更していない。ログ保存件数の再測定はしていない。

認証なしの本番HTTPでhealth・capabilities・実API画面・新宿駅と新宿御苑の場所検索が200。live・WALK、寄り道検索は200・OPTIONS・1候補・天候available（約9.5秒）、選択後は200・VALID・同じ地点保持（約6.2秒）を確認した。候補の体験種別は記録しておらず、屋内候補の実返却を確認したとは扱わない。ブラウザ操作・現地利用は未確認。

## 秘密設定

ユーザーから送信元・送信先を指定した明示承認を受け、ローカル.env.localの既存3項目をSecret Managerへ登録した。実値を引数やログへ表示せず、標準入力で転送した。専用実行アカウントに各シークレット単位のsecretAccessorを付与し、Cloud Runでは数値バージョンを指定する。

| 環境変数            | Secret Managerの参照            |
| ------------------- | ------------------------------- |
| GOOGLE_MAPS_API_KEY | yorimichi-maps-api-key:1        |
| GEMINI_API_KEY      | yorimichi-gemini-api-key:1      |
| OPTION_TOKEN_SECRET | yorimichi-option-token-secret:1 |

キーの更新時は新バージョンを登録し、Cloud Runの参照も明示的に更新する。値をGit・コマンド引数・チャットへ載せない。

## 確認結果

- 請求設定が有効で、Cloud Run・Cloud Build・Artifact Registry等が有効なことを確認。Secret Manager APIを追加で有効化。
- 既存DockerfileをCloud Buildでビルドし、初回の非公開リビジョンを起動。その後、秘密設定を参照する2番目のリビジョンをデプロイ。
- 認証付きでhealth・capabilities・API画面が200。capabilitiesはlive・WALK。これは設定の認識であり、Google各APIの疎通成功ではない。
- ローカルの本番Linux/amd64イメージでもPORT=8080・非root起動、health等の200、.env.local除外を確認。
- CLIのアップロード対象103ファイルからローカル秘密設定が除外されることを確認。.dockerignore・.gcloudignoreにローカル認証・エージェント設定の除外を追加。

## HTTPアクセスログの除外

ユーザー自身がログルーターの_Defaultへ次の除外（yorimichi-private-requests）を追加し、エージェントが設定を読み取り確認した。エージェントはログシンクを変更していない。既存の他の設定は維持されている。

```text
resource.type="cloud_run_revision" AND resource.labels.service_name="yorimichi" AND logName="projects/gdgoc-hackathone-2026/logs/run.googleapis.com%2Frequests"
```

ログ除外の設定を確認後、yorimichiサービスだけにallUsersのrun.invokerを付与して一般公開した。以下は認証トークンなしの本番HTTP検証で、ブラウザ操作・現地確認とは別。

| 項目            | 実接続結果                                                     |
| --------------- | -------------------------------------------------------------- |
| health・API画面 | 200                                                            |
| capabilities    | 200・live・WALK                                                |
| 場所検索        | 新宿駅2候補、新宿御苑1候補、いずれも200                        |
| 寄り道検索      | 新宿駅→新宿御苑・期限90分後で200・OPTIONS・実候補1件、約12.6秒 |
| 天候            | available・帰属表示あり                                        |
| 選択後の再検証  | 200・VALID、同じ地点を保持、約6.9秒                            |

候補件数や応答時間は変動する。混雑は引き続きunknown。APIの実見積もりを現地利用・到着保証とは扱わない。

## 更新用コマンド

Google CLIへログインした環境で、リポジトリルートから実行する。既存の秘密参照を維持して一般公開のまま更新する例。

```sh
gcloud run deploy yorimichi --source . --project gdgoc-hackathone-2026 --region asia-northeast1 --port 8080 --cpu 1 --memory 512Mi --min-instances 0 --max-instances 1 --concurrency 8 --timeout 60 --service-account yorimichi-run@gdgoc-hackathone-2026.iam.gserviceaccount.com --allow-unauthenticated
```

秘密値を更新した場合はSecret Managerの新しい数値バージョンも明示的に設定する。変更前のReadyリビジョン名を確認し、問題があれば以前のリビジョンへトラフィックを戻す。

## 参考

- [Next.jsのCloud Run公開](https://docs.cloud.google.com/run/docs/quickstarts/frameworks/deploy-nextjs-service)
- [Cloud Runの秘密設定](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
- [非公開サービスの確認](https://docs.cloud.google.com/run/docs/authenticating/developers)
- [Cloud Runのログ](https://docs.cloud.google.com/run/docs/logging)

## 公開時の呼出制限とログ設定の到達点

| 対象                 | 現在有効な制限                                  |
| -------------------- | ----------------------------------------------- |
| 場所検索             | 1プロセスで毎分60件・同時4件                    |
| 候補検索と行程再検証 | 2エンドポイント合計で1プロセス毎分20件・同時2件 |
| Cloud Run            | 最大1インスタンス、同時リクエスト8              |

再起動・更新時の複数リビジョンをまたぐ共有制限、利用者単位の制限、外部APIの課金上限は未実装。したがって「公開時の呼出制限・ログ設定」全体を完了とは扱わない。

ログ除外は設定の存在・有効性に加え、新しいhealth確認後の2026-11-08T15:04:00Z以降の対象HTTPログが保存0件であることを確認した。設定確認直後の検証リクエスト5件は保存されていたため、設定の存在だけで即時の保存停止を保証しない。Googleの[ログルーター公式資料](https://docs.cloud.google.com/logging/docs/export/configure_export_v2)でもシンク変更の反映に数分かかる場合があるとされる。保存済みログの削除は実施していない。
