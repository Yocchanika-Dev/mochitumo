# 全体コードレビュー・動作互換リファクタリング

## 対象と制約

サーバー、HTTP認証・入力検証、貸出サービス、SQLite・migration・seed、LINE通知、USB/Mock、
仮想Atom、CLI、Web画面、テスト、関連仕様書を確認しました。
APIのパス・HTTPステータス・JSON・NFC冪等性・状態遷移を維持し、新しい業務機能は追加していません。
実DBのmigrationやseed、カード・申請の変更、外部通知、稼働中サーバーの再起動は行っていません。

## 整理した構成

| 場所 | 責務 |
| --- | --- |
| server.js | Expressの組立・起動・終了 |
| src/runtime.js | 起動時のUSB・通知環境設定 |
| src/http/nfc-routes.js | NFC作成・状態取得・取消のHTTP入口 |
| src/http/integration-routes.js | health・LINE一覧/差分・署名付き入口の登録 |
| src/http/virtual-bike-routes.js | 従来の仮想Bike03の互換API |
| src/http/middleware.js / validation.js / errors.js | HTTPS・サービス認証・共通検証・エラー変換 |
| src/line/webhook.js | raw署名検証、LINEイベント解釈、貸出サービスへの委譲 |
| src/rental/service.js | トランザクション・認可・貸出状態遷移 |
| src/rental/queries.js | 申請照会・公開JSON・一覧/差分取得 |
| src/rental/commands.js | 永続ロック命令作成の共通処理 |
| src/db/events.js | イベントログ記録の共通処理 |
| src/security/constant-time.js | 秘密値の定数時間比較 |
| src/line/event-sender.js | outbox取得・HTTP送信・送信結果反映 |
| src/serial/ | USB接続管理・JSON Lines・命令結果反映 |

イベント一覧はJOINで最新requestを一括取得し、従来のイベントごとの再SELECTを廃止しました。
イベント発生時刻とrequest作成/更新時刻は別名で取得し、公開JSONの意味を維持します。
定数時間比較は共有しますが、NFCのscrypt照合とLINEのHMAC検証という認証方式自体は変更していません。
処理順はHTTPS→認証→JSON解析です。LINEのraw bodyは共通JSON parserより先に検証します。

## 第1回レビューで修正した不具合

### P2：outboxの期限切れleaseと遅延完了

旧workerの送信が遅れて完了すると、後続workerが保存した成功をpending等で上書きできました。
取得時のattemptsを世代としてUPDATE条件へ含め、所有している世代の結果だけを保存します。
また、異常終了で残ったsendingが自動送信上限を超えて復旧されるケースを防ぎました。
同じevent_id・本文の維持、200/202成功、明示的な手動再送は変えていません。

### P2：USB接続中の停止と遅延open

停止後にopen callbackが到着すると接続状態が復活し、停止済みDBへの操作や不要な接続を起こす余地がありました。
現在のportと停止状態を照合し、遅れて開いた旧portは閉じます。
startの重複を抑止し、bridge停止時はtimerとadapter listenerを解放します。

### P2：初期化失敗・環境設定とテストの分離

以前はcreateApp()がプロセス環境の通知資格情報を自動読込してworkerを起動していました。
本番用設定を持つシェルでテストすると、メモリDBのテストイベントを実送信する可能性がありました。
通知設定の読込をnpm startの入口に集約し、createAppは明示的なeventDeliveryオプションのみを使用します。
運用時の環境変数名と起動方法は変えていません。
アプリ初期化・listen・migration・seedの失敗時にも、開いた資源を閉じるよう整理しました。

### P3：仮想AtomのHTTPポーリング重複

遅いHTTP応答中に次のintervalが開始して並行pollする状態を抑止しました。
コマンドの実行済みID管理と再完了通知の振る舞いは維持しています。

## 第1回の検証

- 変更前：49テスト成功
- 変更後：既存49件＋回帰7件＝56テスト成功
- 変更前スナップショットと新コードを別メモリDBで起動し、17シナリオのHTTPステータスとJSONを比較。一意IDと時刻を正規化すると一致
- フォーマット確認、JS構文確認、Mock Serialの貸出・返却デモを実施
- 実カード・実DBを用いた追加申請や実LINE送信は実施していない

## 第2回レビュー：結合試験後の全体再確認

### 整理内容

- NFC申請・取消で共通するカードと利用者のJOINを`findCardWithUser`に集約。申請では未登録404、取消では403を返す既存のエラー契約を維持。
- 通知の環境設定読み込みを`getEventDeliveryOptions`へ集約し、常駐起動と手動送信CLIで共有。秘密の実値や.envの読み込み方は変更していない。
- 開発用端末ID・ダミーキー・カードUIDを`development-defaults.js`に集約。seedの既存exportも互換用に維持。
- NFC Mockのrequest/status/cancelのBody組立をネストした三項演算子から通常の分岐へ整理。送信内容とCLIの出力は維持。
- シリアル成功時の状態・時刻カラム・自転車状態の対応を`SUCCESS_TRANSITIONS`へ集約。unlockとlockの状態遷移自体は維持。
- READMEと連携仕様の古い「未検証」を、Core2の200/409到達・LINE募集表示と再送成功に合わせて修正。Core2の201→200成功とは区別。

### P2：複数プロセスの起動時migration競合

適用済み一覧を読み取った後に別プロセスが移行を完了すると、同じDDLや適用済み記録を二重実行する余地があった。
各migrationをIMMEDIATEで実行し、書き込みロック取得後にも適用済みか再確認する。
競合順序を再現する回帰テストで、既に適用されたmigrationを再実行しないことを確認済み。
過去SQLファイルやDBスキーマ、登録データは変更していない。

### P2：シリアル定期処理の例外でサーバーが停止する余地

intervalおよびopenイベントから直接tickを呼んでいたため、一時的なDBエラーがイベントループまで伝播する可能性があった。
定期実行入口でだけ例外を捕捉し、秘密やDB詳細を出さず次の周期を継続する。
直接呼び出すtickの例外動作、DBトランザクション、ACK/結果/タイムアウト契約は維持。

### 第2回の検証範囲

変更前の56件に加え、migration競合・カードエラー互換・定期処理の回復を確認する回帰3件を追加。
合計59件すべて成功。変更前後のHTTP比較17ケースも、一意ID・時刻を正規化して一致した。
NFC Mockのrequest/status/cancelはfetchを差し替え、送信先・メソッド・Bodyが変更前と一致することを確認した。
38個のJSファイルの構文、Prettier整形確認、Mock Serialの承認→貸出→返却デモを確認済み。npm auditは脆弱性報告0件。
実LINEへの追加送信、event_id 8の本文変更、実DBの操作、稼働サーバーの停止・再起動は行っていない。

## 動作維持のために未変更とした設計課題

- **対応済：旧仮想デモAPIの隔離。** 通常は画面・APIとも404。非本番のENABLE_VIRTUAL_BIKE=trueだけで有効化します。LINE専用gatewayには引き続き登録しません。
- **P2：受信LINE batchはイベント単位で確定。** 後半で業務エラーが出るとHTTP全体はエラーになりますが前半の成功は残ります。既存仕様どおり再送receiptで保護します。イベント別応答への変更はLINE担当との合意が必要です。
- **P2：通知pushはrequest.createdのみ。** 取消・承認後の表示更新には既存ポーリングを併用するか、状態変化pushの契約追加が必要です。受信側との合意なしにイベント種別を増やしていません。
- **P2：通知event_idはDB内の連番。** 同一DB内では一意ですが、別環境やDB作り直し後に同じLINE受信先へ接続すると衝突する可能性があります。本番相当環境を分けるか、source ID/UUID化を別途合意します。
- **運用：seedはデモ情報を更新する。** デモ端末キー・デモ利用者・カード対応を更新する既存動作は維持しています。実データへ不用意に実行しないでください。
- **実機境界：** UIDの真正性、LINE初回本人確認、ESP-NOW鍵と永続重複排除、手動再施錠の自発通知は従来どおり他担当との合意・実装が必要です。

これらは整形や共通化だけでは解決できないため、API契約や運用を変更する別タスクとして扱います。
