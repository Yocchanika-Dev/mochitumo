# Backend運用の現行手順

## 開発用APIの隔離

通常起動では旧Web画面・仮想Bike03 APIは404です。正式貸出APIの契約は変更しません。
旧デモのみ `ENABLE_VIRTUAL_BIKE=true npm start` で有効化します。
無認証・メモリ内のデモなので隔離テスト環境限定です。本番（NODE_ENV=production）は有効化を拒否します。

## 設定・起動

環境変数を直接指定する方法を維持します。.envは暗黙には読みません。
必要な場合だけGit対象外の専用ファイルを明示します。

```bash
BACKEND_ENV_FILE=.env.backend npm start
BACKEND_ENV_FILE=.env.line-channel npm run line:serve
```

同じ方式をdb:migrate / db:seed / line:link / lock-reader:bind / events:send / db:backup / db:restore / ops:statusで使用できます。
ファイルはKEY=value、単一行引用符、コメント行に対応します。シェル実行・変数展開・複数行・行末コメントは非対応。
既存の環境変数を優先します。LINE gatewayにはLINE_SERVICE_TOKENとLINE_CHANNEL_SECRETの両方を設定してください。
複数ファイルは従来どおりsourceでまとめて設定できます。秘密ファイルは権限600・Git対象外にします。

SERIAL_MODEはoff/mock/usb。usbはport、relay ID、正の整数baud rateが必須です。
通知URLとトークンは両方必要で、URLは認証情報を含まないHTTPS限定です。
**mainへ通知URL・トークンを渡すと自動配信が始まります。** 手動結合試験ではmainから両方を外し、events:send専用環境に設定します。
設定は次回起動で反映します。稼働中プロセスの自動再起動はしません。

## バックアップ・復元

```bash
npm run db:backup -- ./data/backup-unique.sqlite
npm run db:restore -- ./data/backup-unique.sqlite ./data/restored-unique.sqlite
```

対象DBはDATABASE_PATH（既定data/mobaeco.sqlite）。SQLite online backup APIで起動中のWALを含むスナップショットを作成します。
元DBをマイグレーションせず、作成前後にintegrity_check / foreign_key_checkを実施します。
保存先は新規ファイル・権限600。既存ファイルは上書きせず、restoreも稼働DBを置換しません。
個人情報・認証ハッシュを含むため保管先の共有権限を制限してください。

復元DBは通知・実機接続を無効にした別プロセスで確認します（3000の競合に注意）。
本番切替は全書込プロセスを停止し、最新バックアップを取り、DATABASE_PATHを復元先へ変更して再起動します。
バックアップ後の申請・命令は含まれません。実ロック状態と照合せず切り戻さないでください。

## 状態確認・復旧判断

```bash
npm run ops:status -- req_example
```

読み取り専用で申請・命令・通知の状態と対処案をJSON表示します。
カードUID、学生ID、LINE ID、秘密キー、トークン、通知本文、エラー生本文は表示しません。
DB新規作成、移行、配信、再解錠、状態更新はしません。

- requestingの解除：既存の認証済み借り手取消APIを使う。
- approved：学生証タッチ待ち。通常取消不可。
- failed/timed_out：現地ロックとcommand IDを確認。自動再解錠しない。
- 通知再配信：担当と調整しevents:sendへ既存event IDを指定。同じ本文を維持。
- 承認後の故障復旧：運用未合意のため、強制状態変更CLIは提供しない。

## 自動確認

```bash
npm test
npm run format:check
node --test test/rental-flow.test.js test/backend-operations.test.js
```

通し試験は独立メモリDB・ダミー署名・Mock通知・Mock Serialです。
申請再送、通知本文固定、承認再送、タッチ前送信禁止、ACKでは状態維持、解錠成功rented、施錠成功returned、重複結果を確認します。
実LINE・実機の成功を証明する試験ではありません。

## 今回の検証結果（2026-11-11）

- npm test：77件成功、失敗0件。
- npm run format:check：成功。
- 実DBと分離したメモリDBでnpm startを実行し、curlでhealth 200・旧unlock API 404を確認。確認用プロセスは停止。
- ops:statusを実DBへ実行し、対象Core2申請がrequesting・命令なし、通知イベント10がdelivered・attempts 2であることを読み取り確認。
- 実DBの申請・通知履歴・カード・利用者を変更せず、実通知・実機命令の送信も行っていません。

主な変更：server.js / src/runtime.js / src/config.js、src/db/maintenance.js、scripts/database-maintenance.js、
各管理CLIの明示設定読込、package.json / .env.example、test/backend-operations.test.js / test/rental-flow.test.js、
旧デモテストの明示有効化、READMEと現行API資料。
旧API設計本文は削除せずapi-design-archive.mdへ保存しました。

次はLINE正式承認の実接続、ロック側FeliCa・USB・ESP-NOW実機接続です。
本人連携、公式Channel Secret、安全な秘密共有、施錠検知条件、承認後故障の復旧運用は担当間の確認が必要です。
