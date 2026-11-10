# API入出力仕様 v0.1

## 不明情報を残す候補選別（2026年11月9日更新）

以降の不明時除外の記述に優先する。出発地点から直線3km以内とし、利用条件・営業状態・営業時間が不明でも暫定候補を返す。`opening.status`に`unknown`を追加し、`warnings`の`UNCONFIRMED_*`と`time.isProvisional=true`で不明事項を表す。行程再検証でも同一体験を維持して不明事項を返す。閉業・営業時間外などの確認できた利用不可条件は除外する。

検索・行程再検証の応答に任意の`exclusions: { stage, placeLabel, reason, source: { provider, url }, facts }[]`を追加。ブラウザのコンソールで理由と判断情報を表示し、座標・トークン・要求本文・生応答は含めない。新しい表示の架空例は[不明情報を含む候補fixture](../fixtures/search-provisional-success.json)。未確認条件と除外の区別・出力項目は[候補の不明情報と除外理由](候補の不明情報と除外理由.md)を参照。

Geminiの`outsideDestination: false`しか根拠がない場合は、`UNCONFIRMED_DESTINATION_RELATION`で暫定候補として扱う。Placesの包含関係で除外した場合は`source.provider: Google Places`と`facts.destinationRelationSource: google_places`を返す。利用条件の`outsideDestination`を除外診断に併記する場合は、`facts.outsideDestinationSource`でその値の由来を区別する。

## Cookieによる暫定呼び出し制限（2026年11月9日）

従来のプロセス全体の上限に加え、署名付きCookie識別子ごとに、場所検索2,000回/分・10,000回/日、候補検索300回/分・1,000回/日、再検証1,000回/分・3,000回/日（2026年11月10日に提出向けに100倍へ変更）を適用する。日は日本時間0時に更新する。入力検証後、外部APIを呼ぶ前に判定し、制限時は既存JSON形式の429・RATE_LIMITED・Retry-Afterと入力に対応するrequestIdを返す。初回・不正Cookieには、識別子を登録できるときにSet-Cookieを付ける。記録テーブルが満杯の場合、未登録の識別子はCookie単位の制限を省略し、プロセス全体の毎分・同時処理上限を適用する。画面・共通型・fixturesの変更は不要。回数はプロセス内で、Cookie削除・再起動・複数インスタンスによる制約がある。Firestoreへの移行を次の作業とする。実装・保持情報・残課題は[API呼び出し制限](API呼び出し制限.md)を参照。

## サーバーのMaps認証（2026年11月9日更新）

Places・Routes・Weatherのサーバー呼び出しは、GOOGLE_MAPS_AUTH_MODE=service-accountでは実行アカウントのADCによるBearerトークンとGOOGLE_CLOUD_PROJECTによる課金・割当先ヘッダーを使用する。APIキーを併送せず、失敗時にキーへ戻さない。Geminiも通常のVertex AIエンドポイントとADCへ移行し、GEMINI_API_KEYは使用しない。詳細は[Vertex AI認証設定](VertexAI認証設定.md)を参照。未指定時のローカルapi-key方式は残す。設定・必要権限は[Maps認証設定](Maps認証設定.md)を参照。本文のMapsキー必須という記述はapi-key方式の場合に適用する。

画面・サーバー間のJSON、capabilitiesの語彙・署名・期限・呼出制限は変更しない。capabilitiesはMapsの方式別設定、Vertexプロジェクト／ロケーションと署名秘密値を認識してlive／WALKを返すが、ADCの利用可能性や実接続を検査するエンドポイントではない。キー・トークン・生の認証エラーを画面や通常ログへ出さない。

2026年11月7日作成、11月9日実装状況更新。アプリ内部の画面・サーバー間契約。外部Google APIの仕様そのものではない。実装言語に依存しないJSON形式とする。場所検索・寄り道候補検索・行程再検証を実装済み。

## 実装との対応

- 共通型は `src/lib/api/types.ts`。画面・サーバー双方から `import type` で利用できる。型だけでは外部入力やJSONの実行時検証はできない。
- health・capabilities・GET /api/v1/places・POST /api/v1/recommendations・POST /api/v1/itineraries/validateを実装した。GOOGLE_MAPS_API_KEY・GEMINI_API_KEY・有効なOPTION_TOKEN_SECRETがあればcapabilitiesはWALK・live、なければ空配列・demo。これは設定上の対応状況でありGoogleへの疎通確認ではない。画面の架空デモ・モード分岐は削除し、通常URLから実APIを利用する。capabilitiesのdemoは画面のデモ動作を意味せず、設定不足時も架空候補へ代替しない。候補検索画面はdataMode=liveの応答だけを受理する。
- 入力検証は `src/server/request-validation.ts`。場所検索・候補検索・再検証の入力をunknownから検証し、失敗時はHTTP statusと本書のエラーbodyを返す。呼出側でJSON解析・本文サイズ制限・HTTP応答への変換を行う。
- 日時は秒を含む `YYYY-MM-DDTHH:mm:ss[.SSS]Z` または明示オフセット `±HH:mm` を受け付ける（小数秒は1〜3桁）。存在しない日付や過去・現在の期限は拒否し、翌日へ補正しない。比較にはサーバー時刻を使う。
- 入力上限はrequestId 128文字、query 200文字、place ID・experience ID 256文字、optionToken 4096文字、excludedPlaceIds 50件。空白のみ・制御文字は拒否する。requestId自体が不正ならエラーbodyのrequestIdは空文字にする。正常なrequestIdは変更せず返す。
- 検証器のsupportedTravelModesは既定で空配列。POSTハンドラーはWALKのみ許可し、設定不足は500にする。座標は世界の有効範囲のみ検証する。目的地・選択地点はPlace Detailsで実在情報を取得し、トークンは署名・有効期限・条件一致を検証する。新宿の境界設定は後続工程。
- 時間予算の計算は `src/server/time-budget.ts` のcalculateTimeBudget。検証済みのサーバー時刻・期限、経路秒数、体験時間範囲、待ち情報、余裕秒数を受け取る。余裕時間は呼出側の方針として明示的に渡し、外部データの取得や登録値の優先選択は行わない。
- 計算には体験時間と推定待ちの範囲の上限を使う。待ち込みなら追加待ち0秒・included、別待ちならseparate、不可避で不明かつ推定幅もない待ちは除外する。対象の飲食・館内体験の推定待ちはESTIMATED_WAIT・isProvisional=trueで表示し、観測値と区別する。含有不明で数値がある場合は保守的に別加算する。省略可能で不明な待ちはnull・unknown・暫定値を維持する。
- 必要時間には余裕を加算するがarrivalAtには加算しない。期限との比較はミリ秒のまま行い、表示用slackSecondsだけ秒に切り下げる。直行遅刻・負の追加移動・待ち込み総時間を超える待ちは除外し、負数・小数秒の所要時間・逆転した範囲・数値のオーバーフローは例外で拒否する。
- 計算結果のfitsDeadlineは時間条件だけを示し、推薦の可否を確定しない。入場・出発等の時刻、営業時間・最終入場、出典の有効性、体験時間の取得優先順位は下記の候補選定処理で検証する。時刻依存の公共交通等は未対応。待ち込み総時間だけから実入場時刻を捏造しないため、この計算結果はAPIのOptionTime全体とは別の内部型である。
- 本文とfixturesのJSON形式は変更していない。sourcesの構造化要素は `{ provider, url }`、includesWaitが不明な場合はnullとして共通型に明示した。提供元に固有の帰属表示は接続時に形式・利用条件を確認する。

### 飲食・館内体験の追加（2026年11月9日）

以降の初期外観限定の記録に優先する。外観public-exterior-v2に加え、cafe-break-v1／light-meal-v1／small-exhibit-v1を検索・署名・同一体験の再検証へ追加。初期推定上限は待ち・会計・退出を含め45／60／45分で、移動と余裕10分は別加算する。出典がある屋内利用・予約不要・固定開始なし・受付条件・展示規模を確認し、不明は除外する。詳細な条件・時間幅・AIと通常処理の分担は[飲食と館内体験.md](飲食と館内体験.md)を参照。

JSON形式は変更しない。推定待ちの場合、time.waitSecondsは追加する推定上限、waitTreatmentはseparate、isProvisionalはtrue。待ち込み総時間の場合はincluded・追加0秒だが、推定の注意は残す。experienceDurationは会計・退出を含み、待ちの含有はincludesWaitで区別する。crowdはunknown、料金の金額も未取得。画面は候補・行程に暫定表示を行い、詳細に内訳とwarningsを表示する。[外観と追加体験の架空fixture](../fixtures/search-mixed-success.json)はdemoで、実処理では使用しない。

再検証は現在のサーバー時刻と最新originを使う。未完了体験の滞在済み分は自動減算せず全時間で再評価し、体験終了後は既存の直行操作を使う。選択地点・体験IDは変更しない。Gemini・Places・Routes・Weatherの通信上限、プロセス内呼出制限、5分の署名期限は維持する。雨天時は必須の外観枠を確保したうえで追加候補の屋内案を優先し、雷雨・大雨等は徒歩移動を含む屋内案も除外する。

### 外観観察の必須枠と体験表示（2026年11月9日）

ユーザー指定により、OPTIONSでは先頭を有効なpublic-exterior-v2とし、飲食・館内体験を追加して全体で最大3件にする。時間・天候評価後の順位から外観1件を確保し、追加体験を最大2件、足りない枠は他の外観候補で補う。外観が成立しなければNO_OPTIONS・空配列・EXTERIOR_REQUIRED警告とし、画面で理由を表示する。必須枠のための条件緩和・架空候補の生成はしない。

探索は外観と予備を優先して最大4件を要求する。既存の最大6件の内部候補処理・最大4件の経路評価の枠内で、可能なら外観2件を先に評価する。最初の外観が除外されても、評価済みの予備が成立すれば採用できる。予報を再取得せず、構成変更後の先頭の外観にcontext.weatherを合わせる。

title・description・experienceId・sourcesの既存項目を使い、何ができるかの見出し・分類・説明を候補と行程に常時表示する。場所名は補足にし、Maps出典はAIの体験内容の直後に置く。共通型・JSON形式・入力は変更せず、テスト用fixtureを外観＋カフェ＋展示へ更新した。選択後の再検証は同じ選択体験だけが対象で、飲食の再検証時に外観を追加検索しない。

### 徒歩経路と直行見積もり（サーバー内部）

- `src/server/routes.ts` のcomputeWalkingRouteは、Google Routes APIのCompute Routesへ徒歩の1区間を問い合わせる。出発・到着は座標またはplace IDを明示する。曖昧さを避けるため、1地点に座標とplace IDを同時に指定しない。未対応の移動方法を徒歩へ読み替えない。
- 取得項目はroutes.duration・routes.distanceMeters・routes.warningsのみ。代替経路は要求せず、車向けの交通条件や到着時刻の指定を徒歩へ流用しない。小数秒は小数文字列を検証して秒へ切り上げ、ナノ秒の端数を浮動小数点で失わないようにする。
- `src/server/google-http.ts` にPlaces・Routes共通の固定URL・項目マスク・5秒タイムアウト・1MiB本文上限・静的エラー変換を集約した。既存Places APIの要求・応答・HTTPエラー形式は維持する。キー・座標・検索語・外部エラー本文は通常ログへ残さず、自動リトライや架空経路へのフォールバックをしない。
- 経路なしは内部のRouteNotFoundError（502、UPSTREAM_UNAVAILABLE、retryable=false）として区別する。所要時間0秒や候補なしの正常応答へ変換しない。不正な所要時間・距離・警告も外部データの取得障害として扱う。
- `src/server/direct-journey.ts` のgetDirectJourneyは、候補検索と同じ出発座標・目的地ID・期限・移動方法を検証し、経路取得後のサーバー時刻を基準に直行の到着見込みを計算する。サーバー時計が逆行しても取得開始時刻より前には戻さない。取得時刻・提供元・距離・注意情報・帰属表示も返す。
- 内部結果のON_TIMEは到着見込みが期限以下、DIRECT_LATEは期限超過。直行見積もりに寄り道用の余裕時間を足さない。通信待ちで期限を過ぎた場合もDIRECT_LATEとし、最初の要求時刻で間に合うように見せない。未来の出発時刻を考慮する公共交通・車等は未対応。
- Googleが指定する徒歩経路のベータ版・歩道情報不足の注意（WALKING_BETA）と、経路固有の注意を保持する。将来の画面・候補APIで表示する際に省略しない。情報源のGoogle Maps帰属表示も保持する。
- ON_TIMEは内部処理の状態であり、候補検索APIのoutcomeの語彙は変更しない。候補選定への組み込みは次節、HTTP提供は2・3節のとおり。共通型・仮データのJSON形式は維持する。

参照（2026年11月8日）：[Compute Routes](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes)、[徒歩等の移動方法と注意表示](https://developers.google.com/maps/documentation/routes/vehicles)。

### 周辺候補の取得・選定（サーバー内部）

#### 目的地内施設・入場条件の修正（2026年11月8日）

- ユーザー確認で、新宿御苑を目的地にした際に園内の旧御凉亭が寄り道として表示された。目的地IDだけの除外と、全候補を入場不要の外観観察とする前提を修正した。以下は初期実装の外観観察の記述に優先する。
- Nearby Searchと目的地・選択地点のPlace DetailsでcontainingPlaces・subDestinationsのIDを取得する。候補が目的地の内部・目的地を含む施設・同じ包含施設内である場合は除外する。取得済みの最大6候補の関係を使って既知の階層も照合する。同じ包含施設にある別店舗も保守的に除外する場合がある。未取得の親施設を無制限に再帰取得しない。
- 関係が欠落していても「目的地の外」「無料で入れる」という証明にはしない。名称の一致や距離、地図の表示範囲を敷地境界として扱わない。Googleの関係情報が全施設を網羅するとも仮定しない。
- 外観観察をpublic-exterior-v2へ更新し、内部accessEvidenceを必要とする。同一候補・同一目的地・同一体験について、目的地の外で入場せず外観を観察できるという条件、出典HTTPS URL、提供元、確認日時・有効期限を保持する。直近15分以内の情報で、予定した訪問全体が有効期間内に収まることを確認する。施設カテゴリ・経路取得成功・営業時間だけから入場不要としない。
- 入場必須・外から利用可能か不明・目的地との関係不明・根拠の期限切れや不一致は除外する。ACCESS_UNVERIFIED等の警告を返し、裏付けがない候補を数合わせで表示しない。根拠がある外観観察だけ待ち・入場をnot_applicableにする。出典はsources、利用条件の注意はwarningsへ反映する。現地確認済みや入場保証とは表示しない。
- accessEvidenceは次節のGemini・Maps出典から取得する。Places単体では取得できず、根拠を与えない内部テストではNO_OPTIONSとなる。生成した文章だけを実測・現地確認済み情報として採用せず、テスト専用の架空根拠をアプリへ読み込まない。
- 再検証でも目的地の関係情報を取り直し、最大でDetails2回＋Routes3回とする。古いexterior-view-v1のトークンはNO_LONGER_FEASIBLEで止める。JSON形式・共通型・デモfixtures・HTTPパスは維持する。

参照（2026年11月8日）：[ContainingPlace・SubDestination](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places)、[Place Details取得項目](https://developers.google.com/maps/documentation/places/web-service/place-details)。

#### Agent Platformによる候補探索（2026年11月8日）

- 公開APIの既定の候補探索はGemini 3.5 Flashへ接続する。2026年11月9日の更新で、プロジェクトとロケーションを含むVertex AIの通常エンドポイントへADCのBearerトークンを渡す。APIキーとGoogle AI StudioのDeveloper APIへ自動切替は行わない。モデルとURLをクライアントから指定させない。モデルの提供期限は採用時に確認した。
- 第1段階はGoogle Mapsツール付きで、出発地点・目的地・到着期限・訪問済みを条件として最大4候補を探索する。外観と予備を最優先に探し、可能なら外観2件と屋内カフェ・軽食・小規模展示の追加案2件を求める。最終的に外観を含め3件以内に絞るのはサーバーで行う。徒歩の経路沿い検索APIを使用する実装ではなく、文脈による提案と取得後の空間・時間検証を組み合わせる。
- 第2段階はツールなしの構造化出力で、取得済みの回答から候補を抽出する。地点IDはMapsのgroundingChunksにあるID、利用条件はgroundingSupportsにある元回答中の文から選ばせる。さらにサーバーで同じ地点の出典にその文が対応することを照合する。モデルが作ったID・URL・根拠の言い換えだけでは採用しない。根拠なしならNO_OPTIONSと警告、不正応答・通信障害は共通エラーとする。
- 受け付ける構造化候補は最大4件。各IDをPlace Detailsで確定し、同時取得は2件まで。詳細取得の`UPSTREAM_UNAVAILABLE`は候補単位で除外し、`exclusions`に`DETAILS_UNAVAILABLE`（段階`discovery`、情報源`Google Places`、判断値`retryable`）を、`warnings`に`AI_CANDIDATE_DETAILS_UNAVAILABLE`を1件返す。取得できた候補は検証を続ける。候補が残らず再試行可能な詳細取得エラーがあれば、そのエラーを返す（再試行不可の失敗との混在時も同様）。全件が再試行不可の詳細取得失敗なら候補なしとして続ける。タイムアウト・利用制限・内部エラー・中断、Geminiの探索自体の失敗は要求全体のエラーのままにする。出発地点から直線距離3kmを超える候補、目的地内・同一施設内や確認できた利用不可条件は既存の検証で除外し、不明な条件は冒頭の方針に従い暫定表示する。3kmは新宿の正式境界や徒歩経路の距離ではない。候補探索後と全経路取得後にサーバー時刻を更新し、新しく取得した根拠を古い直行計算時刻で判定しない。
- Geminiの2段階は合計18秒以内（Maps取得は最大14秒、抽出は最大5秒かつ残り時間以内）。生成上限は取得2,048・抽出4,096トークン、各本文上限1MiB。検索全体25秒と呼出制限は維持する。1検索はGemini最大2呼出＋目的地Details1回＋候補Details最大4回＋Routes最大9回。Mapsツール内部で複数検索が行われる場合があり、アプリ側の呼出数上限は課金の全体上限ではない。自動リトライ・架空候補への代替・結果の永続保存を行わない。
- accessEvidenceの確認時刻は取得後のサーバー時刻、取扱期限は24時間後とする。これはアプリ内部の期限で、施設の利用条件が24時間変わらないという保証ではない。直近15分の鮮度と予定した訪問全体の期限を照合し、選択後には再取得する。体験時間は引き続きカテゴリ別の推定上限を使用し、Geminiの文章内の移動時間等を時間計算へ流用しない。混雑・料金は不明状態を維持し、天候は訪問予報による選定へ反映する。
- 再検証では新しい候補を探させず、選択地点だけの利用条件を同じ2段階で更新する。再検証はGemini最大2呼出＋Details2回＋Routes3回。既知の包含関係はAIの提案より優先し、根拠を更新できなければNO_LONGER_FEASIBLEとする。
- JSON構造は維持する。生成した体験内容とAIの注意表示を返し、sourcesは既存のprovider・urlでMaps出典を保持する。表示ラベルは「Google Maps：取得した出典タイトル」。Maps由来の全出典を同じ生成内容の直後に、タイトル・提供元・元のURLで1操作以内に開ける形で表示する。A側の入力・呼出先は変更不要。出典表示に限り画面を調整した。

参照（2026年11月8日）：[Maps groundingと出典表示](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-maps)、[APIキー方式](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/express-mode/overview)、[モデル提供期限](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)、[構造化出力](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output)。

- `src/server/nearby-candidates.ts` はPlaces API (New)のNearby Searchを1回呼ぶ。対象はpark・tourist_attraction・museum・art_gallery、距離順・最大6件。出発地点を中心に既定1,000m、内部設定で1〜2,000m。検索円は新宿の地域境界を意味せず、地域境界の検証は未実装。
- ID・名称・座標・種別・businessStatus・currentOpeningHours・utcOffsetMinutes・Google Maps URL・帰属表示に項目を限定する。営業時間等の取得はNearby Search Enterpriseの課金区分に該当する。実行には既存のサーバー側GOOGLE_MAPS_API_KEYを使い、自動リトライ・デモへの置換・取得データの永続保存は行わない。
- `opening-hours.ts` はJST（UTC+09:00）の、日付が明記されたcurrentOpeningHours.periodsだけを解釈する。取得日の午前0時から7日間の範囲で照合し、訪問全体が連続した営業区間に収まる必要がある。開店待ちで時間を調整しない。営業時間なし、日付・閉店時刻なし、未対応オフセット、不正値はunknown。openNowや通常の週間営業時間だけから将来の営業を断定しない。明示された空periodsは期間内休業として扱う。
- `duration-evidence.ts` は同一地点・同一体験・適用条件一致・有効期間内の体験時間を、登録値→公式→外部統計→推定の順で選ぶ。同順位なら確認日時の新しいものを使う。未来の確認日・不正な秒数範囲・有効期間外の訪問は採用しない。公式と外部統計には出典URLが必要。取得器や登録台帳は未接続で、型と優先選択の内部処理のみ実装した。
- `candidate-assessment.ts` は15分以内の営業情報、OPERATIONAL、営業時間、体験時間上限、待ち時間、最終入場、経路合計と到着期限を照合する。入場必須の体験は待ち後の開始時刻と最終入場を比較し、最終入場不明なら除外する。待ち込み時間の二重加算を避け、未知の待ちから入場時刻を作らない。
- `detour-search.ts` のfindDetourCandidatesは、直行経路を取得し、直行遅刻または余裕時間すら確保できない場合は周辺検索を省略する。目的地・訪問済み・重複・休業・営業時間不明等を除き、最大4件に対して出発→寄り道→目的地の2区間を取得する。経路の同時通信は最大2、1検索でRoutes最大9回（直行1回を含む）・Nearby1回、全体30秒以内、各通信は既定5秒と残り全体時間の小さい方。終了・失敗・期限超過時に進行中の通信をキャンセルする。
- 全経路取得後の同じサーバー時刻で直行と候補を計算し直し、通信待ちによる期限超過も除外する。経路がない候補は除外するが、Google側の障害・制限は検索エラーとして伝える。成立した候補を時間・天候で評価し、上記の外観必須枠と追加体験の構成で最大3件返す。内部diagnosticsには発見数・経路評価数・除外理由別件数を持ち、座標や生応答を含めない。
- 初期の体験時間はカテゴリ別の暫定目安でmuseum／art_galleryが5〜10分、parkが10〜20分、tourist_attractionが5〜15分。これらは実測・施設公表値ではなく、推定と条件を明示し上限で計算する。有効な同一体験の根拠があれば優先する。外観観察の利用可否は上記のpublic-exterior-v2の条件で別途検証し、時間の目安があるだけでは推薦しない。
- 余裕時間は既定600秒（内部設定0〜3,600秒）。天候の取得は公開候補検索の処理で行う。混雑はunknownと警告を維持する。天候による順位付けは後述の屋外体験向け方針で行う。屋内体験の追加は後続工程。
- 結果は署名前の内部型でoptionId・optionTokenを持たず、そのままフロントへ返さない。2節のHTTP用処理が目的地・署名を付け、公開APIの共通形式へ変換する。共通型・fixturesの形式は変更しない。

参照（2026年11月8日）：[Nearby Searchと課金項目](https://developers.google.com/maps/documentation/places/web-service/nearby-search)、[Placeと現在の営業時間](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places)、[Place types](https://developers.google.com/maps/documentation/places/web-service/place-types)。

## 共通規約

- パスは `/api/v1`。日時はISO 8601、UTCまたは明示オフセット付き。表示はAsia/Tokyo。
- 時間量は秒の整数。内部判定では分へ切り捨てない。画面だけ分へ切り上げる。
- 座標はlatitude／longitude、数値。不明はnullで表現し、0で代用しない。
- requestIdは画面が送る一意な文字列。応答でそのまま返し、古い検索応答を破棄するために使う。
- サーバー時刻を計算基準にする。クライアントの現在時刻は送信必須にしない。
- dataModeはliveまたはdemo。仮データは必ずdemo。デモを実検索の結果として表示しない。

## 1. 場所の確定 GET /api/v1/places?query=...

目的地と位置取得失敗時の出発地点を検索する。入力を絞って送信し、毎キー入力で無制限に呼び出さない。

応答：`{ "requestId": "...", "places": [{ "placeId": "...", "label": "...", "latitude": 35.69, "longitude": 139.70, "address": "...", "typeLabel": "..." }], "attributions": [] }`。住所と施設種別は取得できた場合に返す。

requestIdはクエリパラメータでも送る。候補0件は200と空配列。曖昧な場所はユーザーが一つを選ぶ。

### 場所検索の実装

- Google Places API (New)のText Searchをサーバーから1回呼び出す。ID・表示名・座標・住所（formattedAddress）・施設種別（primaryTypeDisplayName）・帰属表示を取得し、日本語・JPの地域ヒントとpageSize=5を指定する。JPは日本国内や新宿内の厳密な制限ではない。地域境界は未設定のため、範囲外判定はまだ行わない。
- 画面では候補ごとに住所を表示し、同名候補には取得できた施設種別も添える。候補のPlace IDを指定した [Google Mapsの検索リンク](https://developers.google.com/maps/documentation/urls/get-started#search) で位置を確認できる。候補を表示するための追加API呼び出しは不要。
- 秘密設定は.env.local等のGOOGLE_MAPS_API_KEY。キーはGoogleへのヘッダーだけに渡す。クエリ・キー・外部エラー本文をアプリの通常ログや応答へ出さない。自動リトライ・架空データへのフォールバック・検索結果の永続保存はしない。
- 通信全体を5秒で中断し、応答本文を1MiBに制限する。外部の座標や必須項目を検証し、不正なデータを成功・候補0件として扱わない。
- 入力不正400、呼出上限429、キー未設定等500、外部障害502、タイムアウト504を共通エラー形式で返す。重複したquery/requestIdは400。キーや権限等の設定エラーはretryable=falseとし、外部応答の詳細は返さない。
- GETの全応答にCache-Control: private, no-store, max-age=0を付ける。429にはRetry-Afterを付ける。上限は1プロセス当たり60リクエスト/分・同時4通信で、全利用者が同じ枠を共有する。複数インスタンスを合わせた上限やユーザー別制限ではない。
- Next.js開発用アクセスログでは、この検索パスを除外する。公開基盤側のログ除外・マスキングはデプロイ工程で行う。
- attributionsにはGoogle Mapsの表示情報 `{ provider: "Google Maps", providerUri: "https://maps.google.com/" }` と、取得した第三者提供元を重複除去して返す。リンクを取得できない提供元はproviderUri=null。画面側はHTMLとして挿入せず、安全なテキスト・リンクで表示し、Google Mapsと第三者提供元の表示条件に従う。
- [画面開発用の場所検索仮データ](../fixtures/places-success.json)はデモと明記した架空データであり、実API処理には読み込まない。住所・施設種別は既存の候補型を拡張する任意項目。候補検索・行程再検証の形式は維持する。

参照（2026年11月8日）：[Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search)、[PlaceとAttribution](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places)、[帰属表示](https://developers.google.com/maps/documentation/places/web-service/policies)。

## 2. 候補検索 POST /api/v1/recommendations

### 候補検索の実装（2026年11月8日）

サーバー側で目的地をPlace Detailsにより確定し、上記の内部候補選定を呼び、dataMode=liveと共通形式の応答を返す。候補にはHMAC-SHA256の短期トークンとランダムなoptionIdを付ける。OPTION_TOKEN_SECRETは32〜256文字のサーバー秘密設定で、複数インスタンスでは同じ値を使う。未設定なら外部通信前に500とする。トークンは5分間有効で、選択地点・体験、目的地・到着期限・移動方法に結び付ける。出発座標・訪問履歴・キーは含めない。再計算では最新originと訪問済み一覧を受け付け、選択済み地点の再訪を除外する。

POSTの本文はapplication/json、32KiB以内・受信2秒以内。クエリ付きURLや圧縮本文は受け付けない。入力検証後、候補検索と再検証で共有する1プロセス2,000件/分・同時2処理の枠を確保する。429にはRetry-Afterを付ける。上限は複数インスタンス合計やユーザー単位ではない。全応答をno-storeとし、通常ログに本文・トークン・座標を出さない。開発用アクセスログから両POSTパスも除外する。

外部処理の既定は上記のGemini探索＋Places＋Routes＋Weather最大4回（再検証は最大1回）で、全体25秒以内（本文受信時間は別）。Places・Routesの各通信は最大5秒と残り時間の小さい方、Geminiは上記の配分とする。目的地の確定中に期限を過ぎても、受付時点で正しかった入力を過去日時エラーへ変えず、更新時刻による直行遅刻として扱う。Gemini・経路・場所の外部障害を候補0件の成功に変換しない。両POST APIを実装済みで、capabilitiesは秘密設定に応じて対応状況を返す。

### 訪問時間帯の天候予報と候補選定

- 時間・営業・入場条件を満たす最大4候補の場所と体験開始時刻で時間別予報を取得し、最終3件に絞る前に比較する。現在時刻の時間帯から最大24枠・1ページを取得し、体験開始時刻が属する1時間の予報を使う。訪問中にまたぐ複数時間帯全体の評価や、現在の観測値取得は未対応。
- 雨・雪・強風の対応コード、または降水確率50%以上では、対応する降水等のない時間帯を優先する。影響がある候補同士では根拠のある屋内体験を優先し、その中で徒歩2区間と屋外になり得る待ち時間が短い順にする。屋外体験は体験時間も含めて比較する。晴天時や同点では元の時間順位を維持する。50%はアプリの比較方針で、気象警報の基準ではない。
- 対応する雷雨・大雨・大雪・雹等のコードでは、徒歩移動を含む屋内案も除外し、WEATHER_UNSUITABLEを付ける。全候補が対象ならNO_OPTIONS。直行経路の安全を保証せず、架空の屋内候補へ置換しない。Googleが追加した未知の天候コードを表示文から推測せず、降水確率等でも判定できなければ比較不明とする。
- 予報は最大4回・同時2通信・合計1.5秒以内で取得し、全体の残り時間から応答用500msを確保する。残り時間不足なら省略。予報待ち後の新しいサーバー時刻で直行・候補の期限、営業、根拠期限を再評価し、体験開始が別の時間枠へ移った場合は古い予報を採用しない。外部API全体25秒の上限は維持する。
- 各候補の比較に必要な予報が揃わない場合は、確認できた雷雨等による除外を除き、天候による順位変更を止めて分類内の元の時間順位を維持する。外観必須枠と追加体験の構成は適用する。不明を晴れとして優遇しない。WEATHER_COMPARISON_UNKNOWN・WEATHER_UNKNOWN／UNAVAILABLEを付け、天候取得失敗だけで検索全体を止めない。
- 並び替え後の最上位候補の予報をcontext.weatherに設定する。対応する日本向け予報がavailable、範囲外等はunknown、取得障害・タイムアウトはunavailable。validAtは予報枠の開始、retrievedAtは受信時刻。選定理由には対象候補の予報と方針を表示し、Google・日本の提供元の帰属表示を保持する。公開JSON形式・共通型は変更しない。
- 選択後の再検証もその地点の予報を最大1回取得し、待ち時間を含めて期限・署名期限・時間枠を再確認する。雷雨等ならNO_LONGER_FEASIBLEとなり、別の地点へ自動変更しない。予報取得失敗だけなら警告付きで既存の条件判定を続ける。

参照 [天候コード](https://developers.google.com/maps/documentation/weather/reference/rest/v1/WeatherCondition) · [時間別予報の仕様](https://developers.google.com/maps/documentation/weather/reference/rest/v1/forecast.hours/lookup) · [Weather APIの帰属表示](https://developers.google.com/maps/documentation/weather/policies)

要求例：

```json
{
    "requestId": "search-001",
    "origin": { "latitude": 35.69, "longitude": 139.7 },
    "destination": { "placeId": "selected-place-id" },
    "arriveBy": "2026-11-07T15:30:00+09:00",
    "travelMode": "WALK",
    "excludedPlaceIds": []
}
```

travelModeの語彙はWALK／TRANSIT／DRIVE／BICYCLE。実際に許可する値はGET /api/v1/capabilitiesで返す。徒歩のみならそれ以外はUNSUPPORTED_MODE。緯度経度の範囲、日時、place IDをサーバーで検証する。excludedPlaceIdsは訪問済み地点で、初回は空配列。

### 成功応答

具体例は[画面開発用の架空データ](../fixtures/search-success.json)。必須の最上位項目：

| 項目                   | 意味                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| requestId、dataMode    | 要求の照合、実データかデモか                                                          |
| calculatedAt、arriveBy | 計算基準と到着期限                                                                    |
| outcome                | OPTIONS／NO_OPTIONS／DIRECT_LATE                                                      |
| destination            | 確定した目的地の場所情報                                                              |
| direct                 | durationSecondsとarrivalAt。経路自体が取れなければ成功にせず外部障害とする            |
| context                | weatherとcrowdの取得状態・概要                                                        |
| options                | 0〜3件の候補                                                                          |
| warnings               | コードと説明の配列                                                                    |
| attributions           | 外部APIが要求する帰属表示。文字列または提供元の規定に従う構造化データ。安全に描画する |

候補の構造は仮データと一致させる。timeの各区間、待ち、体験は二重計上しないよう正規化済み。experienceDurationに元の体験時間範囲と根拠を保持する。元データが待ち込みなら、time.experienceSecondsは待ちを含む合計とし、time.waitSecondsは加算対象の残りだけ（追加なしなら0）、waitTreatmentをincludedにする。実待ち0分と混同しない。

waitTreatmentはseparate／included／not_applicable／unknown。unknownではwaitSecondsをnullとし、requiredSecondsは既知部分のみの暫定値、isProvisional=trueにする。待ちが不可避で不明かつ推定幅もない候補は返さない。対象の飲食・館内体験は推定待ちの上限を使ってseparateまたはincludedとし、ESTIMATED_WAIT・isProvisional=trueを返す。その他の未知待ちリスクはwarningsで明示する。

`requiredSeconds = legToStopSeconds + waitSeconds（unknownは既知部分に含めない）+ experienceSeconds + legToDestinationSeconds + bufferSeconds`。

`slackSeconds = arriveBy − arrivalAt`で、bufferSecondsとは区別する。slackSecondsがbufferSeconds以上の案のみ返す。営業条件は体験開始と終了で検証する。次の区間の出発時刻を考慮できる移動手段では、寄り道後の出発時刻で経路を取得する。

experienceDuration.sourceTypeはregistered／official／external_statistics／estimate。sourceUrlは推定や自前実測でnullも許す。確認日時、待ち込みか、適用条件も保持する。有効な登録値を優先する。最終的なresponseは外部サービスの生データをそのまま返さず、この形式へ整える。

weather.statusはavailable／unknown／unavailable。crowd.statusはobserved／historical／estimated／unknown／unavailable。各情報はprovider、retrievedAt、対象のvalidAt、summary、sourceUrl（なければnull）を持つ。施設別混雑は候補内に保持する。AIの推測でobservedにしない。

## 3. 候補選択・再検証 POST /api/v1/itineraries/validate

### 再検証の実装（2026年11月8日）

- 入力検証後、トークンの署名・選択地点・体験・目的地・期限・移動方法の一致を照合する。改ざん・条件不一致は400、認証済みで有効期限切れなら200＋EXPIRED。どちらもGoogleを呼ばない。通常の要求検証で過去のarriveByは従来どおり400とする。
- 最新originから再計算できるよう、出発座標とexcludedPlaceIdsは署名条件に固定しない。選択地点が訪問済みまたは目的地と同じならNO_LONGER_FEASIBLEを返す。新しい候補への自動置換はしない。
- 選択地点と目的地をPlace Detailsで各1回取り直す。Nearbyの順位変動で選択地点を見失う処理にはしない。包含関係・利用条件・OPERATIONAL・営業時間を確認できた場合、直行・出発→選択地点・選択地点→目的地の最大3経路を取得し、最後の同一サーバー時刻で再判定する。全体25秒・各通信最大5秒、候補検索と同じプロセス内呼出枠を共有する。
- 処理中のトークン期限切れもEXPIRED。休業・時間不足・選択地点への経路なし等はNO_LONGER_FEASIBLE、外部障害は共通エラー。VALIDでは更新した時間・営業情報と、新たな5分間のトークンを返す。
- Place Detailsは目的地のID・名称・座標・帰属に項目を絞り、選択地点には種別・営業状態・日付付き現在営業時間・UTCオフセット・Google Maps URLも追加する。IDから固定GoogleホストへGETし、任意URLやリソースパスを受け付けない。目的地はPro、営業時間付きはEnterpriseの課金項目を含む。キーはヘッダーのみ。生応答は保存しない。

参照（2026年11月8日）：[Place Details (New)](https://developers.google.com/maps/documentation/places/web-service/place-details)。

候補表示後にも時間が経つため、画面上の候補をそのまま確定しない。

要求はrecommendationsと同じ条件にselectedPlaceId・experienceId・optionTokenを追加する。optionTokenは候補応答の改ざん防止用の短期署名トークン等で実装し、秘密情報・履歴を含めず、サーバーが有効期限を検証する。仮データのトークンは実環境で受理しない。訪問済み・到着済みなら最新originから残り行程を再計算し、体験を終えた場合は直行する。

応答：`{ "requestId": "...", "status": "VALID", "calculatedAt": "...", "option": { "候補検索と同じ構造": "..." }, "warnings": [], "attributions": [] }`。

statusはVALID／NO_LONGER_FEASIBLE／EXPIRED。後2者はoption=nullとし、再検索または直行を促す。VALIDでは最新の時間・営業条件を反映する。新しい候補を勝手に選ばない。外部取得失敗はエラー応答とする。

## 4. 対応状況 GET /api/v1/capabilities

応答例：`{ "apiVersion": "v1", "supportedTravelModes": ["WALK"], "areaLabel": "新宿", "areaBoundaryConfigured": false, "dataMode": "live" }`。

新宿の厳密な範囲はまだ未確定。Bが境界設定を実装して2人で確認し、公開時はareaBoundaryConfigured=trueにする。未設定のまま架空の範囲外判定をしない。

## エラー応答と状態

形式：`{ "requestId": "...", "error": { "code": "INVALID_INPUT", "message": "到着日時を確認してください", "field": "arriveBy", "retryable": false } }`。fieldは該当なしならnull。

| HTTP | code                          | 画面の動作                 |
| ---- | ----------------------------- | -------------------------- |
| 400  | INVALID_INPUT                 | 入力箇所を訂正             |
| 422  | UNSUPPORTED_MODE／OUT_OF_AREA | 対応範囲を表示             |
| 429  | RATE_LIMITED                  | 時間を置いて再試行         |
| 502  | UPSTREAM_UNAVAILABLE          | 外部取得の失敗として再試行 |
| 504  | TIMEOUT                       | 再試行。古い応答は破棄     |

NO_OPTIONSとDIRECT_LATEは通信エラーではなく200。混雑・天候だけの欠損は200＋warnings＋不明状態。サーバー内部エラーは500＋INTERNAL_ERRORとし、キー・外部生応答・位置履歴をエラー本文へ出さない。

## 画面からGoogleマップへのルート引き渡し

行程画面にGoogle Maps URLsのDirectionsリンクを追加した。公開APIの入力・JSON形式・fixtures・秘密設定は変更しない。サーバーの新しいエンドポイントやGoogle APIキーの追加は不要で、クリック時にGoogleマップのアプリまたはブラウザで徒歩経路を開く。

- 固定の `https://www.google.com/maps/dir/` にapi=1・travelmode=walkingを設定。目的地はdestination・destination_place_id、寄り道ありならwaypoints・waypoint_place_idsも設定する。3件の候補全部ではなく、選択した1件だけを経由する。
- GPS出発地点は表示中の最新座標、手動指定や訪問完了後はorigin_place_idと地点名も使う。目的地・経由地は施設名とPlace IDを基本にし、名前の区切り文字やURL長の制約がある場合は座標とIDを使う。URLSearchParamsで符号化し、2048文字以内に制限する。
- リンクは表示中のTripPlanのorigin・option・destinationから毎回生成し、再計算前の位置や完了した寄り道を残さない。地点が不正・未設定ならリンクを出さず再計算を案内する。
- 通常のa要素でクリック時だけ開き、target=_blank・rel=noopener noreferrerとする。出発地点等をGoogleマップへ渡すことと、経路・時間が再計算されることを画面で説明する。キー・候補トークン・履歴・到着期限・滞在時間はURLへ含めない。端末の位置許可を代行したり、ナビの開始操作を自動実行したりしない。

参照：[Google Maps URLsの公式仕様](https://developers.google.com/maps/documentation/urls/get-started)。アプリ起動・経由地への対応は端末とGoogleマップ側の対応に依存する。スマートフォン実機でのアプリ起動は別の確認が必要。

## 接続時の共同確認

Aは仮応答で画面、Bは同じ形式で実応答を作る。通常成功、候補なし、直行でも遅刻、天候・混雑不明、体験時間推定、未対応方法、選択時に時間不足を確認する。仮データは検索実績や登録済み観光データとは別物。API形式変更は仕様とfixturesを同じ変更で更新する。
