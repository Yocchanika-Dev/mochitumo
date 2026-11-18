# 正式承認と学生証タッチ解錠：現行仕様

正式承認＝貸し手・借り手・自転車の確定、現地の学生証タッチ＝解錠要求です。
この文書を、旧資料の「承認時にunlock命令を作成する」記述より優先してください。
今回の変更で本人連携・登録自転車一覧APIを追加したわけではありません。

## 流れとLINE担当への変更連絡

1. LINE正式承認：requesting→approved、bike available→reserved。ロック命令はまだ作りません。
2. 借り手が対象自転車のリーダーへ学生証をタッチ。
3. Backendは許可された読み取り機器から自転車を特定し、有効カード・利用者・承認済み借り手・reserved状態を照合。
4. 一致した場合のみunlock_authorizationsとunlock commandを同一トランザクションで保存。
5. USB→中継AtomS3→ESP-NOW→自転車側へcommandを送信。
6. ACKではapprovedを維持。unlock_successを受けて初めてrentedへ変更。

LINEの承認入口・認証・bike_id必須・競合制御は維持します。
新規承認の成功レスポンスは以下に変更します。LINE側は承認成功時に「対象自転車で学生証をタッチしてください」と案内します。

```json
{
  "results": [{
    "request": {
      "request_id": "req_...",
      "borrower_display_name": "テスト借り手",
      "status": "approved",
      "bike_id": "B003",
      "created_at": "ISO8601",
      "updated_at": "ISO8601"
    },
    "lock_command": null,
    "next_action": "tap_card"
  }]
}
```

移行前に成功済みの承認イベントを再送すると、既存のreceiptが旧レスポンスを再現する場合があります。
そのreceiptと過去commandを勝手に書き換えません。実送信は別途カードタッチ権限を必須にして防ぎます。

## HTTPSでのカードタッチ通知

```text
POST /api/lock-reader/taps
Content-Type: application/json
X-Device-Id: <registered-lock-reader-id>
X-Device-Key: <device-secret>
```

```json
{
  "card_uid": "0123456789ABCDEF",
  "action": "unlock",
  "client_request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

借り手申請と同じ3項目・IDm正規化・UUID形式を使います。student_id/request_id/bike_idは送りません。
Backendが認証済みdevice_id→lock_readers→bikeを解決します。
通常の申請端末にはこの対応を自動登録しないため、端末キーだけでは解錠できません。

初回command作成は201、同じ操作再送や進行中commandの共用は200：

```json
{
  "request": {"request_id":"req_...","borrower_display_name":"テスト借り手","status":"approved","bike_id":"B003","created_at":"ISO8601","updated_at":"ISO8601"},
  "lock_command": {"command_id":"cmd_...","action":"unlock","status":"queued"}
}
```

操作IDはリーダーごとに永続的に一意であるUUIDを生成し、再送時は同じIDを使います。
正常な同一操作の再送では最初の受付JSONを返します。これは最新貸出状態ではなく受付結果です。
同じ操作IDでカードや対応bikeが変わった場合は409 IDEMPOTENCY_CONFLICT。
新しいUUIDで何度タッチしても、同じapproved申請の進行中commandを共用し、新たに作りません。
カード・利用者・端末が無効化された場合は、過去の成功操作の再送でも拒否します。
failed/timed_outの既存commandに対する新しいタッチは409 UNLOCK_RETRY_REQUIREDとし、勝手に別命令を作りません。
同一操作の再送が受付JSONを再現しても、失敗したcommandを再実行・復活させるものではありません。

主なエラー：

| HTTP | error | 条件 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 不正JSON・項目・IDm・UUID・action |
| 401 | DEVICE_AUTH_FAILED | 端末認証不正・無効 |
| 403 | LOCK_READER_NOT_REGISTERED | 許可されたリーダー・bikeの対応なし |
| 404 | CARD_NOT_REGISTERED | カード未登録 |
| 403 | CARD_DISABLED | カード・利用者が無効 |
| 403 | NOT_APPROVED_BORROWER | 承認済み借り手とカードが不一致 |
| 409 | NO_APPROVED_RENTAL | 対象bikeにapproved申請なし |
| 409 | BIKE_NOT_RESERVED | 自転車がreserved以外 |
| 409 | IDEMPOTENCY_CONFLICT | 同じ操作IDの内容変更 |
| 409 | UNLOCK_RETRY_REQUIRED | 既存命令の失敗等を先に確認すべき |
| 426 | HTTPS_REQUIRED | HTTPS必須設定でHTTPアクセス |

### リーダーの対応付け

先にdevicesへ個別の認証情報を登録します。端末キー発行用の管理APIは未実装です。
Backend管理者は次を実行すると、登録済み端末と既存bikeを固定対応できます。

```bash
npm run lock-reader:bind -- <registered-lock-reader-id> B003
```

同じ対応は再実行可能で、既存の別対応は上書きしません。資格情報は表示しません。
実機では申請端末とロックリーダーのdevice_id・キーを分けて管理してください。
HTTPS経由で認可されても、物理解錠の送信経路は現在USB/ESP-NOWです。これをHTTP応答だけで直接サーボを動かす仕様にはしません。

## USB/ESP-NOW経由のタッチ通知

自転車側→中継器→USBへ、次のJSON Linesを転送します。

```json
{"v":1,"message_type":"card_tap","relay_id":"RELAY01","device_id":"BIKE03","action":"unlock","card_uid":"0123456789ABCDEF","client_request_id":"550e8400-e29b-41d4-a716-446655440000"}
```

Backendは設定済みSERIAL_RELAY_IDと、bikes.device_id/relay_idを照合します。
任意のbike_idを信用しません。省略可能ですが、指定された場合は対応bikeと一致する必要があります。
この経路ではlock_readers表やHTTPキーは使わず、許可済みUSB中継器とbike対応を使います。

受付成功返信：

```json
{"v":1,"message_type":"card_tap_result","relay_id":"RELAY01","device_id":"BIKE03","client_request_id":"550e8400-e29b-41d4-a716-446655440000","success":true,"request_id":"req_...","command_id":"cmd_...","command_status":"queued"}
```

業務エラー時はsuccess:falseとerrorコードを返します。形式不正・未許可relayの通知は破棄します。
card_tap_resultは受付結果だけです。ハード側はこれをサーボ動作の命令として扱わず、
別途message_type:command/action:unlockを受けた時だけ動作してください。
command_idが同じなら二重実行せず、実行結果を再返信する必要があります。

ID照合は暗号学的な機器認証ではありません。USBは物理的に信頼した中継器を接続する前提です。
ESP-NOW peer鍵・暗号化・ID偽装/リプレイ対策・実行済みcommand保存はハード担当との合意・実装が必要です。

## 移行と旧命令

migration006でlock_readersとunlock_authorizationsを追加します。
既存端末の許可、過去命令の削除、過去receiptや通知event_id 10の変更は行いません。
旧版が承認時に作ったqueued/sent/acknowledgedのunlockも、カードタッチの許可記録なしでは送信しません。
旧queued命令は適正なタッチ後に同じcommand_idで許可できます。
旧版ですでに実行・送信された命令を物理的に取り消すことはできません。既存の進行中命令は移行前に確認してください。

```bash
npm run db:migrate
npm test
npm run mock:serial
```

mock:serialは独立メモリDBで「承認→送信0件→学生証タッチ→解錠成功→返却」を一巡させます。
HTTPSのMockにはNFC_OPERATION=unlockを指定します。端末の個別認証情報とlock_readers登録が別途必要です。

```bash
ALLOW_INSECURE_NFC_HTTP=true NFC_OPERATION=unlock npm run mock:nfc
```

このHTTP例は隔離LAN・ダミー資格情報専用です。既存のrequest/status/cancel操作は維持しています。

## FeliCaコードの流用範囲

このリポジトリにはRC-S330/Core2/AtomS3用の実機読み取りコードは含まれていません。
そのため実機コード自体の互換性や動作確認はまだできません。
BackendのIDm正規化・カード照合・端末キー認証・UUID再送管理は共通処理を使用しています。
実機側で流用できる候補は、カード読み取り→16桁IDmの生成→操作UUID生成→送信/再送の部分です。
HTTPであれば送信先を/api/lock-reader/taps、actionをunlockへ変更します。
USB/ESP-NOWであれば同じカード情報をcard_tapとして中継します。
リーダー機種・ドライバー・接続先ボード・配線が同じかはハード担当のコードと仕様を確認する必要があります。
