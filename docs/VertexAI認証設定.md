# Vertex AIのADC認証

2026年11月9日。Geminiの候補探索・構造化抽出・選択後の再検証を、ExpressモードのAPIキーから通常のVertex AIとADCへ移す。モデルはgemini-3.5-flash、画面・公開JSON・Mapsグラウンディングと既存の時間制限は維持する。

## APIキーからADCへ切り替えた理由

2026年11月9日、ユーザーが安全性とAPI制限の違いを比較し、Mapsに続いてVertex AIもADCへ移行する方針を選んだ。以下は今回のCloud Run構成に対する採用判断であり、APIキーが常に不適切という意味ではない。

### 解決したかったこと

現在の通信は「ブラウザ→Cloud Run→Google API」であり、Google APIを呼ぶ主体はサーバーである。Google API用の長期APIキーを保存・配布・交換する箇所を減らし、実行サービスアカウントの権限でアクセスを管理したかった。Mapsで検討したWebサイトのHTTPリファラー制限は、Cloud Runからのサーバー通信には適合しない。

ADCは認証情報を取得する仕組みで、権限を与える仕組みではない。今回採用したのは、Cloud Runに設定した実行サービスアカウントから短期アクセストークンを取得する方式である。JSON秘密鍵をファイルとして置く方式は採用しない。[Cloud RunのサービスID](https://docs.cloud.google.com/run/docs/securing/service-identity)

### 比較した選択肢

| 選択肢                                                                                              | 利点                                                                                         | 今回の判断                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| APIキー＋API制限・送信元IP制限（Mapsで比較）                                                        | キー単位で利用するAPIを指定でき、漏えい時も許可外のIPからの利用を制限できる                  | 有効な選択肢。ただし長期キーの保管・交換が必要で、Cloud Runの固定送信元IPには追加のネットワーク構成と運用が必要なため、今回は選ばない |
| Cloud Runの実行ID＋ADC                                                                              | アプリ側でGoogle API用の長期キーを保持せず、短期トークンの取得・更新をライブラリへ任せられる | 今回採用。既存のCloud RunとMapsのADC処理を利用できる                                                                                  |
| サービスアカウントのJSON秘密鍵を使うADC                                                             | 実行環境から独立して認証できる                                                               | 長期秘密鍵の保管・漏えいリスクが残るため、Cloud Runでは採用しない                                                                     |
| [Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation) | Google Cloud外の実行環境でも長期秘密鍵を置かずに認証できる                                   | 外部CI等で検討する方式。今回のCloud Run実行時認証には追加しない                                                                       |

APIキーのAPI制限・IP制限と、サーバー側でOAuthを推奨する方針は[Mapsの公式セキュリティ指針](https://developers.google.com/maps/api-security-best-practices)を参照。Cloud Runの固定送信元IPには[VPCとCloud NAT等の構成](https://docs.cloud.google.com/run/docs/configuring/static-outbound-ip)が必要。JSON秘密鍵については、Googleも[利用者が管理する秘密鍵を避けること](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys)を勧めている。

### 採用理由と受け入れた制約

採用理由は、長期キーの漏えい経路と交換作業を減らせること、実行IDに必要な権限だけを付けられること、MapsとVertex AIのサーバー認証を同じ方法で保守できることの3点。Vertex AIには推論用のaiplatform.endpoints.predictのみを含むカスタムロールを付与し、広いEditorロールを使わない。実装・権限・切替結果は本書の後続の節に記録している。

一方、ADCに切り替えてもAPIキーのAPI制限と同じ許可リストが付くわけではない。serviceusage.services.useは特定のMaps APIだけを指定する権限ではなく、推論権限も特定のGeminiモデルだけへの限定ではない。厳密な利用先制限が必要になれば、APIの有効化状態や専用プロジェクト等を別途設計する。専用プロジェクトへの分離は、この移行では実施していない。

短期トークンも漏えいすれば有効期間中は悪用され得る。サーバー自体の侵害や、公開アプリ経由の大量リクエストによる課金はADCだけでは防げないため、最小権限・呼出回数の制限・APIクォータ・利用状況の監視は別途必要である。ローカル開発ではADCの準備とDockerへの安全な引き渡しも必要になる。

旧APIキーの参照を外すことと、キー自体を失効させることは別の操作。今回の切替では、旧キーとSecret値は失効・削除していない。利用元と切り戻しの要否を確認した後に整理する。

## 設定

| 項目                     | 値                                                          |
| ------------------------ | ----------------------------------------------------------- |
| GOOGLE_CLOUD_PROJECT     | gdgoc-hackathone-2026                                       |
| GOOGLE_CLOUD_LOCATION    | global（省略時も同じ）                                      |
| Cloud Run実行アカウント  | yorimichi-run@gdgoc-hackathone-2026.iam.gserviceaccount.com |
| API                      | aiplatform.googleapis.com                                   |
| Vertex AIで必要な権限    | aiplatform.endpoints.predict                                |
| 課金・割当先で必要な権限 | serviceusage.services.use                                   |

Cloud Runは実行アカウントからADCで短期トークンを得る。JSON秘密鍵を発行せず、GOOGLE_APPLICATION_CREDENTIALSもCloud Runに設定しない。既存のgoogle-auth-library 11.3.3を共用するため、依存関係の追加はない。

生成と抽出はいずれも次のエンドポイントを使う。プロジェクトとロケーションはサーバー設定を検証してから組み立て、モデル・ホスト・操作をクライアントから受け取らない。リージョン指定時はGoogleのリージョン別ホストを使うが、そのモデル・Mapsグラウンディングの提供地域の確認が別途必要。今回の既定値はglobalとする。

```text
https://aiplatform.googleapis.com/v1/projects/gdgoc-hackathone-2026/locations/global/publishers/google/models/gemini-3.5-flash:generateContent
```

Authorization: BearerとX-Goog-User-Projectを付け、GEMINI_API_KEYとX-Goog-Api-KeyはVertex AIに使わない。ADC失敗・401・403でAPIキーへ戻さず、認証の生エラー・トークン・パスを公開JSONや通常ログへ出さない。Mapsのローカルapi-key方式は[Maps認証設定](Maps認証設定.md)のまま選択できる。

capabilitiesのliveはMaps認証・Vertexプロジェクト／ロケーション・署名秘密値の設定を認識した意味であり、ADCやIAM・モデルの利用可能性を疎通確認した結果ではない。

## IAMの準備

初回読み取りではAPIは有効で、推論ロールは未付与だった。その後、以下の最小カスタムロールを作成し、実行アカウントへ付与済み。既存のService Usage Consumerも維持する。実接続と公開結果は末尾の記録を参照。

カスタムロールのタイトルをYorimichi Vertex Predictor、IDをyorimichiVertexPredictorとし、権限はaiplatform.endpoints.predictのみを追加する。作成したロールを上記の実行アカウントへ、このプロジェクト上で付与する。既存のserviceusage.services.useは別ロールで維持する。アプリにロール管理・API有効化・デプロイ・Token Creatorを付与しない。

```yaml
title: Yorimichi Vertex Predictor
description: Generate content using Vertex AI at runtime
stage: GA
includedPermissions:
    - aiplatform.endpoints.predict
```

これは特定モデル・APIの許可リストや課金上限ではない。署名用シークレットの既存のSecret Accessor権限は、対象シークレット単位で維持する。

## ローカル開発

開発者自身に必要な権限がある場合は、gcloud auth application-default loginでADCを準備する。実行アカウントをなりすます場合は、そのサービスアカウントに対する開発者のToken Creator権限が別途必要。Cloud Run自身には不要。

Dockerにはリポジトリ外のADCファイルを読み取り専用でマウントし、コンテナ内のGOOGLE_APPLICATION_CREDENTIALSをそのパスに設定する。GOOGLE_CLOUD_PROJECTとGOOGLE_CLOUD_LOCATIONも設定する。Windowsでログインしただけでは、別のDockerコンテナには設定が見えない。ADCファイルはGit・イメージ・アップロード・チャットへ入れない。

## 本番切替

1. 推論権限の付与と現行Readyリビジョン・トラフィック・秘密参照を確認する。
2. 検証済みソースから、既存サービスのトラフィックを切り替えず検証リビジョンを作る。プロジェクトとglobalを設定し、そのリビジョンのGEMINI_API_KEYのSecret参照を外す。OPTION_TOKEN_SECRET、Mapsのservice-account設定、既存のCPU・メモリ・最大台数・同時実行・時間制限を維持する。
3. health・capabilitiesに加え、公開地点でPlaces→候補探索→選択後の再検証を確認する。Geminiの2段階生成、Maps出典・経路・天候の扱いを確認する。
4. 確認後に本番トラフィックを切り替える。旧キーやSecretの値は、この移行だけでは削除・失効しない。利用元と切り戻しを確認した後に別途整理する。

本番のIAM変更・デプロイ・実接続の結果は、実施後に検証結果.mdとCloudRun公開手順.mdへ追記する。公開アプリの大量呼び出し対策は認証方式とは別に必要。

## ADC版の実接続と公開（2026年11月9日）

推論のみのカスタムロールを作成・付与し、Vertex AI Editorの直接付与がないことを確認した。APIキー参照なしのyorimichi-00010-sinで、Geminiの2段階生成・Maps出典・Places・Routes・Weather・選択後VALIDを実接続で確認。100%切替と検証タグの削除を完了し、通常URLのhealth・capabilities・Placesも200だった。

現在のSecret参照は署名用OPTION_TOKEN_SECRETのバージョン1のみ。旧APIキー・Secret値・旧リビジョンは削除・失効していない。ビルドID、実測、IAM確認の経緯は[Cloud Run公開記録](CloudRun公開手順.md)、テストと未確認範囲は[検証結果](検証結果.md)を参照する。

## 参照

- [Vertex AIのADC設定](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/gcp-auth)
- [生成リクエストのIAM権限](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/access-control)
- [MapsグラウンディングのREST形式](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/grounding/grounding-with-google-maps)
- [Cloud RunのサービスID](https://docs.cloud.google.com/run/docs/securing/service-identity)
- [課金先プロジェクトの必要権限](https://docs.cloud.google.com/docs/quotas/set-quota-project)
