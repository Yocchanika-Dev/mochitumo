# LINE募集通知の結合テスト記録

公開版では実際の接続先と利用者・申請の識別情報を例示値に置き換えています。

## 確認できたこと

- 接続先と受信トークンをGit対象外の`.env`へ保存。ファイル権限は600。秘密値はこの文書に記載しない。
- migration005で新規push本文をLINE側の確定サンプルと同じ項目に変更。保存済みイベント本文は変更しない。
- 既存申請`req_00000000-0000-4000-8000-000000000002`を、端末・カード認証付き取消APIでcancelledへ遷移（200）。
- NFC申請API経由でS_TEST_BORROWER/テスト借り手の新しい申請を作成（201）。Core2実機からの送信ではない。
- event_id `8`をHTTPS受信APIへ送信し、初回202を受信。outboxにdeliveredとして保存。
- 自動テスト56件成功。

送信した固定本文：

```json
{
  "event_id": "8",
  "event_type": "request.created",
  "request": {
    "request_id": "req_00000000-0000-4000-8000-000000000003",
    "borrower_display_name": "テスト借り手",
    "status": "requesting"
  }
}
```

## 再送試験の経過・結果

LINEグループに募集が1件表示されたことをユーザー経由で確認済み。
その後、保存済みの同じevent_id `8`・同じ本文を再送したが、応答は期待する200ではなく404だった。
認証なしGETによる診断でもngrokから404 / ERR_NGROK_3200を確認した。
その後、LINE側から新URLを受領し、Git対象外.envの送信先だけを更新した（トークン変更なし）。
新送信先：https://line-receiver.example.invalid/integration/backend/events
保存済みevent_id `8`を再送し、HTTP 200を確認済み。
送信前後のbody_jsonとSHA-256を比較し、本文・request_idが不変であることを確認した。
最新送信状態はdelivered / last_http_status=200 / attempts=3。新しい申請は作成していない。
ユーザーからLINEグループの募集が増えていないことを確認済み。
初回202→グループに1件表示→同じイベント・本文を再送して200→重複表示なし、の結合試験は完了。
LINE側の内部重複判定ログ自体はBackend側では確認していない。
Core2の新規申請試験に向けた解除は、再送が404になった後、新URLで再送200を確認する前に実施した。
ユーザーの承認を受けて今回の申請をcancelledへ遷移した。
取消直後のS_TEST_BORROWERの未完了申請は0件。event_id `8`と固定本文・初回delivered_atは保持している。

サーバーは再起動済み。順序を制御するため、稼働プロセスにBACKEND_EVENTS_URL/TOKENを渡さず、
自動通知workerを無効にしている。`.env`の接続情報は手動送信CLIで使用した。

## 再送手順（実施済み）

```bash
set -a
source .env
set +a
npm run events:send -- 8
```

このCLIはDBに保存した同じID・同じ本文を再送する。URLが変わった場合はGit対象外.envだけを更新する。
再送200とグループ画面の重複表示なしを確認済み。追加の申請作成や再送は行っていない。
対象申請の取消は実施済み。自動通知workerの有効化は、担当間のタイミングを合わせて行う。

## Core2実申請による募集通知：event_id 10

- request_id：req_00000000-0000-4000-8000-000000000001
- student_id：S_TEST_BORROWER、通知用表示名：テスト借り手
- Core2実機で新規201→同一UUID・同一本文で200成功とのNFC担当報告を受領。
- Backendで申請・冪等レコード・通知イベントが各1件であることを確認。
- 初回通知：202・duplicate:false。LINEグループに今回の募集が1件表示されたことをユーザー経由で確認。
- 同じevent_id・DB保存済み本文で再送：200・duplicate:true。
- 再送後も今回の募集は1件のまま（増えていない）とユーザーから確認済み。
- outboxはdelivered、送信回数2。本文は送信前後の完全一致を確認した。
- この確認のための新しい申請作成・正式承認・取消は行っていない。

Core2申請→Backend通知生成→LINE表示→同一イベント再送→重複表示なしの試験は完了。
正式承認はこの通知試験とは別で、まだ実LINEから試験していない。
