# チーム連携：現行APIと統合確認手順

公開版では実際の接続先と利用者・申請の識別情報を例示値に置き換えています。

この文書を旧ドラフトより優先してください。NFC申請作成のBody・認証・冪等性と貸出状態遷移は維持しています。

正式承認後の解錠は[学生証タッチ解錠](card-touch-unlock.md)へ変更済みです。
正式承認時はcommandを作らず、許可されたロックリーダーからのカードタッチ後に作ります。

LINE専用HTTPS入口と安全な資格情報共有、署名付きlist_bikesによる登録車取得、成功JSON・本人取消の全例は[正式承認の接続準備](line-approval-connection.md)を参照してください。

## 起動とネットワーク

```bash
npm install
npm run db:migrate
# .envは自動読込しない。隔離LANでダミー設定を使う場合：
set -a
source .env.example
set +a
npm start
```

全インターフェースの3000で待受します。原則HTTPS。
HTTPS終端proxyを使う場合、TRUST_PROXYは信頼したproxyだけに限定します。
本番はNODE_ENV=productionを設定。HTTP許可は隔離テストLAN・ダミー資格情報だけに限定します。
LINE_SERVICE_TOKENは32文字以上。未設定は503 LINE_NOT_CONFIGURED、不正値は401 SERVICE_AUTH_FAILED。
LINE_CHANNEL_SECRETは本番では公式LINE Channel Secretと一致させます。秘密値はログに出しません。
LINE専用のHTTPS入口を用意しています。最新の設定方法は[正式承認接続](line-approval-connection.md)を参照し、一時URLは試験前に稼働を確認してください。

Mac自身のLAN IPへのcurl成功は、別端末からの到達性を保証しません。
両端末のSSID/IP/ネットマスクを合わせ、NFC担当側で実行してください。

```bash
curl --connect-timeout 5 http://<BackendのLAN-IP>:3000/api/health
```

No route to hostでは学内VLAN・経路・端末間隔離・送信元firewallを調査します。
同一SSIDでも端末間通信が許可されるとは限りません。許可された検証LANを使用します。

## 実装済みAPI

| Method / URL | 認証 | 用途 |
| --- | --- | --- |
| GET /api/health | 不要 | DB/serial接続状態、個人情報なし |
| POST /api/requests | NFC端末キー | 既存仕様の申請作成 |
| GET /api/requests/:id | NFC端末キー | 作成元端末による最新状態取得 |
| POST /api/requests/:id/cancel | NFC端末キー＋有効カード | 借り手本人、requestingのみ取消 |
| POST /api/lock-reader/taps | 個別端末キー＋bike対応＋有効カード | 承認済み借り手のタッチによる解錠要求 |
| GET /api/line/requests | Bearer | 募集中一覧 |
| GET /api/line/events?after=0 | Bearer | event_id昇順の差分、最大100件 |
| POST /webhooks/line | Bearer＋公式署名 | LINE担当が公式rawイベントを転送 |
| POST /api/requests/:id/approve | 同上 | 単一approveイベント専用の入口 |

既存/api/bikes/03/*と旧Webは既定404です。非本番でENABLE_VIRTUAL_BIKE=trueの場合だけ使えるメモリ内デモで、SQLite承認やUSBに接続しません。

設定の明示読込、バックアップ、状態確認CLIは[Backend運用](backend-operations.md)を参照してください。

### NFCの状態取得・取消

X-Device-IdとX-Device-Keyを送信します。取消Body：

```json
{"card_uid":"0123456789ABCDEF","event_id":"cancel-550e8400-e29b-41d4-a716-446655440000"}
```

カードから借り手を照合。他人の申請は404、approved以降は409 INVALID_STATE。
成功200はrequest_id/status/updated_atを返します。
同一端末・同一event_id・同内容の再送は初回成功JSONを再現し、異なる内容は409 IDEMPOTENCY_CONFLICT。
取消後の新規申請は新client_request_idを使います。旧IDで申請POSTを再送すると、
既存契約どおり最初のrequesting応答を返します。最新状態はGETで確認します。
DB全消去や承認後の強制取消は行いません。

### LINE募集表示：ポーリング

ヘッダー：Authorization: Bearer <LINE_SERVICE_TOKEN>。
最初にGET /api/line/requests、その後GET /api/line/events?after=<保存cursor>を取得します。
グループへの送信はLINE担当の実装範囲です。追加したHTTP pushは以下を参照してください。

### LINE側受信APIへのHTTP push（結合テスト）

BACKEND_EVENTS_URLとBACKEND_EVENTS_TOKENを設定すると、1秒間隔の送信workerを有効にします。
送信先はHTTPS限定、Content-Type:application/json、Authorization:Bearer <専用token>。
このtokenはLINE_SERVICE_TOKENやNFC端末キーとは別です。実値はチャットやGitに置かず、安全に共有して.envへ保存します。
.envは自動読込しないため、保存後に`set -a; source .env; set +a`で読込んで起動してください。

push本文はLINE側の確定サンプルに合わせた次の形式です。ポーリング用の時刻・bike_id等は含めません。

```json
{"event_id":"42","event_type":"request.created","request":{"request_id":"req_...","borrower_display_name":"テスト借り手","status":"requesting"}}
```

events配列では包みません。migration005で新規イベント用triggerを更新し、保存済みの過去本文は変更しません。
申請作成と同一トランザクションでline_outboxへevent_idと本文を固定します。
既存NFC申請の再送はoutboxを増やしません。過去申請の自動バックフィルも行いません。
初回202または再送200でdelivered、接続エラー/429/5xxは最大5回、同じ本文で指数的に再試行します。
401/400等はfailedで停止し、設定確認後にevent_id指定で手動再送します。
未送信のうちに募集が終了した申請はskipします。送信済みイベントの明示再送は同じ本文で可能です。
送信中のleaseは30秒、HTTP timeoutは5秒。再起動後もDBに保存した送信状況を使います。
送信先変更後は環境設定を更新し再起動します。redirectには追従せずtokenの別ホスト流出を防ぎます。
送信失敗で貸出状態は巻き戻しません。

```bash
# サーバー起動時の自動workerを使わず、結合テストで1件だけ送信することも可能。
# URL/tokenを安全に環境設定したうえで実行する。
npm run events:send
# 初回202のevent_idを指定して再送。同じID・同じ本文で200を確認。
npm run events:send -- <event_id>
```

LINE側の期待する正確なJSONサンプルを接続前に照合します。Backendが202を受け取っても、
LINEグループ表示の成功はLINE担当が実画面で確認する必要があります。
pushとポーリングを同時運用するときは同じevent_idで必ず重複排除してください。

一覧の200例：

```json
{"requests":[{"request_id":"req_...","borrower_display_name":"テスト借り手","status":"requesting","bike_id":null,"created_at":"2026-11-04T01:00:00.000Z","updated_at":"2026-11-04T01:00:00.000Z"}]}
```

差分の200例：

```json
{"events":[{"event_id":"42","event_type":"request.created","occurred_at":"2026-11-04T01:00:00.000Z","request":{"request_id":"req_...","borrower_display_name":"テスト借り手","status":"requesting","bike_id":null,"created_at":"2026-11-04T01:00:00.000Z","updated_at":"2026-11-04T01:00:00.000Z"}}],"next_cursor":"42"}
```

グループ送信成功後にcursorを永続化し、event_idとrequest_idで二重表示を防いでください。
イベントは削除せず再取得できます。requestは取得時点の最新状態です。
遅れて取得したrequest.createdでも既にcancelledの場合があります。最新状態を優先し、新規募集を出さないでください。
対象イベントはrequest.created/cancelled/approved/rented/returned、command.failed/timed_outです。

### LINE承認・取消・返却

LINE担当が公式Webhookを受け、raw bodyを変更せず、公式X-Line-Signatureと専用Bearerを付けてBackendへ転送します。
Backendでもraw bodyのHMAC-SHA256署名を検証し、source.userIdをDBの利用者へ照合します。
任意のuserId/student_idをBodyへ指定するだけの承認はできません。
Channel Secretの共有、公式アカウント設定、LINE初回本人確認は担当間の設定・合意が必要です。
この入口はBearerも要求するためLINE Platformから直接は呼べません。

POST /webhooks/lineのBody例：

```json
{"events":[{"type":"postback","webhookEventId":"01-EVENT-ID","source":{"userId":"U_LINKED_USER"},"postback":{"data":"{\"action\":\"approve\",\"request_id\":\"req_...\",\"bike_id\":\"B003\"}"}}]}
```

POST /api/requests/:id/approveも同じ署名付きraw envelopeを受けます。
その入口はeventsが1件、actionがapprove、request_idがパスと一致することが必要です。
旧ドラフトの簡略Body {event_id,bike_id} は、認証済みLINEコンテキストを持たないため直接受け付けません。
bike_idは既存契約どおりLINE側から送り、Backendが所有者とavailableを検証します。
貸し手1人につき自転車最大1台をUNIQUEで保証します。既存DBに複数台がある場合は移行が停止し、削除しません。

200成功例：

```json
{"results":[{"request":{"request_id":"req_...","borrower_display_name":"テスト借り手","status":"approved","bike_id":"B003","created_at":"...","updated_at":"..."},"lock_command":null,"next_action":"tap_card"}]}
```

401 INVALID_LINE_SIGNATURE、403 LINE_ACCOUNT_NOT_LINKED/BIKE_NOT_OWNED/SELF_APPROVAL、
404 REQUEST_NOT_FOUND/BIKE_NOT_FOUND、409 BIKE_NOT_AVAILABLE/INVALID_STATE。
承認済み・取消済み・競合の状態エラーは共通409です。

```json
{"success":false,"error":"INVALID_STATE","message":"募集中の申請だけ承認できます"}
```

成功済みのwebhookEventId再送は初回JSONを200で返します。同じIDで内容変更は409 IDEMPOTENCY_CONFLICT。
失敗した処理は成功receiptを残しません。SQLite IMMEDIATEで承認・取消を直列化し、先に成立した遷移を採用します。
承認・bike確保・ログ・receiptは同一トランザクション。この時点ではcommandを作りません。
カードタッチ認可・解錠権限記録・command作成は別の同一トランザクション。unlock commandは1申請1件です。
batchはイベント単位で確定し、途中の失敗時は全体がエラーになります。成功分は再送時にreceiptを再現します。
連携初期は1イベントずつ転送してください。

借り手のpostbackはaction:cancelで取消、action:lockで返却時の施錠要求（request_id必須）。
lockは借り手本人・rentedのみ許可し、lock_successでreturnedにします。
物理的な手動再施錠センサーの自発通知は未実装です。command_idとの対応をハード担当と合意する必要があります。

## USB / ESP-NOW

SERIAL_MODE=usb、SERIAL_PORT=/dev/cu...、SERIAL_BAUD_RATE=115200、SERIAL_RELAY_IDを環境設定で指定します。
既定off。送信にはbikes.device_id/relay_idにハード担当と合意した許可機器IDの登録が必要です。
未登録のbikeへは送信しません。管理APIは未実装です。
USBは物理的に信頼した中継器を接続する前提で、ID照合そのものは暗号学的な認証ではありません。
ESP-NOW peer鍵・暗号化・永続command重複排除・sequence/replay対策はハード担当の実装と合意が必要です。
BackendはUSB JSONを扱い、中継器がバイナリESP-NOWへ変換します。
バイナリ長・endian・version・結果コードは既存integration-spec.mdのドラフトを共有します。

JSON Lines、UTF-8、末尾LF、受信上限1024 bytes/行。CRLF・部分受信対応。

```json
{"v":1,"message_type":"command","command_id":"cmd_...","request_id":"req_...","bike_id":"B003","device_id":"BIKE03","relay_id":"RELAY01","action":"unlock","attempt":1}
```

ACKは同じID群とmessage_type:ack、実行結果はmessage_type:resultとresultを返します。

```json
{"v":1,"message_type":"result","command_id":"cmd_...","request_id":"req_...","bike_id":"B003","device_id":"BIKE03","relay_id":"RELAY01","result":"unlock_success"}
```

resultはunlock_success/unlock_failed/lock_success/lock_failed。ACKだけではrentedになりません。
不正JSON・巨大行・ID不一致は破棄し継続。受信raw値や秘密はログへ出しません。
10秒で未完了なら同じcommand_idで再送、最大3回でtimed_out。切断後は2秒ごとに再接続。
再起動後もDBの同じcommandを継続します。timed_out後の正規な遅延結果も受理します。
成功・失敗の終端結果が確定した後の重複結果は無視します。
機器側は同command_idでサーボを再実行せず保存済み結果を返す必要があります。
failed/timed_outを新IDで自動再発行しません。解錠失敗・通信失敗時はapprovedを維持します。

## 動作確認とMock

```bash
npm test
npm run mock:serial
# 起動中サーバーに一覧問い合わせ（上の環境設定を読込済み）
npm run mock:line
```

mock:serialは独立メモリDBでrequesting→approved→rented→returnedを一巡し、実DBを変更しません。
SERIAL_MODE=mockの常駐adapterは自動成功しません。自動成功デモはmock:serialのみです。
Mock LINE承認はLINE_MOCK_REQUEST_ID、LINE_MOCK_USER_ID（既存紐付け必須）、LINE_MOCK_EVENT_ID、
LINE_MOCK_BIKE_IDを設定してnpm run mock:line。LINE_MOCK_ACTION=cancel/lockも可能。
再送時は同じLINE_MOCK_EVENT_IDを使います。Mock署名はダミーChannel Secretに限定します。

NFC Mockは既存の申請に加え、NFC_OPERATION=status/cancelとNFC_REQUEST_IDで状態取得・取消ができます。
取消ではNFC_MOCK_CARD_UIDを借り手の有効カードに設定し、再試行時は同じNFC_EVENT_IDを使ってください。

統合確認の順序：

1. 両端末を検証LANへ接続し、別端末からGET /api/healthで200。
2. 実カード申請で201、同じUUID再送で200と同じrequest_id。
3. GET状態確認、カード付きcancelでcancelled、新UUIDで再申請。
4. LINE側で一覧/eventsを取得しグループ表示、送信成功後cursor保存。
5. ダミーLINE紐付けで署名付き承認、approvedとcommand1件、再送でも同じcommand。
6. mock:serialでACK/結果/返却を確認。
7. 許可機器ID・暗号鍵・結果形式を合意後、USB実機で同じ流れを確認。

Core2実機の新規201→同一UUID・同一本文で200はNFC担当から成功報告済みです。
対象request_idはreq_00000000-0000-4000-8000-000000000001、Backend上の通知event_idは10です。
その後、LINE受信準備完了連絡を受けてevent_id 10を初回送信し、202・duplicate:falseを確認しました。
グループ表示を確認後、同じID・本文を再送して200・duplicate:trueを確認しました。
再送後も今回の募集が1件のままであることをユーザー経由で確認済みです。
本人連携・登録車取得の未実装状況と承認・取消の実装済みI/Fは[LINE担当向け共有資料](line-handoff.md)を参照してください。
LINEグループへの募集表示、同じevent_id・本文の再送200、重複表示なしは[結合試験記録](line-integration-test.md)のとおり確認済みです。
正式承認の実LINE接続、Backendの公開HTTPS、USB/ESP-NOW実機は未検証です。
