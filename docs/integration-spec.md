# 外部モジュール連携仕様（Phase 1ドラフト）

HTTP連携とUSB JSONの実装済み形式は[現行チーム連携仕様](team-integration.md)を優先してください。ESP-NOWバイナリは引き続きハード担当との合意用ドラフトです。

## 1. 共通原則

- 外部から受け取ったID、状態、結果をそのまま信用しない。
- イベントには一意なIDを持たせ、再送を冪等に扱う。
- Backendの時刻を状態確定時刻の基準とし、送信元時刻は参考情報として保存する。
- 未知のバージョン、機器、bike、command、結果コードでは状態を変更しない。
- 秘密鍵・共有秘密・LINE Channel SecretをGitに保存しない。

## 2. NFC担当との境界

NFC担当：

- カードを読み取り、正確な`card_uid`を取得する。
- ボタン操作との対応、連打防止、読取失敗の表示を行う。
- `card_uid`、`action`、端末内で一意な`client_request_id`をBackendへ送る。
- `X-Device-Id`と`X-Device-Key`をHTTP Headerへ設定する。
- student IDを送信しない。
- 秘密キーを画面、シリアル、ログへ出力しない。

Backend担当：

- `devices`テーブルで端末ID・キー・有効状態を検証する。
- `nfc_cards`からstudent IDを特定し、カードと利用者の状態を確認する。
- 同じ`device_id`と`client_request_id`を冪等処理する。
- 二重申請を拒否し、request IDを発行する。
- 作成結果とエラーコードを返す。
- カード無効化・再発行時に旧カードを利用不能にする。

サンプルHeader：

```http
X-Device-Id: nfc-reader-01
X-Device-Key: <device secret>
Content-Type: application/json
```

サンプルBody：

```json
{
  "card_uid": "012e5ce5d8107067",
  "action": "request",
  "client_request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

MVPでも原則HTTPSを使用します。学内ローカルHTTP検証は、隔離されたテストネットワーク、ダミー端末キー、テストカード、非本番環境に限定します。

同じ端末・同じclient request ID・同じ内容の再送には初回のJSONを返します。同じ冪等キーで正規化済みIDmまたはactionが異なる場合は競合エラーです。IDmは`:・-`を除去して大文字16桁へ正規化し、先頭0とバイト順を保持します。

一般的なNFC UIDは複製できる場合があるため、UIDだけを強い本人認証とみなすかは学校運用上の合意が必要です。端末認証、カード無効化、再発行手順を組み合わせてリスクを下げます。

確定したレスポンス、エラー、再送判断、curl手順は[NFC ↔ Backend確定I/F仕様](nfc-backend-api.md)を参照してください。

## 3. LINE担当との境界

Backend担当：

- 外部Webhook endpointを提供する。
- raw bodyとChannel Secretで`X-Line-Signature`を検証する。
- LINE user IDをDB上の利用者へ対応付ける。
- 承認トランザクションを実行し、成功・競合・権限エラーを返す。
- 状態変化を通知キューまたはadapterへ渡す。

LINE担当：

- 募集通知、候補自転車選択、承認確認、結果表示のUXを作る。
- Backendが返すエラーコードを利用者向け文言へ変換する。
- LINE Messaging APIへのreply/push送信を実装する。
- 同じWebhookが再送されることを前提にevent IDを渡す。

重要事項：

- `lender_student_id`をボタンのpostback dataから信用しない。
- 貸し手は署名済みイベントのLINE user IDからBackendが特定する。
- postback dataは`request_id`と`bike_id`を含めてもよいが、所有権と状態をBackendで再検証する。
- Webhook受信にはHTTPS公開URLが必要であり、ローカルMacにはトンネルまたはリバースプロキシが必要となる。

postback data例：

```json
{
  "action": "approve",
  "request_id": "req_01J...",
  "bike_id": "B003"
}
```

## 4. USBシリアルJSON Lines

### フレーミング

- UTF-8 JSONを1行に1オブジェクト送る。
- 行末はLF（`\n`）。受信側はCRLFも許容する。
- JSON内に未エスケープの改行を含めない。
- 1行の暫定上限は1024 bytes。超過行は破棄・記録する。
- 未知の追加フィールドは無視して前方互換性を確保する。
- `v`が未対応の場合は状態を変更せずエラーを記録する。

### Backend → 中継Atom：command

```json
{"v":1,"message_type":"command","command_id":"cmd_01J...","request_id":"req_01J...","bike_id":"B003","action":"unlock","issued_at":"2026-10-21T01:25:00.000Z","attempt":1}
```

必須項目：

| 項目 | 内容 |
| --- | --- |
| `v` | プロトコルバージョン |
| `message_type` | `command` |
| `command_id` | 再送でも変えない一意ID |
| `request_id` | 対応する貸出申請 |
| `bike_id` | 対象bike |
| `action` | `unlock`または`lock` |
| `issued_at` | Backend送信時刻 |
| `attempt` | 同一commandの送信試行番号 |

### 中継Atom → Backend：ACK

```json
{"v":1,"message_type":"ack","command_id":"cmd_01J...","bike_id":"B003","relay_id":"RELAY01","ack_stage":"relay_received","received_at":"2026-10-21T01:25:00.050Z"}
```

`ack_stage`候補：

- `relay_received`：USB中継機がcommandを受信
- `bike_received`：自転車側AtomS3からESP-NOW受信確認

ACKは物理動作成功ではありません。requestを`rented`または`returned`へ変更しません。

### 中継Atom → Backend：result

```json
{"v":1,"message_type":"result","command_id":"cmd_01J...","bike_id":"B003","relay_id":"RELAY01","device_id":"BIKE03_DEVICE","result":"unlock_success","sequence":1042,"occurred_at":"2026-10-21T01:25:00.500Z"}
```

result候補：

- `unlock_success`
- `unlock_failed`
- `lock_success`
- `lock_failed`
- `device_busy`
- `invalid_command`
- `unauthorized_target`

Backendは`command_id`から期待するrequest、bike、actionを取得し、受信値が一致する場合だけ状態を変更します。

### heartbeat

```json
{"v":1,"message_type":"heartbeat","relay_id":"RELAY01","sequence":5001,"firmware_version":"0.1.0"}
```

heartbeatは接続監視用で、貸出状態を変更しません。

### エラー処理・再接続

- 不正JSON：行を破棄し`serial.invalid_json`を記録して次行を処理する。
- USB切断：未完了commandをDBに残し、指数バックオフ付きで再接続する。
- 再接続：同じcommand IDで未完了commandを再送する。
- ACKタイムアウトと実行結果タイムアウトを別に扱う。
- 重複result：同じcommand ID・同じ結果なら冪等成功とする。
- 矛盾result：成功確定後の失敗などは状態を変更せずセキュリティログへ記録する。

接続ポート、baud rate、タイムアウト、再送回数は環境変数または設定ファイルで変更可能にします。

```text
SERIAL_PORT=/dev/cu.usbmodemXXXX
SERIAL_BAUD_RATE=115200
SERIAL_ACK_TIMEOUT_MS=2000
SERIAL_RESULT_TIMEOUT_MS=10000
SERIAL_MAX_ATTEMPTS=3
```

## 5. Mock Serial Adapter

実機adapterとMock adapterは次の概念的インターフェースを共有します。

```js
adapter.connect()
adapter.send(command)
adapter.on('ack', handler)
adapter.on('result', handler)
adapter.on('invalidMessage', handler)
adapter.on('disconnect', handler)
adapter.close()
```

Mockは次を再現可能にします。

- 正常なACKと成功結果
- 明示的失敗
- ACKなし
- 結果タイムアウト
- 不正JSON
- 切断と再接続
- ACK・結果の重複
- 別bike IDや不明command IDからの不正結果

## 6. ESP-NOWペイロード（合意前ドラフト）

ESP-NOWは固定長バイナリ構造体を想定します。次はハード担当との議論開始用であり、確定仕様ではありません。

| フィールド | 暫定型・長さ | 内容 |
| --- | --- | --- |
| `magic` | `uint16` / 2 | プロトコル識別子 |
| `version` | `uint8` / 1 | 形式バージョン |
| `message_type` | `uint8` / 1 | command / ack / result |
| `command_id` | 16 bytes | UUIDバイナリ |
| `request_id` | 16 bytes | UUIDバイナリ |
| `source_id` | 6 bytes | 送信元MACまたは機器ID |
| `target_id` | 6 bytes | 送信先MACまたは機器ID |
| `bike_id` | `uint32` / 4 | 数値化したbike ID |
| `action` | `uint8` / 1 | none / unlock / lock / light |
| `result_code` | `uint8` / 1 | 結果コード |
| `sequence` | `uint32` / 4 | リプレイ検知用連番 |
| `timestamp` | `uint32` / 4 | 任意。時刻同期方針が必要 |
| `payload_crc32` | `uint32` / 4 | 破損検出。認証用途ではない |
| `auth_tag` | 16 bytes | 任意の認証タグ案 |

暫定合計は82 bytesで、ESP-NOWのペイロード上限内を想定しています。構造体paddingに依存しないようpacked指定または明示的serializeを使用し、エンディアンを固定します。

セキュリティ候補：

- ESP-NOWのPMK/LMK暗号化を有効化する。
- target IDの許可リストを持つ。
- command IDとsequenceを永続または耐再起動領域に保持してリプレイを拒否する。
- CRCは改ざん検知にならないため、必要なら共有鍵による認証タグを追加する。

フィールド長、機器ID、エンディアン、鍵管理、再起動後のsequence、結果コードはハード担当との合意が必要です。

## 7. 状態変化通知

Backendは少なくとも次の内部イベントをLINE adapterへ渡します。

- `request.created`
- `request.cancelled`
- `request.approved`
- `request.rented`
- `request.returned`
- `command.failed`
- `command.timed_out`

LINE送信失敗で確定済みの貸出状態を巻き戻しません。通知は再送可能にし、業務状態と通知状態を分離します。通知キューをDBに持つかはPhase 5までに決定します。
