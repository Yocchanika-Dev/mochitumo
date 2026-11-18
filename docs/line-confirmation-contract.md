# confirmation_id契約：Backend実装・回帰範囲

## 適用状況

2026-11-11：ソースと独立テストDBでの対応です。稼働gatewayの再起動・設定変更・実通信・対象申請操作・通知配信は行いません。
LINE担当のモック85件成功は担当報告として扱い、実Backend結合成功とは区別します。
この文書は確認セッションに関して以前の提案資料より優先します。状態push/get_requestは引き続き別の未実装契約案です。

## 形式

```json
{"action":"list_bikes","request_id":"req_mock_A","confirmation_id":"550e8400-e29b-41d4-a716-446655440000"}
```

```json
{"action":"approve","request_id":"req_mock_A","bike_id":"B_mock","confirmation_id":"550e8400-e29b-41d4-a716-446655440000"}
```

- list_bikes/approveのrequest_id、approveのbike_id：文字列、空白のみ不可、最大128文字（JavaScript文字列長）。勝手にtrim・大小文字変換しない。
- confirmation_id：ハイフン込み36文字のUUID v4。version桁4、variant桁8/9/a/bを検証。16進文字の大小文字は許容するが、fingerprintでは元の文字列を保持する。
- 型不正・null・空文字・長すぎる値・不正UUIDは400 INVALID_REQUEST。
- 未知キーは無視し、認証・認可・fingerprintの根拠にしない。
- 旧クライアントと成功receiptの互換性のためconfirmation_id未指定も許容。LINEの新しい正式フローでは必ず付ける。
- list_bikesは旧形式actionのみも許容。confirmation_idを付ける場合はrequest_idが必要。
- list_bikesのrequest_idは形式だけ確認する。対象申請の承認可否やsession有効性を保証する応答ではない。
- list_bikesは貸出状態・命令・operation receiptを変更しない。応答の形式はresults:[{bikes:[...]}]のまま。
- cancel/lockのpostback契約は変更しない。

## 承認の冪等性

公式webhookEventIdとsource=lineがreceiptキーです。成功済み操作は以下をfingerprint比較します。
本人student ID・action=approve・request_id・bike_id・指定されたconfirmation_id。

| 再送 | 応答 |
| --- | --- |
| 同event ID・同業務項目 | 200・初回成功JSON |
| 同event ID・request_id/bike_id/confirmation_id変更 | 409 IDEMPOTENCY_CONFLICT |
| confirmation付き成功後、同event IDでconfirmation削除 | 409 IDEMPOTENCY_CONFLICT |
| 旧confirmationなし成功後、同event IDでconfirmation追加 | 409 IDEMPOTENCY_CONFLICT |
| replyToken/deliveryContext/timestampだけ変更 | 初回成功JSON（各配達の正しい公式署名が必要） |
| 同じ承認を新event IDで操作し、既にapproved以降 | 409 INVALID_STATE |

成功していない操作のエラーreceiptは保存しません。従って「同IDなら何を送っても必ず409」ではなく、成功記録がある場合の保証です。
新規入力が不正形式ならfingerprint比較より前に400です。本文不正や署名・本人認証失敗を409へ変換しません。
list_bikesには成功JSONを固定するreceiptがなく、同ID再送でも最新の利用可能車を返します。内容変更を409とする責任はLINE側のイベント照合です。

## 既存receiptとの互換性

confirmation未指定では旧バージョンと同じキー順の入力JSONから同じSHA256を作ります。
既存fingerprint/response_json/created_atは更新しません。DB移行・バックフィルも不要です。
旧receiptと新形式を曖昧に一致させるfallbackはしません。同じ公式イベントを新形式に書き換えず、元の配達本文で再確認してください。
旧receiptの成功JSONが現在の成功形式と異なっていても、保存済み初回JSONをそのまま返します。UIがそれを現在状態として扱わないことも必要です。

## 責任分担と再配達

LINE：source.userId・対象申請・confirmation_id・10分期限・取得bike_idを取得前と結果適用前に照合。
A→B、同一申請の新session、別人、期限切れ後の古いボタン/古い取得再配達は転送前に停止。
送信済み承認の応答喪失だけは元イベントの再確認を許容し、元対象を保持。新しい確認対象へ結果を適用しない。

Backend：サービス認証・公式署名・active本人紐付け・申請状態・所有権・利用可能性・競合・receiptを最終検証。
confirmation_idはUI識別子で、期限やsession所有者をBackendで検証しません。古いUI防止はLINE側の責任です。
UI期限・新session開始・現在の貸出状態を理由に、成功receiptの再現を止めません。ただし現在の認証・本人紐付けは再度検証します。
承認済み応答の再現は現在状態の照会ではありません。
raw bodyとその配達に対応する公式署名を維持し、list_bikesをapproveへ書き換えたり、batchを分割・再JSON化したりしません。
初期結合は単一event。Backendの既存batch処理は今回変更しません。

承認成功はapproved・lock_command:null・next_action:tap_card。承認だけでは命令を作らず、実unlock_success後のみrentedです。

## 検証と次のゲート

test/line-confirmation.test.jsで、署名付きローカルHTTP・独立メモリDBを使い、形式境界・未知キー・各項目変更409・初回JSON再現・旧fingerprint互換・既存receipt不変・metadata再配達・新event再タッチ・本人失効・署名不正・命令未生成を確認します。
既存の貸出競合・カードタッチ・取消・USB結果テストも全体実行します。
実LINE側コードの回帰85件はこちらでは実行していません。

今回の検証結果：Backend全88テスト成功、失敗0。UUID末尾改行拒否とapproved中の新event再タッチ拒否を追加確認した対象7テストも成功。format:check成功。
変更ファイル：src/http/validation.js、src/line/webhook.js、src/rental/service.js、test/line-confirmation.test.js、および本契約への参照資料。DBスキーマ・マイグレーション・実データの変更はありません。

最終契約確認→試験対象/順序/承認後扱いの合意→gateway稼働反映→疎通→list_bikes→別途合図後に正式承認の順で進めます。
本作業は稼働反映・実通信・承認・取消・新規申請・通知再送の許可とは扱いません。
