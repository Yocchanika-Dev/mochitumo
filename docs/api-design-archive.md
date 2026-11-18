# 旧API設計ドラフト（履歴保存・現行契約ではありません）

現行の入口は[API仕様](api-spec.md)です。以下は初期案の記録であり、実装済みとは限りません。

NFC申請・状態取得・取消、LINE向け取得と署名付き承認、healthは実装済みです。認証・Body・実装状況は[現行チーム連携仕様](team-integration.md)を優先してください。以下に残る簡略承認Bodyや認証コンテキストは設計ドラフトです。既存v0.2 APIは末尾に記載します。

正式承認は自転車の確保のみです。学生証タッチ後の解錠要求は[カードタッチ解錠API](card-touch-unlock.md)を参照してください。

## 1. 共通仕様

- JSONはUTF-8を使用する。
- 時刻はUTCのISO 8601形式とする。
- IDは文字列として扱う。
- 成功レスポンスは対象リソースを返す。
- エラーは次の形式に統一する。

```json
{
  "success": false,
  "error": "INVALID_STATE",
  "message": "requesting状態の申請だけ承認できます"
}
```

主なHTTPステータス：

| Status | 用途 |
| --- | --- |
| `200` | 取得、状態変更、冪等な再送成功 |
| `201` | 新規リソース作成 |
| `400` | JSON・型・必須項目・署名時刻等が不正 |
| `401` | 認証情報なし、署名不正 |
| `403` | 認証済みだが権限・所有権がない |
| `404` | 対象が存在しない、または開示しない |
| `409` | 二重申請、状態競合、自転車利用不可 |
| `422` | 形式は正しいが業務条件を満たさない |
| `426` | HTTPS必須APIへHTTPで接続 |
| `500` | サーバー内部エラー。詳細情報は返さない |
| `503` | DB等の必須依存先が利用不可 |

## 2. 認証方式

### NFC端末認証

`POST /api/requests`は次のヘッダーを必須とします。

```text
X-Device-Id: nfc-reader-01
X-Device-Key: <device secret>
```

Backendは`devices`テーブルから端末を検索し、キーを端末ごとのsaltを使ったscryptハッシュと定数時間比較します。平文キー・保存済みhash・認証ヘッダーをログへ出力しません。

- 未登録端末、無効端末、キー不一致はすべて`401 DEVICE_AUTH_FAILED`とし、登録状況を開示しない。
- 原則HTTPSとし、既定ではHTTPを`426 HTTPS_REQUIRED`で拒否する。
- ローカルHTTPは非本番で`ALLOW_INSECURE_NFC_HTTP=true`を明示し、隔離テストネットワークとダミー資格情報だけで利用する。
- reverse proxyの`X-Forwarded-Proto`は、明示的に信頼したproxy経由の場合だけ参照する。

NFC端末はstudent IDを送信しません。Backendが`card_uid`を`nfc_cards`で照合してstudent IDを決定します。

### LINE Webhook

LINE Platformから受け取るraw bodyとChannel Secretで`X-Line-Signature`を検証します。署名検証前にイベント内容を信用しません。貸し手は署名済みイベントのLINE user IDから特定し、本文指定のstudent IDは使用しません。

### 内部・開発用サービス

Mockや管理確認には環境変数で設定したBearer tokenを使う案とします。本番ではMockルートそのものを無効化します。

## 3. Health check

### `GET /api/health`

- 認証：不要
- 呼出担当：監視、開発者
- 状態遷移：なし
- 機密情報、環境変数、利用者情報は返さない

レスポンス `200`：

```json
{
  "status": "ok",
  "database": "ok",
  "serial": "disconnected",
  "time": "2026-10-21T01:23:45.000Z"
}
```

DBが利用できない場合は`503`とし、serial切断だけではHTTPサーバー自体を異常扱いにしません。

## 4. 自転車

### `GET /api/bikes?availability=available`

- 認証：NFCサービス、LINE認証コンテキスト、または管理用token
- 呼出担当：LINE担当、NFC担当、管理・デバッグ
- 状態遷移：なし
- クエリ：`availability`は任意

レスポンス `200`：

```json
{
  "bikes": [
    {
      "bike_id": "B003",
      "owner_student_id": "S1002",
      "availability": "available"
    }
  ]
}
```

一般利用者へ所有者student IDを返す必要性は再検討し、不要なら表示名または非公開にします。

### `GET /api/me/bikes`

- 認証：署名検証済みLINEコンテキスト
- 呼出担当：LINE担当
- 状態遷移：なし
- 所有者はLINE user IDから解決するため、student IDをパラメータにしない

レスポンス `200`：

```json
{
  "bikes": [
    {
      "bike_id": "B003",
      "availability": "available"
    }
  ]
}
```

## 5. 貸出申請

### `POST /api/requests`

- 実装状況：実装済み
- 認証：`X-Device-Id` / `X-Device-Key`必須
- 呼出担当：NFC・借り手申請モジュール
- 遷移：新規作成 → `requesting`
- 冪等性：`(device_id, client_request_id)`を一意キーとして扱う
- 通信：原則HTTPS

リクエスト：

```json
{
  "card_uid": "012e5ce5d8107067",
  "action": "request",
  "client_request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

Bodyはこの3項目だけを許可します。`student_id`を含む余分な項目は`400 INVALID_REQUEST`です。`card_uid`はFeliCa IDmで、`:・-`を除去して大文字16進16桁へ正規化します。先頭0を削除せず、バイト順も変更しません。MVPで許可する`action`は`request`だけ、`client_request_id`はUUID形式です。

レスポンス `201`：

```json
{
  "success": true,
  "request_id": "req_01J...",
  "student_id": "S1001",
  "status": "requesting"
}
```

エラー：

- `400 INVALID_REQUEST`
- `401 DEVICE_AUTH_FAILED`
- `403 CARD_DISABLED`
- `404 CARD_NOT_REGISTERED`
- `409 ACTIVE_REQUEST_EXISTS`
- `409 IDEMPOTENCY_CONFLICT`：同じ端末・client request IDで異なる内容
- `426 HTTPS_REQUIRED`

同じdevice ID・client request ID・同じ内容の再送には、現在の貸出状態に関係なく初回と同じJSONを`200`で返します。別のclient request IDで同じ学生に`requesting / approved / rented`がある場合は`409 ACTIVE_REQUEST_EXISTS`です。このエラーには`existing_request_id`と`existing_status`が含まれます。

### `GET /api/requests/:requestId`

- 認証：NFC、LINE、内部サービスまたは管理用token
- 呼出担当：NFC状態表示、LINE通知、開発者
- 状態遷移：なし
- 認可：借り手、確定した貸し手、または許可されたサービスだけ

レスポンス `200`：

```json
{
  "request_id": "req_01J...",
  "borrower_student_id": "S1001",
  "lender_student_id": "S1002",
  "bike_id": "B003",
  "status": "approved",
  "created_at": "2026-10-21T01:23:45.100Z",
  "updated_at": "2026-10-21T01:25:00.000Z"
}
```

権限外の利用者には対象の存在を推測させないため`404`を返す方針です。

### `POST /api/requests/:requestId/cancel`

- 認証：認証済みNFCイベント、または署名検証済みLINE利用者
- 呼出担当：NFC担当またはLINE担当
- 遷移：`requesting → cancelled`のみ
- 認可：申請した借り手だけ

リクエスト例：

```json
{
  "event_id": "cancel_evt_01J...",
  "occurred_at": "2026-10-21T01:24:30.000Z"
}
```

借り手IDは認証コンテキストから取得し、本文には含めません。

レスポンス `200`：

```json
{
  "request_id": "req_01J...",
  "status": "cancelled",
  "updated_at": "2026-10-21T01:24:30.100Z"
}
```

エラー：

- `403 NOT_REQUEST_BORROWER`
- `404 REQUEST_NOT_FOUND`
- `409 INVALID_STATE`：承認済み、貸出中、返却済み等

### `POST /api/requests/:requestId/approve`

- 認証：署名検証済みLINE利用者
- 呼出担当：LINE担当
- 遷移：`requesting → approved`
- 副作用：bikeを`available → reserved`。unlock commandはカードタッチまで作成しない
- 競合制御：SQLiteの書き込みトランザクションと条件付き更新

リクエスト：

```json
{
  "event_id": "line_evt_01J...",
  "bike_id": "B003"
}
```

`lender_student_id`は受け付けません。署名済みLINE user IDからBackendが決定します。

レスポンス `200`：

```json
{
  "request": {
    "request_id": "req_01J...",
    "borrower_student_id": "S1001",
    "lender_student_id": "S1002",
    "bike_id": "B003",
    "status": "approved",
    "updated_at": "2026-10-21T01:25:00.000Z"
  },
  "lock_command": null,
  "next_action": "tap_card"
}
```

エラー：

- `401 INVALID_LINE_SIGNATURE`
- `403 LINE_ACCOUNT_NOT_LINKED`
- `403 BIKE_NOT_OWNED`
- `404 REQUEST_NOT_FOUND`
- `404 BIKE_NOT_FOUND`
- `409 INVALID_STATE`：取消または他の承認が先に成立
- `409 BIKE_NOT_AVAILABLE`

承認後は`approved`でカードタッチ待ちです。適正なタッチ後にunlock commandを作成します。
実機から`unlock_success`が届くまで`rented`にはしません。

## 6. LINE Webhook

### `POST /webhooks/line`

- 認証：LINEの`X-Line-Signature`
- 呼出担当：LINE Platform
- リクエスト：LINE公式Webhook形式をそのまま受け取る
- 状態遷移：イベント種別に応じて承認・取消等をApplication Serviceへ委譲

署名検証にraw bodyが必要なため、このルートでは通常のJSON middlewareより先にraw bodyを保持します。Webhookには速やかに`200`を返し、返信・push送信失敗と業務トランザクションを混同しない設計にします。

## 7. Mockクライアント・Mock API（開発時のみ）

NFCは別のMock HTTP endpointを作らず、`mock-nfc.js`が実際の`POST /api/requests`を呼びます。これにより端末認証、JSON検証、カード照合、冪等性を実経路で確認します。

```bash
ALLOW_INSECURE_NFC_HTTP=true npm run mock:nfc
```

Mockは`X-Device-Key`を画面やログへ出力しません。HTTP利用は非本番・隔離ネットワーク・ダミー資格情報に限定します。

将来のMock候補：

- `POST /mock/line/requests/:requestId/approve`
- `POST /mock/serial/messages`

条件：

- `NODE_ENV=production`ではルートを登録しない。
- 開発用Bearer tokenを必須とする。
- 実APIと同じApplication Serviceを呼び、Mock専用の業務ロジックを作らない。
- Mock呼出であることをevent logへ残す。

## 8. USB結果とHTTP APIの関係

実シリアル結果はHTTP経由ではなくSerial Adapterが直接Application Serviceへ渡します。

- `unlock_success`：commandを`succeeded`、requestを`approved → rented`、bikeを`reserved → rented`
- `unlock_failed`：commandを`failed`、requestは`approved`、bikeは`reserved`のまま
- `lock_success`：commandを`succeeded`、requestを`rented → returned`、bikeを`rented → available`
- ACKのみ：commandを`acknowledged`にするがrequest状態は変更しない

Mock Serial APIはこの経路をテストするためだけに使用します。

## 9. 既存v0.2 APIの互換性

既存Web画面が利用する次のAPIは今回変更していません。

- `GET /api/bikes`
- `POST /api/bikes/03/light`
- `POST /api/bikes/03/unlock`
- `GET /api/bikes/03/command`
- `POST /api/bikes/03/commands/:commandId/complete`
- `GET /api/bikes/03/commands`

Phase 2以降は`ENABLE_LEGACY_DEMO_API=true`等の開発設定下へ隔離する案です。`GET /api/bikes`は新DB版へ移行可能ですが、レスポンス互換性をテストします。直接unlock APIは正式承認を迂回するため、本番では必ず無効化します。
