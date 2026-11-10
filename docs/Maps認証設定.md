# Maps系APIのサービスアカウント認証

Vertex AIもADCへ移行する実装を追加した。以下のGemini Express・キー維持の記述はMaps移行時点の記録であり、以後の設定は[Vertex AI認証設定](VertexAI認証設定.md)を優先する。

2026年11月9日。Places API (New)・Routes API・Weather APIのサーバー認証を対象とする。画面・共通JSON・利用者向けログインは変更しない。GoogleへのAPI利用料金と、公開アプリへの大量アクセス対策は認証方式とは別に管理する。

## 採用理由

Cloud Runのサーバー間通信で長期APIキーの保管・交換を減らすため、実行サービスアカウントのADCを選んだ。固定送信元IP付きAPIキーとの比較、JSON秘密鍵を使わない理由、API制限や課金対策の限界は[APIキーからADCへ切り替えた理由](VertexAI認証設定.md#apiキーからadcへ切り替えた理由)にまとめる。WebサイトのHTTPリファラー制限がサーバー通信に適合しないことと、APIキー方式そのものの安全性は区別する。

## Cloud Runの設定

| 項目                     | 値                                                                |
| ------------------------ | ----------------------------------------------------------------- |
| プロジェクト             | gdgoc-hackathone-2026                                             |
| リージョン・サービス     | asia-northeast1・yorimichi                                        |
| 実行アカウント           | yorimichi-run@gdgoc-hackathone-2026.iam.gserviceaccount.com       |
| プロジェクトでの利用権限 | Service Usage Consumer（roles/serviceusage.serviceUsageConsumer） |
| GOOGLE_MAPS_AUTH_MODE    | service-account                                                   |
| GOOGLE_CLOUD_PROJECT     | gdgoc-hackathone-2026                                             |

ユーザーが上記の利用権限を付与し、エージェントが条件なしの付与を読み取り確認した。3つのAPIも有効化済み。このロールはserviceusage.services.useを含み、課金・割当先として指定するプロジェクトのAPI利用に使う。APIごとの呼出回数制限や、3つだけへのAPIキー制限と同一ではない。

Cloud Runの実行IDからADCで短期アクセストークンを取得する。Google公式google-auth-library 11.3.3を版固定で使用し、期限に応じたトークン更新をライブラリへ委ねる。サービスアカウントのJSON秘密鍵、利用者向けOAuth同意画面、固定送信IPやCloud NATはこの方式では作成しない。

Maps通信にはAuthorizationのBearerトークンとX-Goog-User-Projectを付け、X-Goog-Api-Keyを付けない。認証に失敗してもAPIキー方式へ自動で戻さない。Gemini Expressだけは従来のGEMINI_API_KEYを維持し、Mapsのトークンを渡さない。

## 切り替え手順

1. 実行アカウント、APIの有効化、利用権限、変更前のReadyリビジョンを確認する。
2. テスト・本番ビルド・型チェック・整形を通したソースから、既存サービスへトラフィックを付けず検証用リビジョンを作る。上記2環境変数を設定し、GOOGLE_MAPS_API_KEYのSecret参照だけを新リビジョンから外す。Gemini・署名秘密値の参照とリソース制限は維持する。
3. 検証先のhealth・capabilitiesと、公開地点を使った実接続を確認する。capabilitiesのliveは設定の認識であり、認証や全APIの成功証明とはしない。
4. 接続を確認後に本番トラフィックを切り替え、通常URLでも動作を確認する。検証用のトラフィックタグは片付ける。
5. 問題があれば変更前のリビジョンへ戻せるよう、Secret Managerの既存Mapsキーの値・バージョンは削除しない。旧キーの制限もこの作業で緩めない。HTTPリファラー制限のため旧版も失敗している場合、旧版への切り戻しだけで復旧するとは限らない。

本番切替結果は[Cloud Runの作業記録](CloudRun公開手順.md)と[検証結果](検証結果.md)へ、実施後に記録する。

2026年11月9日に切替を実施済み。yorimichi-00008-gufへ100%切替、検証用タグは削除した。Mapsキー参照なしでPlaces・寄り道検索の経路と天候・選択後VALIDを確認。通常URLでもPlacesは200。Gemini・署名の2秘密参照と既存リソース制限は維持する。キー自体の制限やSecret Managerの既存値は変更・削除していない。

## ローカル環境

GOOGLE_MAPS_AUTH_MODEを省略した場合は従来のapi-key方式を使う。明示したservice-account方式の設定不足や、未知の方式をapi-keyへ読み替えることはない。.env.exampleの項目を参照する。

ローカルでもサービスアカウント方式を使う場合は、開発者がCLIでADCを準備する。サービスアカウントのなりすましには、実行アカウントに対する開発者自身のService Account Token Creator権限が別途必要になる。今回、CLIでのなりすましはその権限不足で使用できず、権限追加はしていない。Cloud Run自身の認証にその追加権限は不要。

権限を個別に準備した開発者向けの例：

```sh
gcloud auth application-default login --impersonate-service-account=yorimichi-run@gdgoc-hackathone-2026.iam.gserviceaccount.com
```

ADCファイルはリポジトリ外に置く。Dockerで使う場合は、そのファイルだけをコンテナの `/var/run/google/adc.json` 等へ読み取り専用でマウントし、コンテナ内のGOOGLE_APPLICATION_CREDENTIALSをそのパスに設定する。GOOGLE_MAPS_AUTH_MODE=service-accountとGOOGLE_CLOUD_PROJECTも設定する。Windows上でログインしただけでは、分離されたDockerコンテナから認証設定は見えない。

ADCファイルは認証情報であり、Git・Dockerイメージ・Cloud Buildのアップロード・チャットへ含めない。既存のMapsキーにHTTPリファラー制限がある場合、それをローカルのサーバーへ設定しても使えない。ローカルADCの実接続を今回確認済みとは扱わない。公開画面を使うAへAPIキーを渡す必要はない。

## 保守と確認範囲

- maps-auth.ts：方式・プロジェクトの検証、ADCによるトークン取得、静的な認証エラーへの変換。
- google-http.ts：MapsとGeminiの認証を分け、固定のGoogleホストへ既存のHTTP処理で送る。GoogleServiceErrorはgoogle-service-error.tsに分離し、既存のimport元からも再公開する。
- 認証取得を含め、Maps各通信は既存の最大5秒等の枠内とする。キャンセル・処理全体25秒・天候の短い予算も維持する。ADCの更新通信にはトランスポーターのタイムアウトを設定し、呼出元は残り時間や中断を待ち続けない。中断後にADC処理が完了・失敗しても生エラーを公開しない。
- テストは架空のトークンを注入し、Bearer／課金先ヘッダー、キー非送信、Geminiの分離、設定不足、失敗時の非フォールバック、タイムアウト・中断、秘密情報の非露出、予算内への認証設定引き渡しを確認する。SDKの更新動作自体を自作のモックで検証済みとはしない。
- 公開アプリの利用者別・全インスタンス共有の呼出制限は引き続き未実装。サービスアカウント認証で公開HTTP APIの利用者まで認証されたことにはならない。

## 参照

- [Places APIのOAuth認証](https://developers.google.com/maps/documentation/places/web-service/get-api-key)
- [Routes APIのOAuth認証](https://developers.google.com/maps/documentation/routes/get-api-key)
- [Weather APIのOAuth認証](https://developers.google.com/maps/documentation/weather/get-api-key)
- [Cloud RunのサービスIDとADC](https://docs.cloud.google.com/run/docs/securing/service-identity)
- [課金・割当先プロジェクトの必要権限](https://docs.cloud.google.com/docs/quotas/set-quota-project)
