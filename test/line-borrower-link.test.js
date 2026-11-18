const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db/database');
const { seedDevelopmentData } = require('../src/db/seed');
const { linkBorrowerAccount } = require('../src/line/link-account');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function setup(t) {
  const db = openDatabase(':memory:');
  seedDevelopmentData(db);
  t.after(() => db.close());
  return {
    db,
    input: { student_id: 'S1001', line_user_id: 'U' + '1'.repeat(32), verified_by_operator: true },
  };
}
test('借り手のみLINE登録：車・カード・申請に触れず、同じ登録は冪等', (t) => {
  const { db, input } = setup(t);
  const before = db.prepare('SELECT * FROM users WHERE student_id=?').get(input.student_id);
  const bikes = db.prepare('SELECT * FROM bikes').all();
  const cards = db.prepare('SELECT * FROM nfc_cards').all();
  assert.deepEqual(linkBorrowerAccount(db, input), { student_id: 'S1001', linked: true });
  const linked = db.prepare('SELECT * FROM users WHERE student_id=?').get(input.student_id);
  assert.equal(linked.line_user_id, input.line_user_id);
  assert.equal(linked.name, before.name);
  assert.equal(linked.status, before.status);
  linkBorrowerAccount(db, input);
  assert.deepEqual(
    db.prepare('SELECT * FROM users WHERE student_id=?').get(input.student_id),
    linked,
  );
  assert.deepEqual(db.prepare('SELECT * FROM bikes').all(), bikes);
  assert.deepEqual(db.prepare('SELECT * FROM nfc_cards').all(), cards);
  assert.equal(db.prepare('SELECT count(*) n FROM rental_requests').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM line_outbox').get().n, 0);
});
test('未確認・不正形式・車指定・未知/無効学生を拒否し、新規学生を作らない', (t) => {
  const { db, input } = setup(t);
  for (const invalid of [
    null,
    { ...input, verified_by_operator: false },
    { ...input, line_user_id: 'unknown' },
    { ...input, bike_id: 'B003' },
    { ...input, student_id: 'missing' },
    { ...input, student_id: ' S1001' },
  ]) {
    assert.throws(() => linkBorrowerAccount(db, invalid));
  }
  db.prepare("UPDATE users SET status='disabled' WHERE student_id='S1001'").run();
  assert.throws(() => linkBorrowerAccount(db, input));
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 2);
  assert.equal(
    db.prepare("SELECT line_user_id FROM users WHERE student_id='S1001'").get().line_user_id,
    null,
  );
});
test('他人のLINE IDと既存本人紐付けの置換を拒否し、失敗時は変更しない', (t) => {
  const { db, input } = setup(t);
  db.prepare("UPDATE users SET line_user_id=? WHERE student_id='S1002'").run(input.line_user_id);
  assert.throws(() => linkBorrowerAccount(db, input));
  assert.equal(
    db.prepare("SELECT line_user_id FROM users WHERE student_id='S1001'").get().line_user_id,
    null,
  );
  db.prepare("UPDATE users SET line_user_id=NULL WHERE student_id='S1002'").run();
  linkBorrowerAccount(db, input);
  assert.throws(() => linkBorrowerAccount(db, { ...input, line_user_id: 'U' + '2'.repeat(32) }));
  assert.equal(
    db.prepare("SELECT line_user_id FROM users WHERE student_id='S1001'").get().line_user_id,
    input.line_user_id,
  );
});

test('管理者CLIは独立DBに登録でき、不正JSONでも秘密値を表示しない', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobaeco-borrower-'));
  const filename = path.join(dir, 'test.sqlite');
  const inputFile = path.join(dir, '.env.identity');
  const db = openDatabase(filename);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  seedDevelopmentData(db);
  const input = {
    student_id: 'S1001',
    line_user_id: 'U' + '3'.repeat(32),
    verified_by_operator: true,
  };
  fs.writeFileSync(inputFile, JSON.stringify(input), { mode: 0o600 });
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(__dirname, '../scripts/link-line-borrower.js'), inputFile],
      {
        encoding: 'utf8',
        env: { ...process.env, BACKEND_ENV_FILE: '', DATABASE_PATH: filename },
      },
    );
  const first = run();
  assert.equal(first.status, 0);
  assert.deepEqual(JSON.parse(first.stdout), { student_id: 'S1001', linked: true });
  assert.ok(!first.stdout.includes(input.line_user_id));
  fs.writeFileSync(inputFile, 'INVALID_JSON_PRIVATE_SENTINEL');
  const failed = run();
  assert.equal(failed.status, 1);
  assert.ok(!(failed.stdout + failed.stderr).includes('INVALID_JSON_PRIVATE_SENTINEL'));
  assert.equal(
    db.prepare("SELECT line_user_id FROM users WHERE student_id='S1001'").get().line_user_id,
    input.line_user_id,
  );
});
