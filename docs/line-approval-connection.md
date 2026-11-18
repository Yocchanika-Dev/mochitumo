# LINE正式承認：接続準備と転送用本文

公開版では実際の接続先と利用者・申請の識別情報を例示値に置き換えています。

confirmation_id追加後の形式・承認冪等性・旧receipt互換は[確認セッション契約](line-confirmation-contract.md)を参照してください。ソース対応と稼働反映・実接続試験は別です。

追加の合意済み方針、借り手専用CLI、状態通知/状態取得と確認セッションの具体案は[LINE契約案](line-contract-proposal.md)を参照してください。案の段階のAPI・通知は未実装です。

## 2026-11-11 設定更新

共有された公式Channel SecretをGit対象外・権限600の.env.line-channelへ保存し、LINE gatewayを起動しました。
S1002のデモLINE紐付けを、明示許可された個人LINEアカウントへ置換済みです。所有車B003はavailableのままです。
HTTPS経由でhealth 200、認証なし401、不正署名401、署名付き空events 200、認証付き募集一覧200、旧unlock API 404を確認しました。
これは接続準備の確認であり、実LINEのlist_bikes・正式承認は未試験です。以降の「Secret未設定・本人紐付け未受領・503」は更新前の記録です。
対象申請はrequesting、通知イベント10はdelivered・attempts 2を保持し、承認・取消・追加送信は行っていません。
一時URLの変更に合わせ.env.line-backend-connectionも更新済みです。Mac停止・スリープ・プロセス終了で接続できなくなります。

## 現在の接続先と資格情報

BackendのLINE専用HTTPS入口：

```text
https://line-backend.example.invalid
```

これはBackend側の入口です。募集通知の送信先（LINE側ngrok URL）とは別です。
ngrokが127.0.0.1:3001へ転送し、LINE連携ルートとhealthだけを公開します。
静的ページ、NFC申請、仮想Bike03解錠APIは公開しません。LAN側3000は既存どおりです。
ngrokはローカルrequest inspectionを無効にして起動しています。
参考：[ngrok公式のエージェント起動手順](https://ngrok.com/docs/gateway/endpoints/agent-cli-quickstart)。

URL・LINE_SERVICE_TOKENはGit対象外の`.env.line-backend-connection`へ保存しました。
トークンはBackend側で暗号学的乱数から発行した専用値です。本文・ログ・Gitへは載せません。
共有ファイルは権限600です。LINE担当へは安全な個別のファイル共有手段で転送してください。
BACKEND_EVENTS_TOKENやNFCキーとは異なります。

公式LINE_CHANNEL_SECRETは未設定です。LINE担当から安全に受け取り、
Git対象外の`.env.line-channel`へ`LINE_CHANNEL_SECRET=...`として設定します。
チャットへ値を貼る必要はありません。入力後にgatewayだけ再起動して設定を読み込みます。
このsecretはLINE側で生成・管理している公式Channelのものを使います。Backendが別の乱数を発行するものではありません。

現時点の公開確認：

- GET /api/health → 200
- 認証なしPOST /webhooks/line → 401
- 専用Bearer付きGET /api/line/requests → 200
- 専用Bearer付きPOST /webhooks/line → 503 LINE_NOT_CONFIGURED（公式Channel Secret未設定のため）
- POST /api/bikes/03/unlockおよびGET / → 404

承認系が503のままでは正式承認試験はできません。これは403（本人未連携）や400（本文不正）の前段です。
Macの停止・スリープ、ngrok停止・URL変更で接続できなくなります。起動確認してから試験します。

## テスト貸し手の本人紐付け・所有車登録

現DBではB003の所有者はS1002（デモ）です。実際のテスト貸し手のLINE userIdはまだ受領していません。
S1002/B003を実テストに使うか、新しい確認済みの貸し手・bikeを登録するか、指定が必要です。
student_id S_TEST_BORROWERは借り手です。この申請を自分で承認することはできません。

公開の本人登録APIはまだありません。結合試験では管理者が本人・所有権を確認して登録するCLIを使います。
例はプレースホルダーです。実LINE userIdはGit対象外のローカルJSONファイルに保存します。

```json
{
  "student_id": "確認済みの貸し手学生ID",
  "name": "新規利用者の表示名",
  "line_user_id": "確認済みの実LINE userId",
  "bike_id": "所有する自転車ID",
  "verified_by_operator": true,
  "replace_demo_link": false
}
```

```bash
npm run line:link -- .env.line-identity
```

このJSONは.envの構文ではありません。.env.line-identityというGit対象外のファイル名にJSONを保存します。
管理者の本人・所有権確認済み情報を扱うためのローカルCLIであり、フラグだけで本人確認が完成する公開APIではありません。
既存の他人のLINE紐付け・自転車所有者は上書きせず、1人1台を保証します。
新規利用者と新規bikeは指定情報で作成します。既存利用者の表示名や既存bikeのavailabilityは変更しません。
S1002のU_DEMO_LENDERだけを実LINE IDに置換する場合も、明示的なreplace_demo_link:trueが必要です。
今回、実データへの登録はまだ実行していません。

## 貸し手本人の利用可能bike_idを取得する方法

LINEのpostback.dataを次にします。

```json
{"action":"list_bikes"}
```

その公式Webhookのraw bodyとX-Line-Signatureを、そのままPOST /webhooks/lineへ転送します。
Authorization: Bearer <LINE_SERVICE_TOKEN>も必要です。
Backendが署名済みsource.userId→student_id→所有するavailable車を解決します。
学生IDや所有者をクライアントが自由に指定する取得APIではありません。

200成功JSON：

```json
{
  "results": [
    {
      "bikes": [
        {"bike_id":"B003","availability":"available"}
      ]
    }
  ]
}
```

利用可能車がなければbikes:[]です。この取得で貸出状態やcommandは変わりません。
正式承認では、取得したbike_idをapprove postbackへ入れてください。
GET /api/me/bikesは依然ドラフトで、現在の実装入口はこの署名付きpostback方式です。

## 共通の転送認証

```text
POST /webhooks/line
Content-Type: application/json
Authorization: Bearer <LINE_SERVICE_TOKEN>
X-Line-Signature: <公式Webhookの署名>
```

署名検証済みでも、raw bodyをJSONで再生成せず転送します。Backendも公式Channel Secretで再検証します。
LINE Platformからこの入口へ直接送るのではなく、LINE担当サービスが専用Bearerを加えて転送します。

## 正式承認

postback.data：

```json
{"action":"approve","request_id":"req_00000000-0000-4000-8000-000000000001","bike_id":"B003"}
```

正式承認時は借り手と自転車を確保するだけです。ここでは解錠命令を作りません。
ロック側の学生証タッチを確認してから解錠命令を発行します。

200成功JSONの全例（日時・IDは例示）：

```json
{
  "results": [
    {
      "request": {
        "request_id": "req_00000000-0000-4000-8000-000000000001",
        "borrower_display_name": "テスト借り手",
        "status": "approved",
        "bike_id": "B003",
        "created_at": "2026-11-04T05:40:19.381Z",
        "updated_at": "2026-11-04T07:00:00.000Z"
      },
      "lock_command": null,
      "next_action": "tap_card"
    }
  ]
}
```

これは応答の例であり、対象申請を実際に承認した記録ではありません。
LINE画面では「対象自転車のリーダーに学生証をタッチしてください」と案内してください。
実機のunlock_successまでrentedには変更しません。

## 本人取消

同じPOST /webhooks/lineへ、借り手本人の公式postbackを転送します。

```json
{"action":"cancel","request_id":"req_00000000-0000-4000-8000-000000000001"}
```

本人は署名済みsource.userIdとDBの対応で決定します。student_idをBodyに指定して代行はできません。
借り手本人かつrequestingの時だけrequesting→cancelledを許可します。
approved以降の通常取消は409です。他人の申請は404です。
借り手S_TEST_BORROWERのLINE紐付けも、LINEから取消を試す前に別途必要です。

成功200の全例：

```json
{
  "results": [
    {
      "request_id": "req_00000000-0000-4000-8000-000000000001",
      "status": "cancelled",
      "updated_at": "2026-11-04T07:00:00.000Z"
    }
  ]
}
```

承認後の取消、承認競合、取消済みの別イベントによる再承認は409 INVALID_STATEです。
成功済み操作を同じwebhookEventId・同じ内容で再送した場合は200で初回JSONを再現します。
同じIDの内容変更は409 IDEMPOTENCY_CONFLICT。募集通知event_id 10とは別のIDを扱います。
承認と取消の競合は先に確定したトランザクションだけを採用します。

## gateway・トンネルの起動

```bash
# 公式Channel Secret設定後の起動例
set -a
source .env
source .env.line-channel
set +a
npm run line:serve
```

別のターミナル：

```bash
ngrok http http://127.0.0.1:3001 --inspect=false --log=false
```

既に起動中の場合は二重起動しないでください。設定変更時はgatewayプロセスだけを再起動します。
既存のLANサーバー（3000）と通知workerはこのCLIでは再起動・起動しません。

## 残っている入力と確認

- テスト貸し手のstudent_id・実LINE userId・所有bike_idと、本人/所有権確認。
- 公式Channel Secretの安全な受領・ローカル設定。
- 設定後のlist_bikes→正式承認の実LINE結合試験。
- 借り手本人取消を別途試す場合は、借り手のLINE本人紐付けも必要。
