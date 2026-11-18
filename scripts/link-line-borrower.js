const fs = require('node:fs');
const { openDatabase } = require('../src/db/database');
const { loadEnvironmentFile } = require('../src/config');
const { linkBorrowerAccount } = require('../src/line/link-account');

let db;
try {
  loadEnvironmentFile();
  if (process.argv.length !== 3) throw new Error('Private input file required');
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  db = openDatabase();
  console.log(JSON.stringify(linkBorrowerAccount(db, input)));
} catch {
  console.error(
    '借り手LINE紐付け失敗：本人確認・既存学生・競合・入力を確認してください。個人LINE ID・秘密値は非表示です。',
  );
  process.exitCode = 1;
} finally {
  if (db?.open) db.close();
}
