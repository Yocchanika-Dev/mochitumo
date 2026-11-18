# NFC ↔ Backend I/F確定仕様

この文書はSony RC-S330で読み取ったFeliCa IDmを、NFC端末からBackendへ送るための確定仕様です。

## 1. エンドポイント

```http
POST /api/requests
Content-Type: application/json
X-Device-Id: nfc-reader-01
X-Device-Key: <secret>
```

```json
{
  "card_uid": "012e5ce5d8107067",
  "action": "request",
  "client_request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

NFC端末は`student_id`を送信しません。Backendが正規化済みIDmを`nfc_cards`で検索し、対応するstudent IDを決定します。

### 必須項目

| 項目 | 形式 | 内容 |
| --- | --- | --- |
| `card_uid` | string | FeliCa IDm。正規化後16桁の16進文字列 |
| `action` | string | `request`固定 |
| `client_request_id` | string | 申請操作ごとに生成するUUID |

Bodyにこの3項目以外を含めないでください。

## 2. FeliCa IDm正規化

Backendは申請時とカード登録・再発行時に同じ正規化関数を使用します。

1. 文字列として受け取る。
2. `:`と`-`を除去する。
3. 英字を大文字にする。
4. 正規化後が16桁の16進文字列であることを検証する。
5. 先頭の0を削除しない。
6. バイト順を変更しない。

例：

| 入力 | DB照合値 |
| --- | --- |
| `012e5ce5d8107067` | `012E5CE5D8107067` |
| `01:2e:5c:e5:d8:10:70:67` | `012E5CE5D8107067` |
| `01-2e-5c-e5-d8-10-70-67` | `012E5CE5D8107067` |

空白、16桁以外、16進数以外の文字は`400 INVALID_REQUEST`です。

FeliCa IDmは本人認証情報ではなくカード識別子です。UID複製リスクを考慮し、端末認証、カード無効化、再発行運用と組み合わせます。

## 3. 端末認証

BackendはJSON解析より先にHeaderを確認します。

- `X-Device-Id`で`devices`を検索する。
- `X-Device-Key`を、端末ごとのsaltを使ったscrypt hashと定数時間比較する。
- 端末状態が`active`であることを確認する。
- 未登録、無効、キー不一致はいずれも`401 DEVICE_AUTH_FAILED`とする。
- 平文キー、key hash、認証Headerをログへ出力しない。

端末キーは端末ごとに異なる高エントロピー値を発行し、Gitにコミットしません。

## 4. 正常レスポンス

### 初回：201 Created

```json
{
  "success": true,
  "request_id": "req_12345678-1234-1234-1234-123456789abc",
  "student_id": "S1001",
  "status": "requesting"
}
```

### 同じ内容の再送：200 OK

初回と同じJSONを返します。

```json
{
  "success": true,
  "request_id": "req_12345678-1234-1234-1234-123456789abc",
  "student_id": "S1001",
  "status": "requesting"
}
```

初回後にrequestが`approved`等へ変化していても、再送レスポンスは初回処理時の`requesting`を再現します。状態確認APIとは役割が異なります。

## 5. 冪等性

冪等キーは`device_id + client_request_id`です。

- 初回処理のfingerprint、request ID、student ID、初回statusを`idempotency_records`へ保存する。
- 同じキー・同じ正規化IDm・同じactionなら新規処理をせず初回結果を返す。
- 同じキーで正規化IDmまたはactionが異なる場合は`409 IDEMPOTENCY_CONFLICT`。
- SQLiteの主キー、一意制約、`BEGIN IMMEDIATE`トランザクションで同時再送時の二重作成を防ぐ。
- 記録はSQLiteに保存されるためBackend再起動後も維持される。

## 6. 未完了申請

同じstudent IDに次の状態が存在する場合、新しいclient request IDによる申請を拒否します。

- `requesting`
- `approved`
- `rented`

`cancelled`または`returned`だけの場合は新規申請できます。

```json
{
  "success": false,
  "error": "ACTIVE_REQUEST_EXISTS",
  "message": "未完了の貸出申請が存在します",
  "existing_request_id": "req_1234...",
  "existing_status": "approved"
}
```

同一client request IDの再送判定を先に行うため、初回requestが進行中でも正常な冪等再送は`200`です。

## 7. エラー

共通形式：

```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "エラーの説明"
}
```

| HTTP | Error | 意味 |
| ---: | --- | --- |
| 400 | `INVALID_REQUEST` | JSON、必須項目、IDm、action、UUID等が不正 |
| 401 | `DEVICE_AUTH_FAILED` | 端末未登録、無効、キー不一致 |
| 403 | `CARD_DISABLED` | カードまたは利用者が無効 |
| 404 | `CARD_NOT_REGISTERED` | 正規化済みIDmが未登録 |
| 409 | `ACTIVE_REQUEST_EXISTS` | 同じ学生に未完了申請が存在 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同じ操作IDで異なる内容 |
| 426 | `HTTPS_REQUIRED` | HTTPS必須設定でHTTPを使用 |
| 500 | `INTERNAL_ERROR` | Backend内部エラー |

内部エラーではstack trace、SQL、端末キー、保存済みhashを返しません。

### IDEMPOTENCY_CONFLICT

```json
{
  "success": false,
  "error": "IDEMPOTENCY_CONFLICT",
  "message": "同じ操作IDで異なる申請内容が送信されました"
}
```

### DEVICE_AUTH_FAILED

```json
{
  "success": false,
  "error": "DEVICE_AUTH_FAILED",
  "message": "端末認証に失敗しました"
}
```

## 8. NFC端末の再送判断

| 結果 | 端末動作 |
| --- | --- |
| `201` | 成功。再送しない |
| `200` | 冪等再送成功。再送しない |
| `409 ACTIVE_REQUEST_EXISTS` | 再送しない。既存申請を案内 |
| `409 IDEMPOTENCY_CONFLICT` | 端末側不整合。再送せずエラー記録 |
| `400 / 401 / 403 / 404` | そのまま再送しない |
| `500 INTERNAL_ERROR` | 同じ3項目・同じclient request IDで再送可能 |
| 通信失敗・タイムアウト | 同じ3項目・同じclient request IDで再送可能 |

再送回数と待機時間には上限を設定してください。再送のたびにUUIDを作り直してはいけません。

## 9. ローカル接続手順

MVPのHTTP検証は、隔離された学内テストネットワークとダミー資格情報だけに限定します。

Backend：

```bash
npm install
npm run db:migrate
npm run db:seed
ALLOW_INSECURE_NFC_HTTP=true npm start
```

Mock NFC：

```bash
ALLOW_INSECURE_NFC_HTTP=true npm run mock:nfc
```

実運用ではHTTPSトンネル、reverse proxy、または別の安全な経路を使用します。本番環境ではHTTP許可設定は無効です。

## 10. curl通信試験

次の端末キーは開発seed専用のダミー値です。

```bash
curl -i \
  -X POST http://localhost:3000/api/requests \
  -H 'Content-Type: application/json' \
  -H 'X-Device-Id: nfc-reader-01' \
  -H 'X-Device-Key: dev-only-nfc-key-change-me' \
  --data '{"card_uid":"012e5ce5d8107067","action":"request","client_request_id":"550e8400-e29b-41d4-a716-446655440000"}'
```

同じcurlを再実行すると、初回は`201`、2回目は同じrequest IDで`200`になります。

別のclient request IDで試験する場合はUUIDを変更します。ただし同じ学生のrequestが`requesting`中なら`409 ACTIVE_REQUEST_EXISTS`です。繰り返し試験では、追加実装した[状態取得・カード確認付き取消API](team-integration.md)でrequesting→cancelledにしてください。承認後の通常取消は不可です。実DBを消去する必要はありません。

## 11. NFC担当が保持する設定

- Backend URL
- `X-Device-Id`
- `X-Device-Key`（秘密情報）
- HTTP timeout
- 最大再送回数
- 再送待機時間

ログへ出してよいもの：device ID、client request ID、HTTP status、error code。

ログへ出してはいけないもの：device key、認証Header全体、Backendの秘密情報。
