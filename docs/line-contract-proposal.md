# LINE正式接続：合意済み方針と具体契約案（2026-11-11）

確認セッションは名称をconfirmation_idへ統一し、形式検証・承認fingerprint追加・旧receipt互換のソース対応を行いました。[実装契約・回帰範囲](line-confirmation-contract.md)を優先してください。以下のconfirmation_session_idや「fingerprintに含まない」は当初提案の記録です。稼働gatewayは未反映です。

## 状態と変更範囲

LINE担当のモック65件成功は担当からの報告です。こちらでLINEコードの検証や稼働反映はしていません。
FORMAL_LINE_FLOW.md（2026-11-11版）を参照しましたが、追加修正後のファイル・コードは未受領です。
今回は借り手専用管理者CLIと独立テストを追加します。以下の状態通知・状態取得・確認セッションは**具体案であり未実装・未合意**です。
対象申請・通知イベント10・実利用者紐付け・稼働設定には触れず、実通信は行いません。

## 合意済みの方針

- bikes空配列は「現在、貸出可能な登録自転車がありません。未登録の場合は管理者へお問い合わせください。」という共通案内。理由コードは追加しない。
- 試験時の本人連携は管理者確認後のローカルCLI。公開本人連携APIと混同しない。
- 状態変化はBackend→LINEのpushを基本、状態取得は確認・通知漏れ補完。定期ポーリングは前提としない。
- 初期結合は1イベント限定。複数イベント対応は残件。公式本文を分割・再JSON化しない。
- 承認・取消等の成功再送は初回JSON再現。list_bikesは再送時点の最新結果。
- approvedは予約確定・タッチ待ち。承認時はlock_command:null / next_action:tap_card。実unlock_success後のみrented。

## 実装済み：借り手だけの管理者紐付け

管理者は学校側の正規学生情報と、本人のLINEアカウント所有を独立に確認します。
ユーザーが入力したstudent_idだけで紐付けてはいけません。確認に使う学校手続・本人確認証跡の保管は運用合意が必要です。
LINE担当は検証済み公式イベントのsource.userIdを安全に取得し、管理者がその学生本人のアカウントであることを確認します。
値はチャット・Git・ログに掲載せず、安全なローカルファイルで受け渡します。

Git対象外ファイル例 `.env.line-borrower`（JSON形式、権限600）：

```json
{
  "student_id": "確認済みの既存学生ID",
  "line_user_id": "Uに続く32桁の16進数の実LINEユーザーID",
  "verified_by_operator": true
}
```

```bash
npm run db:backup -- ./data/before-borrower-link-unique.sqlite
npm run line:link-borrower -- .env.line-borrower
```

既存active学生だけを対象にします。新規学生・車は作りません。表示名・カード・所有車・申請・通知は変えません。
同一紐付けの再実行は更新なし。他人のLINE ID、既存の別LINE紐付け、無効/未登録学生、未確認入力は拒否します。
デモの紐付けもこのCLIでは置換不可。貸し手登録は従来のline:link（所有車必須）を使用します。
verified_by_operatorは本人確認を代行するフラグではなく、確認済みの管理者入力という前提条件です。
借り手の確認済み実LINE情報がまだ渡されていないため、実DBの借り手登録は実施していません。
公開の/api/links/verifyは引き続き未実装・無効のままです。

検証はtest/line-borrower-link.test.jsで、車なし登録・同一入力再実行・未知/無効学生拒否・他人のLINE競合・既存紐付け上書き拒否・不正入力・独立DBでのCLI起動・不正JSONの秘密非表示を確認しました。

## 提案：状態通知push

送信先はLINE担当の既存 `POST /integration/backend/events` を拡張する案です。
HTTPS、Content-Type:application/json、Authorization:Bearer <BACKEND_EVENTS_TOKEN>。
LINE_SERVICE_TOKENや端末キーは流用しません。既存request.created JSONとイベント10の本文・記録は変更しません。

新規通知例（プレースホルダー。実イベントの送信指示ではありません）：

```json
{
  "event_id": "evt_<UUID>",
  "event_type": "request.approved",
  "occurred_at": "2026-11-11T00:00:00.000Z",
  "recipient": { "type": "line_user", "line_user_id": "<本人連携済み借り手のLINE ID>" },
  "request": {
    "request_id": "req_<UUID>",
    "borrower_display_name": "<通知用表示名>",
    "status": "approved",
    "bike_id": "B003",
    "updated_at": "2026-11-11T00:00:00.000Z"
  },
  "next_action": "tap_card"
}
```

- 宛先はBackendがrequest.borrower_student_id→active userのline_user_idで解決し、LINE担当がpush配信。学生IDをLINEへ渡して宛先を推測させない。
- 借り手の未連携は無関係な相手へ代替送信せず、未配信を記録。後日の紐付けで過去通知を自動送信しない。再通知の確認手順を別途決める。
- request.approved：借り手へタッチ待ち。操作した貸し手には「貸出を承認しました。借り手の学生証タッチ待ちです。」
- request.rented：実解錠成功後だけ。status:rented / next_action:null。
- request.returned / request.cancelledも同じ宛先の候補。初回採用範囲はLINE担当と確認。
- DB状態変更と同じトランザクションでoutboxへ通知本文・宛先・IDを固定する。再送では同じID・本文・宛先を使用。
- 新規状態通知は環境をまたぐ衝突を避けUUIDを使用。既存数値event_idは変換しない。
- 同ID・同本文は初回202 duplicate:false、再送200 duplicate:true。同ID・異本文は409として停止する案。
- 202はLINEサービスの受付を表し、個人トーク表示完了ではない。LINE側も永続outboxと固定retry keyで重複配信を防止。
- Backend再送は既存方針と同じく通信失敗/429/5xxで上限付き、400/401/409は停止・確認。再配信CLIと状態表示も新規通知用に対応が必要。
- 既存送信処理はrequesting以外をskipするため、そのまま流用して状態通知を実装済みとは扱わない。
- 個人情報保管期間、同一LINE ChannelのuserIdであること、ブロック等で個別pushできない場合の対応、順序逆転時のUIは合意事項。

## 提案：本人の状態取得

既存 `POST /webhooks/line` へ新しい公式postbackをrawのまま転送する案です。
認証は専用Bearer＋公式X-Line-Signature、source.userIdからactive学生を解決。

```json
{"action":"get_request","request_id":"req_<UUID>"}
```

```json
{
  "results": [{
    "request": {
      "request_id": "req_<UUID>", "status": "approved", "bike_id": "B003",
      "created_at": "2026-11-11T00:00:00.000Z", "updated_at": "2026-11-11T00:00:00.000Z"
    },
    "next_action": "tap_card"
  }]
}
```

借り手本人または確定済み貸し手だけ参照可。無関係/存在しない申請は404、未連携は403、認証/署名不正401、形式不正400。
承認前の候補貸し手には個別状態を公開しない。全状態で参照でき、返却済み/取消済みも対象（保存期間は別途）。
参照再送は最新状態を返す。履歴を巻き戻さない。定期取得ではなく明示的な「状態確認」操作に使う。
通知受信だけで物理解錠状態を推測しない。複数通知の古いupdated_atでUIを巻き戻さない。
LINE→Backendは暫定5秒timeout、429/5xx/通信失敗は既存UIの再試行導線で扱い、確定動作を推測しない。採用値は合意待ち。
get_requestは**まだ実装していません**。既存NFC GET /api/requests/:idは作成元端末用であり、LINE本人用APIの代用ではありません。
GET /api/line/eventsはサービス全体の差分で、最新requestのJOINを含むため不変の状態通知本文とは別物です。

## 提案：古い登録車確認ボタンの停止

新しく生成する公式postbackに対象申請とランダムな確認セッションを固定する案です。

```json
{"action":"list_bikes","request_id":"req_A","confirmation_session_id":"<ランダムな確認セッションID>"}
```

承認postbackも同じ対象・セッションを保持し、bike_idを追加します。
LINE担当が検証済みsource.userId＋request_id＋session ID＋有効期限を管理し、A→Bと操作した後のAセッションを無効化します。
古いAのボタンでBの確認画面を生成してはいけません。古い/別人/失効セッションはBackend転送前に停止します。
リスト応答から承認ボタンを作る際も、送信開始時と応答到着時の両方でセッションが有効か確認します。
通信中に新しい「貸せます」を押すケースも検証してください。

**Backendの現行コードとの互換性：** list_bikesの追加request_id/session IDは現状読まず、本人のavailable車だけを返します。
approveではrequest_id/bike_id/本人/状態/所有権を検証しますが、session IDの真正性・有効期限は検証しません。
session IDは認証トークンではありません。LINE側のUIコンテキスト検証責任です。Backendでも必須化するなら別契約・実装が必要です。
現行の冪等fingerprintは本人・操作・request_id・bike_id等の業務項目のみで、session IDやreplyToken等は含みません。
LINE側が同ID・session変更を拒否するのは、Backendより厳しいUI安全対策として許容します。

応答喪失後の**同じ承認イベント**は、初回送信内容を固定したまま再確認できるよう、成功/送信試行済みreceiptと新規操作のセッション期限を分けます。
古いボタンによる新しい承認操作と、過去に送信済みの同イベント再配達を混同しないでください。
公式raw bodyとその配達に対応する署名は変更せず、list_bikesイベントをapproveに書き換えません。

### LINE担当の検証責任

- A→B→A古ボタン、別ユーザーのセッション、期限切れ、空/複数車の旧bike無効化。
- A取得応答待ち中のB選択、古い取得応答でBの画面を書き換えない。
- 新規承認は現在のセッションのみ、応答喪失後の同イベントは固定した初回対象のみ再確認。
- 複数eventsは現状422・未転送、空eventsは200。本文分割は行わない。

### Backendの検証責任

- 署名・サービス認証・本人紐付け・所有権・available・競合・申請状態を最終検証。
- 承認時は命令なし、タッチと実unlock_successまでrentedにしない。
- 成功操作の同event ID/同業務内容は初回JSON、内容変更は409。list_bikesは最新値。
- 1件の初期試験後も複数eventsの正式契約は残件。Backendの現行batch処理を変更したとは扱わない。

## 試験順序とゲート

1. LINE側古ボタン修正・65件以降の検証結果を共有し、この提案の追加項目・責任分担を合意。
2. 借り手本人の確認済みLINE情報を安全に受領し、バックアップ後にCLI登録（未実施）。
3. LINEの有効化設定・秘密共有・HTTPS稼働・対象申請・承認後後処理を両担当で確認。
4. 実通信開始の合図後、まず単一イベントのlist_bikesでB003を取得。A/B不具合は独立Mockで先に確認。
5. 対象申請の正式承認は別途合図後だけ実施し、approved・命令0件・タッチ待ちを確認。
6. 借り手状態push・状態取得は契約合意・両側実装・Mock検証後に別途試験。rentedを実申請へ強制設定しない。
7. 通知イベント10の追加配信・取消・新規申請は本手順に含めず、個別合意まで保持。
