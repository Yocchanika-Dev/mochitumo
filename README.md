# モバエコ自転車貸出IoTシステム Backend/DB

学校内で学生所有の自転車を貸し借りするIoTシステムです。MacBook上のNode.jsサーバーを中心に、NFC、LINE、USB接続した中継AtomS3、ESP-NOW接続した自転車側AtomS3を連携します。

SQLite/NFC申請に続き、状態取得・取消、LINE向け一覧・イベント取得、署名付き正式承認、USB JSON LinesとMockを実装しました。Core2実機の新規201→同一UUID・本文で再送200はNFC担当から成功報告済みです。Backendでも対応する申請・通知イベントが各1件であることを確認しました。その実申請のLINE募集通知でも初回202・duplicate:false→グループに1件表示→同一本文再送200・duplicate:true→重複表示なしまで確認済みです。LINE専用HTTPS入口は公開疎通・サービス認証まで確認済みです。正式承認は公式Channel Secret・実LINE本人紐付けの設定待ち、USB/ESP-NOW実機は未検証です。

追加APIの現行仕様・起動設定・統合確認は[チーム連携手順](docs/team-integration.md)を参照してください。後段の旧Phase計画や設計ドラフトより、この現行仕様を優先します。NFCの申請作成契約は維持しています。

**正式承認で自転車を確保し、ロック側の学生証タッチを照合してから解錠命令を発行する方式へ変更しました。**
承認の応答は`lock_command: null`と`next_action: "tap_card"`です。[現行フロー・ハード担当向けI/F](docs/card-touch-unlock.md)を参照してください。

## 現在動作する機能

- Node.js + ExpressによるHTTPサーバー
- SQLiteマイグレーションと開発用seed
- `devices`によるNFC端末認証
- `nfc_cards`によるカードUIDと学生の対応付け
- カードの有効化・無効化・再発行を扱えるDBとサービス
- `POST /api/requests`による`requesting`申請の作成
- `(device_id, client_request_id)`による冪等処理
- 借り手1人につき進行中申請1件のDB制約
- Mock NFCクライアント
- 既存v0.2のスマホ画面、Bike03、仮想LIGHT / UNLOCK
- 仮想AtomS3によるHTTPポーリングと完了通知

## 現在のAPI

| メソッド | パス | 用途 |
| --- | --- | --- |
| `POST` | `/api/requests` | 認証済みNFC端末から貸出申請を作成 |
| `GET` | `/api/health` | DB・シリアル接続状態 |
| `GET` | `/api/requests/:id` | 作成元NFC端末による最新状態取得 |
| `POST` | `/api/requests/:id/cancel` | 端末・カード認証付き募集取消 |
| `POST` | `/api/lock-reader/taps` | 個別端末認証とbike対応による学生証タッチ解錠 |
| `GET` | `/api/line/requests` | LINEサービス向け募集中一覧 |
| `GET` | `/api/line/events` | LINEサービス向けイベント差分 |
| `POST` | `/webhooks/line` | サービス認証・公式署名付きイベント転送 |
| `POST` | `/api/requests/:id/approve` | 単一承認イベント転送 |
| `GET` | `/api/bikes` | 既存v0.2のBike03情報取得 |
| `POST` | `/api/bikes/03/light` | 開発用LIGHTコマンド発行 |
| `POST` | `/api/bikes/03/unlock` | 開発用UNLOCKコマンド発行 |
| `GET` | `/api/bikes/03/command` | 開発用pendingコマンド取得 |
| `POST` | `/api/bikes/03/commands/:commandId/complete` | 開発用完了通知 |
| `GET` | `/api/bikes/03/commands` | 開発用コマンド履歴 |

既存v0.2の直接コマンドAPIとWeb画面は既定で無効（404）です。非本番で`ENABLE_VIRTUAL_BIKE=true`を明示した隔離環境のみ利用できます。

## 必要環境

- Node.js 18以上
- npm
- macOS、Linux、またはWindows

調査・テスト環境はNode.js `v22.22.3`、npm `10.9.8`です。

## インストールとDB初期化

```bash
npm install
npm run db:migrate
npm run db:seed
```

DBは既定で`data/mobaeco.sqlite`に作成されます。変更する場合は`DATABASE_PATH`を設定します。SQLite実データはGit管理対象外です。

開発用seed：

| 種類 | 値 |
| --- | --- |
| NFC端末 | `nfc-reader-01` |
| FeliCa IDm | `012E5CE5D8107067` |
| 借り手 | `S1001` |
| 貸し手 | `S1002` |
| 自転車 | `B003` |

seedの端末キーは開発専用のダミー値です。本番資格情報として使用しないでください。キーはDBへscryptハッシュで保存され、平文キーやハッシュをログ出力しません。

## サーバー起動

HTTPS reverse proxyまたはトンネルを使う通常起動：

```bash
npm start
```

既定では`0.0.0.0:3000`で待ち受けます。稼働確認は`/api/health`です。旧Web画面を試す場合は`ENABLE_VIRTUAL_BIKE=true npm start`として、PCから`http://localhost:3000`、隔離テスト用Wi-Fiのスマホから`http://MacBookのローカルIP:3000`へアクセスします。

## Mock NFCクライアント

ローカルHTTP検証は、隔離されたテストネットワークとダミー認証情報だけに限定します。

ローカルHTTP検証では、サーバー側とMock側の両方へ明示設定します。

```bash
# ターミナル1（隔離テストネットワーク限定）
ALLOW_INSECURE_NFC_HTTP=true npm start

# ターミナル2
ALLOW_INSECURE_NFC_HTTP=true npm run mock:nfc
```

Mockは次を送ります。`student_id`は送信しません。

```http
POST /api/requests
X-Device-Id: nfc-reader-01
X-Device-Key: <development dummy key>
Content-Type: application/json
```

```json
{
  "card_uid": "012e5ce5d8107067",
  "action": "request",
  "client_request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

環境変数は[.env.example](.env.example)を参照してください。`.env`は暗黙には読みません。`BACKEND_ENV_FILE=.env.backend npm start`で明示指定できます（既存の環境変数優先）。通知資格情報をmainへ渡すと自動配信が始まるため、手動試験の設定と分離してください。[設定・バックアップ・状態確認CLI](docs/backend-operations.md)を参照してください。

## HTTPS方針

NFC通信はMVPでも原則HTTPSです。既定ではHTTPの`POST /api/requests`を`426 HTTPS_REQUIRED`で拒否します。本番では常にHTTPS必須で、`ALLOW_INSECURE_NFC_HTTP=true`を指定してもHTTPを許可しません。

MacBookをHTTPSトンネルやローカルリバースプロキシの背後で動かす場合は、信頼するプロキシだけを`TRUST_PROXY`へ設定してください。任意のクライアントから来た`X-Forwarded-Proto`を無条件に信用してはいけません。

HTTPを許可できるのは次の条件をすべて満たす開発確認だけです。

- 非本番環境
- 隔離されたテストネットワーク
- ダミー端末キーとテストカード
- Mock側で`ALLOW_INSECURE_NFC_HTTP=true`を明示

## NFC端末認証と冪等性

- Backendが`X-Device-Id`で`devices`を検索する
- `X-Device-Key`を保存済みscryptハッシュと定数時間比較する
- 未登録、無効、キー不一致はいずれも`DEVICE_AUTH_FAILED`とする
- `card_uid`からBackendがstudent IDを解決する
- IDmは`:・-`を除去して大文字16桁へ正規化し、先頭0とバイト順を保持する
- 同じ端末・同じ`client_request_id`・同じ内容の再送には初回レスポンスを返す
- 同じ冪等キーで内容が異なる場合は`IDEMPOTENCY_CONFLICT`
- 別のIDで同じ学生が再申請した場合は`ACTIVE_REQUEST_EXISTS`

一般的なNFCカードのUIDは複製可能な場合があります。UIDを単独で強い本人認証とはみなさず、端末管理、カード失効、学校の運用ルールと組み合わせます。

## テスト

```bash
npm test
```

NFC申請・認証・再送、承認・取消競合、LINE署名・通知、USB結果・再接続・返却、カードタッチ前の送信抑止、本人照合、再起動後の重複防止、LINE公開範囲・登録車取得・管理者紐付けを検証します。さらに、HTTP申請からMock返却までの通し試験、開発API隔離、設定検証、WALバックアップ・別DB復元・上書き拒否を追加しました。

コード整形は`npm run format`、確認のみは`npm run format:check`で行います。Prettierは開発用依存のみです。
[全体レビューと整理内容](docs/code-review.md)に変更範囲と残る設計課題を記録しています。

## 仮想AtomS3

既存v0.2の仮想Atomは別ターミナルで起動できます。

```bash
npm run atom
```

これは将来のUSBシリアル中継とは別の開発用HTTPポーリングです。

## 仕様書

- [LINE接続の合意済み方針・借り手専用CLI・追加契約案](docs/line-contract-proposal.md)

- [アーキテクチャ設計](docs/architecture.md)
- [データベース設計](docs/database-design.md)
- [HTTP API仕様](docs/api-spec.md)
- [NFC ↔ Backend確定I/F仕様・接続試験](docs/nfc-backend-api.md)
- [NFC・LINE・USB・ESP-NOW連携仕様](docs/integration-spec.md)
- [チーム合意が必要な未決事項](docs/open-decisions.md)
- [LINE担当向け共有事項・現在の申請配信状況](docs/line-handoff.md)
- [LINE正式承認のHTTPS接続・本人紐付け・登録車取得・応答全例](docs/line-approval-connection.md)

## 現在不足している機能・未検証事項

- 公式Channel Secret・実LINE本人紐付け設定後の正式承認の接続試験
- 正式承認の実LINE接続、LINE初回本人確認と紐付け
- 手動再施錠センサーからの自発的返却通知
- ESP-NOW・AtomS3実機統合
- 管理者向けカード登録・無効化・再発行API（LINE試験利用者の管理者登録CLIは追加済み）
- 承認後の機器故障に対する管理者復旧の運用合意（強制状態変更は未提供）

貸出状態遷移とNFC申請契約は維持しています。LINE転送時のraw署名とサービスBearer、募集ポーリング、USB必須IDはチーム連携仕様で具体化しています。

## 開発Phase

1. **Phase 1（完了）**：既存調査、構成・API・DB・連携仕様
2. **Phase 2（申請基盤実装済）**：SQLite、利用者・カード・端末、自転車、貸出申請
3. **Phase 3（実装・自動テスト済）**：承認・取消・状態遷移・競合制御
4. **Phase 4（Backend・Mock実装済）**：USBアダプター、JSON Lines、Mock。実機・ESP-NOWは未検証
5. **Phase 5（次の主作業）**：担当間契約の確認、LAN・LINEグループ・NFC・USB実機統合
6. **Phase 6（一部先行済）**：自動異常系テスト、イベントログ、統合手順。実機異常系と運用は未完了
