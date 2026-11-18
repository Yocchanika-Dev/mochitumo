# 現行HTTP API仕様の入口

設計ドラフトと実装済み契約を区別するため、旧本文は[履歴資料](api-design-archive.md)へ保存しました。

| 担当・用途 | 現行仕様 |
| --- | --- |
| NFC申請、端末認証、カード、UUID再送 | [NFC契約](nfc-backend-api.md) |
| LINE通知、一覧・差分、転送認証 | [チーム連携](team-integration.md) |
| LINE登録車取得、正式承認、本人取消、成功JSON | [正式承認接続](line-approval-connection.md) |
| ロック側カードタッチ、USB受付・命令 | [タッチ解錠](card-touch-unlock.md) |
| 起動・開発API隔離・バックアップ・確認CLI | [Backend運用](backend-operations.md) |
| LINE確認セッション・承認再配達・旧receipt互換 | [confirmation_id契約](line-confirmation-contract.md) |

## 共通ルール

- 正式承認はapproved・自転車確保まで。解錠命令は本人の現地カードタッチ後。
- ACKではrentedにしない。unlock_successでrented、lock_successでreturned。
- 通常取消は借り手本人のrequestingのみ。
- 正式APIは端末認証またはLINEサービス認証＋公式署名が必要。原則HTTPS。
- 旧仮想Bike03 APIと画面は既定404。ENABLE_VIRTUAL_BIKE=trueの非本番環境だけ有効。
- GET /api/bikesは正式貸出DBの登録車取得ではない。LINEの登録車取得は署名付きlist_bikes postback。
- GET /api/me/bikes、公開の本人登録API、管理者による強制復旧APIは未実装。
- 初期の簡略approve Body（student_id直接指定など）は採用していない。

公開URLは一時トンネルのため、資料中の過去URLを稼働保証とはみなさず試験前に確認してください。
