const fs = require('node:fs');
const { openDatabase } = require('../src/db/database');

// 公開の本人連携APIではない。管理者が本人・所有権確認済みのテスト情報だけを登録する。
function linkLineTestUser(db, input) {
  for (const key of ['student_id', 'name', 'line_user_id', 'bike_id']) {
    if (typeof input?.[key] !== 'string' || !input[key].trim() || input[key].length > 128) {
      throw new Error('student_id/name/line_user_id/bike_idを確認してください');
    }
  }
  if (input.verified_by_operator !== true)
    throw new Error('管理者による本人・自転車所有権の確認が必要です');
  return db
    .transaction(() => {
      const oldUser = db.prepare('SELECT * FROM users WHERE student_id=?').get(input.student_id);
      const oldLine = db
        .prepare('SELECT student_id FROM users WHERE line_user_id=?')
        .get(input.line_user_id);
      const oldBike = db.prepare('SELECT * FROM bikes WHERE bike_id=?').get(input.bike_id);
      const otherBike = db
        .prepare('SELECT bike_id FROM bikes WHERE owner_student_id=? AND bike_id<>?')
        .get(input.student_id, input.bike_id);
      if (oldLine && oldLine.student_id !== input.student_id)
        throw new Error('LINEアカウントは別の学生へ登録済みです');
      if (oldUser?.status === 'disabled') throw new Error('無効な利用者は変更しません');
      if (oldUser?.line_user_id && oldUser.line_user_id !== input.line_user_id) {
        if (!(input.replace_demo_link === true && oldUser.line_user_id === 'U_DEMO_LENDER')) {
          throw new Error('既存のLINE紐付けは上書きしません。デモ置換には明示指定が必要です');
        }
      }
      if (oldBike && oldBike.owner_student_id !== input.student_id)
        throw new Error('別の所有者の自転車は変更しません');
      if (otherBike) throw new Error('貸し手1人1台の上限を超えます');
      const now = new Date().toISOString();
      if (oldUser) {
        db.prepare('UPDATE users SET line_user_id=?,updated_at=? WHERE student_id=?').run(
          input.line_user_id,
          now,
          input.student_id,
        );
      } else {
        db.prepare(
          "INSERT INTO users(student_id,line_user_id,name,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)",
        ).run(input.student_id, input.line_user_id, input.name, now, now);
      }
      if (!oldBike) {
        db.prepare(
          "INSERT INTO bikes(bike_id,owner_student_id,availability,created_at,updated_at) VALUES (?,?,'available',?,?)",
        ).run(input.bike_id, input.student_id, now, now);
      }
      return { student_id: input.student_id, bike_id: input.bike_id, linked: true };
    })
    .immediate();
}

if (require.main === module) {
  let db;
  try {
    require('../src/config').loadEnvironmentFile();
    if (!process.argv[2]) throw new Error('Usage: npm run line:link -- <private-json-file>');
    const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    db = openDatabase();
    console.log(JSON.stringify(linkLineTestUser(db, input))); // LINE userIdや秘密情報を出力しない。
  } catch {
    console.error(
      '本人確認・所有者・既存紐付け・入力ファイルを確認してください（個人IDと秘密は非表示）',
    );
    process.exitCode = 1;
  } finally {
    if (db?.open) db.close();
  }
}

module.exports = { linkLineTestUser };
