# データベース設計（Phase 2 NFC申請対応）

追加マイグレーション003で`bikes.owner_student_id`をUNIQUEにし、貸し手1人1台を保証します。
`operation_receipts`はsource/event_idを主キーとし、操作fingerprint・成功JSON・時刻を保存します。
承認・取消・施錠要求の再送時は初回成功JSONを再現し、内容変更は拒否します。
業務更新・command作成・イベントログ・receiptは同一トランザクションです。
追加APIとUSB結果の現行仕様は[チーム連携手順](team-integration.md)を参照してください。

## 1. 方針

- SQLiteを使用し、外部キー制約を接続ごとに有効化する。
- IDは外部公開しても推測しにくいUUIDを基本とする。
- 時刻はUTCのISO 8601文字列で保存する。
- 状態値は`CHECK`制約で限定する。
- 状態遷移はApplication Service内のトランザクションで行う。
- 重要操作は`event_logs`へ追記し、既存ログを更新・削除しない。
- マイグレーションファイルを番号順に適用し、適用履歴を管理する。
- 端末キーは平文保存せず、端末ごとのsaltを用いたscryptハッシュで保存する。

## 2. users

| 列 | 型・制約 | 内容 |
| --- | --- | --- |
| `student_id` | TEXT PRIMARY KEY | 学校が管理する学生ID |
| `line_user_id` | TEXT UNIQUE NULL | 署名済みLINEイベントから得るID |
| `name` | TEXT NOT NULL | 表示名 |
| `status` | TEXT NOT NULL CHECK | `active` / `disabled` |
| `created_at` | TEXT NOT NULL | 作成時刻 |
| `updated_at` | TEXT NOT NULL | 更新時刻 |

`student_id`を知っているだけでは認証成功としません。LINEとの初回紐付け方式はチーム合意事項です。

## 3. devices

| 列 | 型・制約 | 内容 |
| --- | --- | --- |
| `device_id` | TEXT PRIMARY KEY | NFC端末ID |
| `name` | TEXT NOT NULL | 管理用表示名 |
| `device_key_salt` | TEXT NOT NULL | scrypt用salt |
| `device_key_hash` | TEXT NOT NULL | scryptで導出したキーhash |
| `status` | TEXT NOT NULL CHECK | `active` / `disabled` |
| `created_at` | TEXT NOT NULL | 作成時刻 |
| `updated_at` | TEXT NOT NULL | 更新時刻 |
| `last_authenticated_at` | TEXT NULL | 最終認証成功時刻 |
| `key_rotated_at` | TEXT NULL | キー更新時刻 |

未登録、無効、キー不一致はAPI上で同じ認証エラーにし、端末登録状況を外部へ漏らしません。平文キーとhashはログへ出力しません。

## 4. nfc_cards

| 列 | 型・制約 | 内容 |
| --- | --- | --- |
| `card_uid` | TEXT PRIMARY KEY | `:・-`を除去した大文字16桁のFeliCa IDm |
| `student_id` | TEXT NOT NULL FK | `users.student_id` |
| `status` | TEXT NOT NULL CHECK | `active` / `disabled` / `replaced` |
| `replaces_card_uid` | TEXT NULL FK | 再発行時の旧カード |
| `issued_at` | TEXT NOT NULL | 発行時刻 |
| `disabled_at` | TEXT NULL | 無効化・交換時刻 |
| `created_at` | TEXT NOT NULL | 作成時刻 |
| `updated_at` | TEXT NOT NULL | 更新時刻 |

学生1人につき`active`カードを1枚までとする部分ユニークインデックスを設定します。再発行は旧カードを`replaced`にしてから、同じstudent IDへ新しい`active`カードを登録する1トランザクションです。

## 5. bikes

| 列 | 型・制約 | 内容 |
| --- | --- | --- |
| `bike_id` | TEXT PRIMARY KEY | 自転車ID |
| `owner_student_id` | TEXT NOT NULL FK | `users.student_id` |
| `availability` | TEXT NOT NULL CHECK | `available` / `reserved` / `rented` / `maintenance` |
| `device_id` | TEXT UNIQUE NULL | 自転車側AtomS3識別子 |
| `relay_id` | TEXT NULL | 許可する中継AtomS3識別子 |
| `created_at` | TEXT NOT NULL | 作成時刻 |
| `updated_at` | TEXT NOT NULL | 更新時刻 |

承認時に`available → reserved`、解錠成功時に`reserved → rented`、返却時の施錠成功で`rented → available`へ変更します。

## 6. rental_requests

| 列 | 型・制約 | 内容 |
| --- | --- | --- |
| `request_id` | TEXT PRIMARY KEY | 貸出申請UUID |
| `borrower_student_id` | TEXT NOT NULL FK | 借り手 |
| `lender_student_id` | TEXT NULL FK | 承認成立後の貸し手 |
| `bike_id` | TEXT NULL FK | 承認成立後の自転車 |
| `status` | TEXT NOT NULL CHECK | `requesting` / `cancelled` / `approved` / `rented` / `returned` |
| `source_device_id` | TEXT NOT NULL FK | 認証済みNFC端末 |
| `client_request_id` | TEXT NOT NULL | 端末が生成する冪等ID |
| `request_fingerprint` | TEXT NOT NULL | 正規化したactionとcard UIDのSHA-256 |
| `created_at` | TEXT NOT NULL | 作成時刻 |
| `updated_at` | TEXT NOT NULL | 更新時刻 |
| `approved_at` | TEXT NULL | 承認成立時刻 |
| `cancelled_at` | TEXT NULL | 取消成立時刻 |
| `rented_at` | TEXT NULL | 解錠成功確認時刻 |
| `returned_at` | TEXT NULL | 施錠成功確認時刻 |

推奨制約：

- `requesting`と`cancelled`では貸し手・bikeをNULLとする。
- `approved`、`rented`、`returned`では貸し手・bikeを必須とする。
- 借り手1人につき`requesting`、`approved`、`rented`の申請を同時に1件までとする部分ユニークインデックスを設定する。
- bikeごとに`approved`または`rented`の申請を同時に1件までとする部分ユニークインデックスを設定する。
- `(source_device_id, client_request_id)`をUNIQUEにし、同じ端末からの再送でrequestを重複作成しない。
- 同じ冪等キー・同じfingerprintは既存requestを返し、同じキー・異なるfingerprintは競合として拒否する。

```sql
CREATE UNIQUE INDEX one_active_request_per_borrower
ON rental_requests (borrower_student_id)
WHERE status IN ('requesting', 'approved', 'rented');

CREATE UNIQUE INDEX one_active_request_per_bike
ON rental_requests (bike_id)
WHERE status IN ('approved', 'rented');
```

## 7. lock_commands

| 列 | 型・制約 | 内容 |
| --- | --- | --- |
| `command_id` | TEXT PRIMARY KEY | コマンドUUID |
| `request_id` | TEXT NOT NULL FK | 対応する申請 |
| `bike_id` | TEXT NOT NULL FK | 対象自転車 |
| `action` | TEXT NOT NULL CHECK | `unlock` / `lock` |
| `status` | TEXT NOT NULL CHECK | `queued` / `sent` / `acknowledged` / `succeeded` / `failed` / `timed_out` |
| `attempt_count` | INTEGER NOT NULL DEFAULT 0 | 送信試行数 |
| `result_code` | TEXT NULL | 実機からの結果コード |
| `error_message` | TEXT NULL | 失敗・タイムアウト情報 |
| `created_at` | TEXT NOT NULL | 作成時刻 |
| `sent_at` | TEXT NULL | 最初の送信時刻 |
| `acked_at` | TEXT NULL | ACK受信時刻 |
| `completed_at` | TEXT NULL | 成功または失敗確定時刻 |

`UNIQUE(request_id, action)`を基本とし、通信再送では新しいcommandを作らず同じ`command_id`を使用します。業務上再試行コマンドを作り直す要件が出た場合は、世代番号を追加して制約を見直します。

## 8. event_logs

| 列 | 型・制約 | 内容 |
| --- | --- | --- |
| `event_log_id` | INTEGER PRIMARY KEY AUTOINCREMENT | ログID |
| `event_type` | TEXT NOT NULL | `request.created`等 |
| `entity_type` | TEXT NOT NULL | `request` / `bike` / `command`等 |
| `entity_id` | TEXT NOT NULL | 対象ID |
| `actor_type` | TEXT NOT NULL | `nfc` / `line_user` / `relay` / `system` |
| `actor_id` | TEXT NULL | サービス・利用者・機器ID |
| `payload_json` | TEXT NOT NULL DEFAULT `'{}'` | 補助情報。秘密情報は保存しない |
| `created_at` | TEXT NOT NULL | 発生時刻 |

想定イベント例：

- `request.created`
- `request.cancelled`
- `request.approved`
- `command.queued`
- `command.sent`
- `command.acknowledged`
- `command.succeeded`
- `command.failed`
- `request.rented`
- `request.returned`
- `security.replay_rejected`
- `serial.invalid_json`

## 9. inbound_events

外部イベントの冪等性とリプレイ検知用の補助テーブルです。

| 列 | 型・制約 | 内容 |
| --- | --- | --- |
| `source` | TEXT NOT NULL | `nfc` / `line` / `relay` |
| `source_id` | TEXT NOT NULL | device、LINE source、relay等 |
| `event_id` | TEXT NOT NULL | 送信元イベントID |
| `body_hash` | TEXT NOT NULL | 受信bodyのSHA-256 |
| `received_at` | TEXT NOT NULL | 初回受信時刻 |

主キーは`(source, source_id, event_id)`です。NFCでは`source_id=device_id`、`event_id=client_request_id`です。同じID・同じbodyの再送は前回結果を返し、同じID・異なるbodyは競合として拒否します。

## 10. idempotency_records

NFC申請の初回処理結果を再起動後も再現するためのテーブルです。

| 列 | 型・制約 | 内容 |
| --- | --- | --- |
| `device_id` | TEXT NOT NULL FK | 認証済みNFC端末 |
| `client_request_id` | TEXT NOT NULL | 端末が生成したUUID |
| `request_fingerprint` | TEXT NOT NULL | 正規化IDmとactionのSHA-256 |
| `request_id` | TEXT NOT NULL FK | 初回に作成したrequest |
| `response_student_id` | TEXT NOT NULL FK | 初回レスポンスのstudent ID |
| `response_status` | TEXT NOT NULL | 初回レスポンスの`requesting` |
| `created_at` | TEXT NOT NULL | 初回処理時刻 |

主キーは`(device_id, client_request_id)`です。再送では現在の貸出状態ではなく、この記録から初回のレスポンスを返します。既存の`rental_requests`にも同じ複合一意制約を残し、DBレベルで二重作成を防ぎます。

## 11. トランザクション境界

### 申請作成

端末認証後、既存冪等キー確認、カードと利用者の有効性確認、二重申請確認、`rental_requests`と`inbound_events`作成、`event_logs`追記を1トランザクションで行います。

### 承認

request確認、所有者確認、bike確保、request承認、イベントログ追記を1トランザクションで行います。ここではunlock commandを作りません。
ロック側の学生証タッチ時に、機器・カード・承認済み借り手を確認し、unlock_authorizations・command・receipt・ログを別の同一トランザクションで保存します。USB送信はコミット後です。

migration006の追加テーブル：

- `lock_readers`：device_id（devicesへのFK・主キー）、bike_id（bikesへのFK・UNIQUE）、created_at。HTTPSロックリーダーと自転車の固定対応。
- `unlock_authorizations`：command_id（lock_commandsへのFK・主キー）、borrower_student_id（usersへのFK）、reader_source、client_request_id、created_at。カードタッチ確認済みcommandの許可記録。
- `(reader_source, client_request_id)`はUNIQUE。過去のcommandへ自動で権限を付与しない。

### 解錠結果

command結果の冪等確認、command成功、requestの`approved → rented`、bikeの`reserved → rented`、ログ追記を1トランザクションで行います。

### 返却結果

lock command成功、requestの`rented → returned`、bikeの`rented → available`、ログ追記を1トランザクションで行います。

## 12. 実装状況と今後の詳細

- `better-sqlite3`と小さなマイグレーションランナーを採用済み。
- 初期マイグレーションは`src/db/migrations/001_initial.sql`。
- 貸出申請IDは`req_<UUID>`形式。
- 開発seedは`S1001`、`S1002`、`B003`、`nfc-reader-01`、`012E5CE5D8107067`。
- 管理者向けの端末登録、キー更新、カード無効化・再発行インターフェースは今後決定する。
