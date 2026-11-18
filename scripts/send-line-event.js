const { openDatabase } = require('../src/db/database');
const { EventSender } = require('../src/line/event-sender');
const { getEventDeliveryOptions } = require('../src/runtime');

async function main() {
  require('../src/config').loadEnvironmentFile();
  const db = openDatabase();
  try {
    const sender = new EventSender(db, getEventDeliveryOptions());
    // 引数なし: 次の未送信1件。event_id指定: 保存済み本文をそのまま再送。
    const result = await sender.send(process.argv[2]);
    console.log(JSON.stringify(result));
    if (result.status !== 'delivered') process.exitCode = 1;
  } finally {
    db.close();
  }
}
main().catch(() => {
  console.error('通知設定または送信を確認してください（秘密情報は非表示）');
  process.exitCode = 1;
});
