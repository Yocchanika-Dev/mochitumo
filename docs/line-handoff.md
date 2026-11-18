# LINE担当への共有：通知I/Fと承認関連API

公開版では実際の接続先と利用者・申請の識別情報を例示値に置き換えています。

この文書はBackendの実装とDBを確認した結果です。通知の形式・初回受信・再送は結合試験済みです。
新しい本人連携方式や未実装APIまで合意済みとは扱いません。LINE担当による採用確認が必要です。
秘密トークン・Channel Secretは記載していません。

**解錠フロー変更済み：正式承認では自転車の確保のみ行い、ロック側の学生証タッチ確認後に解錠命令を発行します。**
新規承認の成功JSONは`lock_command: null`、`next_action: "tap_card"`です。
[学生証タッチ解錠の現行仕様](card-touch-unlock.md)を参照してください。

## 1. Core2実機の申請確認

NFC担当からCore2で新規201→同一UUID・同一本文で200の成功報告を受領しました。
Backendでも対象申請・初回結果保存は1件だけで、通知イベントは1件です。

| 項目 | 確認時点の値 |
| --- | --- |
| request_id | req_00000000-0000-4000-8000-000000000001 |
| 借り手 | S_TEST_BORROWER / テスト借り手 |
| request状態 | requesting |
| event_id | `10`（文字列） |
| event_type | request.created |
| 配信状態 | delivered |
| 送信回数 | 2 |
| 初回応答 | 202 / duplicate:false |
| 同一本文の再送応答 | 200 / duplicate:true |
| グループ表示 | 初回1件・再送後も1件のままをユーザー経由で確認済み |

現在のBackendは手動送信モードで起動しており、新しい申請の自動配信はまだ有効ではありません。
LINE側の受信準備完了連絡を受け、対象イベント10を初回送信しました。
グループに1件表示を確認後に同じID・同じ本文を再送し、200・duplicate:trueを確認しました。
再送後も募集が増えていないことをユーザー経由で確認済みです。
新規申請・承認・取消は行っていません。

## 2. 募集通知I/F：結合試験済みの契約

方向：Backend → LINE担当の受信サービス。

```text
POST https://line-receiver.example.invalid/integration/backend/events
Content-Type: application/json
Authorization: Bearer <BACKEND_EVENTS_TOKEN>
```

受信先はngrokの開発用一時URLです。URL変更時はBackendのGit対象外.envを更新します。
共有トークンは設定済みです。LINE_SERVICE_TOKENやNFC端末キーとは別の資格情報です。
試験時にはLINE側サーバー・ngrok・Macが起動中であることを担当間で確認します。

今回のDBに保存した固定本文：

```json
{
  "event_id": "10",
  "event_type": "request.created",
  "request": {
    "request_id": "req_00000000-0000-4000-8000-000000000001",
    "borrower_display_name": "テスト借り手",
    "status": "requesting"
  }
}
```

- JSONはこの1イベントを直接送ります。events配列で包みません。
- event_idとrequest_idはBackendが発行します。LINE側で生成・変更しません。
- 同一イベントの再送はevent_idも本文も変更しません。
- LINE側は初回を202、同一イベントの重複受付を200として処理し、グループ表示を重複させません。
- 以前のevent_id `8`では初回202・グループ表示・同本文再送200・重複表示なしを確認済みです。今回の`10`の配信成功を意味するものではありません。
- 現時点でpushする種別はrequest.createdだけです。取消・承認等の差分は既存ポーリングで取得できます。
- event_idはDB内の連番を文字列化したものです。同一DB内の一意性が前提で、別環境・DB作り直し時は接続先/ID空間の分離を別途合意します。

Backend側の送信・再配信方法（Backend担当が実行）：

```bash
set -a
source .env
set +a
npm run events:send -- 10
```

初回も再配信も同じコマンドです。新しい申請を作ったり、DBの本文を書き換えたりしません。
接続失敗・429・5xxは常駐worker有効時に最大5回自動再試行。400/401等では停止して設定・契約を確認します。
未配信の間に募集終了したイベントはskipします。送信失敗で申請状態は巻き戻しません。
今回のような手動モードでは、上記CLIを実行するまで送信されません。

自動化する場合は.envを環境へ読み込んでnpm startする必要があります。.envは自動読込しません。
申請ごとの手動送信を続けるか、常駐workerを有効にするかを結合試験の進め方として合わせます。

## 3. LINE → Backendの認証と接続先

BackendのLINE専用HTTPS入口：`https://line-backend.example.invalid`（2026-11-11更新）。公式SecretとS1002/B003の本人・所有車設定は完了済み。詳細・確認結果は[line-approval-connection.md](line-approval-connection.md)冒頭を参照してください。
BackendのLAN入口は`http://192.0.2.10:3000`です。公開側はLINEルートのみの別入口を使います。
第2節のngrok URLはLINE側の受信先であり、Backendの公開URLとは別です。
専用トークン共有用ファイル・公式Channel Secretの設定待ち状態は[接続準備資料](line-approval-connection.md)を参照してください。
HTTPは隔離されたテストLANとダミー資格情報に限定します。本番相当の承認試験ではHTTPS経路が必要です。

LINE担当が受信した公式WebhookをBackendへ転送する契約：

```text
POST /webhooks/line
Content-Type: application/json
Authorization: Bearer <LINE_SERVICE_TOKEN>
X-Line-Signature: <公式Webhookの署名>
```

公式raw bodyを変更せず転送します。BackendでもChannel SecretでHMAC-SHA256を検証します。
LINE担当はbodyをJSONとして再シリアライズしないでください。署名が一致しなくなります。
Backendは署名済みsource.userIdをusers.line_user_idへ照合します。任意のstudent_id/userId指定だけでは本人操作になりません。
LINE_SERVICE_TOKENと公式Channel Secretの安全な設定・共有は、募集通知のBACKEND_EVENTS_TOKEN設定とは別に必要です。

## 4. 本人連携・登録車取得・承認・本人取消の実装状況

| 機能 | 現在の入口 | 実装状況・確定条件 |
| --- | --- | --- |
| LINE本人連携 | 連携登録用HTTP APIなし | **未実装・方式未合意**。DBのline_user_id対応のみ存在。学生ID入力だけで本人連携させない |
| 自分の利用可能自転車取得 | POST /webhooks/line、action:list_bikes | **実装済み**。署名済み本人のavailable車だけ取得。GET /api/me/bikesは引き続き未実装 |
| 正式承認 | POST /webhooks/line、またはPOST /api/requests/:id/approve | **実装済み、実LINE結合未確認**。署名付きpostback。bike_idはLINE側が送り、Backendが所有権・availableを検証 |
| LINE本人取消 | POST /webhooks/line、action:cancel | **実装済み、実LINE結合未確認**。署名済みLINE利用者が申請の借り手本人、かつrequestingのみ |
| NFC本人取消 | POST /api/requests/:id/cancel | **実装済み**。端末キー＋有効カード。LINEのBearer/userIdだけではこのルートは呼べない |

S_TEST_BORROWERは有効利用者・カード登録済みですが、LINE userIdは未紐付けです。
現在B003の所有者は開発用S1002です。seedのデモLINE IDを実際の貸し手の本人確認に使わないでください。
貸し手1人につき登録車最大1台はDB制約で保証しますが、bike_idをBackendが省略補完する契約へは変更していません。

### 登録車を取得するpostback

```json
{"action":"list_bikes"}
```

公式署名付きraw bodyをPOST /webhooks/lineへ転送すると、署名済みsource.userIdの所有するavailable車だけを返します。
応答例は`{"results":[{"bikes":[{"bike_id":"B003","availability":"available"}]}]}`です。
本人連携済みの利用者で利用可能車がなければbikesは空配列です。

### 正式承認の送信例

postback.dataに入れるJSON：

```json
{"action":"approve","request_id":"req_00000000-0000-4000-8000-000000000001","bike_id":"B003"}
```

転送する公式Webhookの構造例（この例を再生成して公式署名を流用しない）：

```json
{
  "events": [
    {
      "type": "postback",
      "webhookEventId": "LINEが発行したイベントID",
      "source": {"userId": "本人連携済みの実LINE利用者ID"},
      "postback": {
        "data": "{\"action\":\"approve\",\"request_id\":\"req_00000000-0000-4000-8000-000000000001\",\"bike_id\":\"B003\"}"
      }
    }
  ]
}
```

専用承認パスでも同じ公式raw envelopeを受けます。簡略Body {event_id,bike_id}は受け付けません。
専用パスではeventsが1件・actionがapprove・request_idがパスと一致する必要があります。

成功200の構造例（この申請を実際に承認した結果ではありません）：

```json
{
  "results": [
    {
      "request": {
        "request_id": "req_00000000-0000-4000-8000-000000000001",
        "borrower_display_name": "テスト借り手",
        "status": "approved",
        "bike_id": "B003",
        "created_at": "ISO8601",
        "updated_at": "ISO8601"
      },
      "lock_command": null,
      "next_action": "tap_card"
    }
  ]
}
```

他の承認が先に成立した場合、別イベントIDで再承認した場合、取消済みの場合はいずれも409：

```json
{"success":false,"error":"INVALID_STATE","message":"募集中の申請だけ承認できます"}
```

同じ署名済みwebhookEventId・同じ操作内容で成功済みの承認を再送した場合は200で初回成功JSONを返します。
webhookEventIdはLINEの承認イベントIDです。募集通知のevent_id `10`とは別物です。
正式承認では借り手・自転車を確定するだけで、解錠命令は作りません。
LINE側は承認後「対象自転車のリーダーへ学生証をタッチしてください」と案内してください。
実機のunlock_successまでrentedにはしません。

### LINE本人取消の送信例

借り手の公式postback.data：

```json
{"action":"cancel","request_id":"req_00000000-0000-4000-8000-000000000001"}
```

同じPOST /webhooks/lineと認証を使用します。成功200：

```json
{"results":[{"request_id":"req_00000000-0000-4000-8000-000000000001","status":"cancelled","updated_at":"ISO8601"}]}
```

LINE取消・承認とも、webhookEventIdを再送時も維持します。
同じID・同じ操作内容の成功再送は200で初回JSONを再現し、命令や状態変更を重複させません。
同じIDで別の操作内容は409 IDEMPOTENCY_CONFLICTです。
承認と取消はSQLite IMMEDIATEで直列化し、先に成立した遷移だけを採用します。

主なエラー：401 SERVICE_AUTH_FAILED / INVALID_LINE_SIGNATURE、403 LINE_ACCOUNT_NOT_LINKED / BIKE_NOT_OWNED / SELF_APPROVAL、
404 REQUEST_NOT_FOUND / BIKE_NOT_FOUND、409 INVALID_STATE / BIKE_NOT_AVAILABLE / IDEMPOTENCY_CONFLICT。
承認済み・募集取消済み・別人の先行承認は現在共通409 INVALID_STATEです。
署名は正しくても未紐付けのS_TEST_BORROWERによるLINE取消は403です。本人連携の方式・実装が先に必要です。

## 5. LINE担当に確認・回答してほしい事項

1. 通知受信先・専用Bearer・上記固定JSON・文字列event_id・同本文再送202/200契約を今回も採用すること。
2. event_id 10の配信試験を行える稼働タイミングと、グループ表示の確認担当。
3. 公式Webhook raw body＋公式署名＋専用Bearer転送を採用すること、Backendへの到達経路。
4. 本人連携の確認手順・初回登録APIの方式（現時点では未実装）と実テスト用の貸し手・借り手。
5. 署名付きlist_bikesで取得したbike_idを、LINE側が承認postbackへ入れること。

未実装APIを新しく確定・実装する作業と、既存APIを共有する作業を分けて進めます。
