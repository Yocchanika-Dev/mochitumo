# アーキテクチャ設計（Phase 2 NFC申請対応）

## 1. 目的と境界

Backend/DBは、貸出状態の唯一の正本（source of truth）をSQLiteに保持し、NFC・LINE・ロック機器からのイベントを検証して安全な状態遷移を行います。

Backendが担当するもの：

- 利用者、自転車、貸出申請、ロックコマンド、イベントログの永続化
- 認証済み入力を業務上の利用者へ対応付けること
- 申請、承認、取消、貸出、返却の状態遷移と競合制御
- LINE Webhookの署名検証とイベント受付境界
- USBシリアルの接続、JSON Lines解析、再接続、再送、結果反映
- Mock adapterと自動テスト

外部担当が担当するもの：

- NFCカード読み取りとカードの真正性・登録運用
- LINEメッセージ、リッチメニュー等のUX
- 中継AtomS3のUSB・ESP-NOWファームウェア
- 自転車側AtomS3、LED、サーボ、施錠検知

## 2. コンポーネント

```text
HTTP Routes / Webhook
        │
Authentication / Authorization
        │
Application Services
  ├── RequestService
  ├── ApprovalService
  ├── LockCommandService
  └── EventLogService
        │
SQLite Repositories ── SQLite
        │
Serial Adapter ── USB JSONL ── Relay AtomS3 ── ESP-NOW ── Bike AtomS3
        │
LINE / NFC / Serial Mock Adapters
```

HTTPルートは入力検証とレスポンス変換だけを行い、状態遷移はApplication Serviceへ集約します。実シリアルとMock Serialは同じインターフェースを実装し、業務ロジックから実機の有無を隠します。

## 3. フォルダ構成

`server.js`を入口として維持し、HTTP・認証・業務・通信の責務を次のように分離しています。細かな対応表とレビュー結果は[全体コードレビュー](code-review.md)を参照してください。

```text
src/
├── runtime.js
├── db/
│   ├── database.js
│   ├── events.js
│   ├── migrations/
│   └── seed.js
├── http/
│   ├── errors.js
│   ├── middleware.js
│   ├── validation.js
│   ├── nfc-routes.js
│   ├── integration-routes.js
│   └── virtual-bike-routes.js
├── nfc/
│   ├── card-service.js
│   ├── device-auth.js
│   ├── request-service.js
│   └── validation.js
├── rental/
│   ├── service.js
│   ├── queries.js
│   └── commands.js
├── line/
│   ├── webhook.js
│   └── event-sender.js
├── serial/
│   ├── adapters.js
│   └── bridge.js
└── security/
    ├── device-key.js
    └── constant-time.js
server.js
mock-nfc.js
mock-line.js
mock-serial.js
scripts/
public/
test/
docs/
```

既存の`server.js`が公開する`createApp()`はテスト互換性のため維持し、内部実装だけを徐々に`src/`へ移します。

`npm start`の入口で`createRuntimeOptions()`を使い、USB・通知workerの環境設定を読み込みます。
ライブラリとして`createApp()`だけを呼ぶテストでは、通知workerは起動しません。
必要な場合だけ`eventDelivery`オプションで明示的に渡します。HTTP側の設定とAPI契約は維持します。

## 4. 貸出状態モデル

```text
requesting ──approve──> approved ──unlock_success──> rented
     │                                              │
     └──cancel──> cancelled                         └──lock_success──> returned
```

不許可の遷移：

- `approved`以降の通常キャンセル
- 解錠命令を送っただけで`rented`へ変更
- ACKだけで`rented`へ変更
- 解錠失敗・タイムアウト時の`rented`変更
- 施錠成功を確認せず`returned`へ変更

## 5. 競合制御

SQLiteの書き込みトランザクションを`BEGIN IMMEDIATE`で開始し、状態を条件に含む更新を行います。

承認の概要：

1. 認証コンテキストから貸し手を決定する。
2. requestが`requesting`であることを確認する。
3. bikeがその貸し手の所有物かつ`available`であることを確認する。
4. bikeを条件付きで`reserved`へ更新する。
5. requestを条件付きで`approved`へ更新し、貸し手とbikeを確定する。
6. 承認時点ではcommandは作らない。ロック側の有効カードが承認済み借り手と一致した時だけunlockを作る。

カードタッチ認可・command作成もIMMEDIATEで処理し、同一申請への重複commandは作らない。
[学生証タッチ解錠仕様](card-touch-unlock.md)にHTTPとUSBの共有判定・許可機器・移行時の扱いを記載しています。

取消も`status = 'requesting'`を条件に更新します。SQLiteが書き込みを直列化し、条件付き更新に成功した先行処理だけが成立します。

## 6. 認証・認可

### LINE

- 外部公開するWebhookで`X-Line-Signature`をraw bodyに対して検証する。
- 検証前にJSONを信用しない。
- 貸し手は署名済みイベント内の`line_user_id`とDBの紐付けから決定する。
- リクエスト本文の`lender_student_id`は受け付けない。

### NFCモジュール

- NFC端末は`X-Device-Id`と`X-Device-Key`を送る。
- Backendは`devices`のscrypt hashを使って端末を認証する。
- NFC端末はstudent IDを送らず、Backendが`card_uid`から利用者を解決する。
- `(device_id, client_request_id)`をDBで一意にし、再送を冪等処理する。
- カードは`active / disabled / replaced`を管理し、再発行時に旧カードを無効化する。
- 原則HTTPSとし、ローカルHTTPは隔離テストネットワークとダミーキーに限定する。
- 端末キー、key hash、認証ヘッダーをログへ出力しない。

### 中継AtomS3

- 設定されたrelay IDとbike IDの許可リストを検証する。
- 受信結果の`command_id`、`bike_id`、期待するactionをDBと照合する。
- 同一commandの重複結果は冪等処理し、異なる結果への書き換えを拒否・記録する。

### 開発用機能

- Mock APIと既存v0.2の直接コマンドAPIは開発設定でのみ有効化する。
- 公開可能な無認証APIは、機密情報を含まないhealth checkだけとする。

## 7. ロックコマンド状態

```text
queued → sent → acknowledged → succeeded
   │        │          │
   └────────┴──────────┴──> failed / timed_out
```

- `sent`：USBへ書き込み済み
- `acknowledged`：中継機または自転車側が受信を認識
- `succeeded`：実際の解錠・施錠成功結果を受信
- `failed`：機器が明示的失敗を返した
- `timed_out`：所定時間内に必要なACKまたは結果がなかった

再送時は同じ`command_id`を使用し、機器側でも実行済みIDを保持して物理動作を重複させません。

## 8. 障害時の原則

- DB更新と外部送信を単一トランザクションだと仮定しない。
- 先にコマンドをDBへ`queued`で保存し、コミット後に送信する。
- プロセス再起動後も未完了コマンドを再送可能にする。
- シリアル切断中はrequestを`approved`のまま保持する。
- 不正JSONはイベントログへ記録し、読み取りループを継続する。
- 不明なcommand、bike、relayからの結果では状態を変更しない。

## 9. ローカルMacとLINE

LINE PlatformからMacBookの`localhost`へ直接Webhookを送信できません。HTTPS公開URLを持つトンネルまたは学内で許可されたリバースプロキシが必要です。公開時はWebhookパス以外を不用意にインターネットへ露出せず、署名検証、秘密情報管理、トンネルURL変更手順を整備します。

使用するトンネルサービスと学校ネットワーク上の許可は未決事項です。
