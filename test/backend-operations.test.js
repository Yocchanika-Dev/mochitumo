const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db/database');
const { seedDevelopmentData } = require('../src/db/seed');
const { copyDatabase, openReadOnly, requestDiagnostics } = require('../src/db/maintenance');
const { loadEnvironmentFile, validateRuntimeEnvironment } = require('../src/config');
const { createApp } = require('../server');
const { createRuntimeOptions } = require('../src/runtime');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobaeco-ops-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('旧デモは既定で404・明示開発設定のみ有効・本番は禁止', async (t) => {
  assert.equal(createRuntimeOptions({}).enableVirtualBike, false);
  assert.equal(createRuntimeOptions({ ENABLE_VIRTUAL_BIKE: 'true' }).enableVirtualBike, true);
  assert.throws(() =>
    createRuntimeOptions({ NODE_ENV: 'production', ENABLE_VIRTUAL_BIKE: 'true' }),
  );
  const db = openDatabase(':memory:');
  const app = createApp({ db, requireHttps: false });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
    db.close();
  });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [url, method] of [
    ['/', 'GET'],
    ['/api/bikes', 'GET'],
    ['/api/bikes/03/unlock', 'POST'],
    ['/api/bikes/03/light', 'POST'],
    ['/api/bikes/03/command', 'GET'],
  ]) {
    assert.equal((await fetch(base + url, { method })).status, 404);
  }
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('設定は明示読込・環境優先・値を例外に含めず・構文エラー時に部分適用しない', (t) => {
  const filename = path.join(temp(t), 'config');
  // テスト用フィクスチャ。実資格情報ではない。
  fs.writeFileSync(filename, '# comment\nA="dummy"\nB=local\n');
  const env = { B: 'process' };
  loadEnvironmentFile(filename, env);
  assert.deepEqual(env, { A: 'dummy', B: 'process' });
  fs.writeFileSync(filename, 'C=unused\nbad-secret-line');
  assert.throws(
    () => loadEnvironmentFile(filename, env),
    (e) => !e.message.includes('bad-secret-line'),
  );
  assert.equal(env.C, undefined);
  for (const config of [
    { SERIAL_MODE: 'typo' },
    { SERIAL_MODE: 'usb' },
    { BACKEND_EVENTS_URL: 'https://example.invalid' },
    { BACKEND_EVENTS_URL: 'http://example.invalid', BACKEND_EVENTS_TOKEN: 'dummy' },
  ]) {
    assert.throws(() => validateRuntimeEnvironment(config));
  }
});

test('WAL書込中もバックアップ・別DB復元・上書き拒否・読み取り専用確認', async (t) => {
  const dir = temp(t);
  const source = path.join(dir, 'source.sqlite');
  const db = openDatabase(source);
  t.after(() => db.close());
  seedDevelopmentData(db);
  const backup = path.join(dir, 'backup.sqlite');
  const restored = path.join(dir, 'restored.sqlite');
  await copyDatabase(source, backup);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  await copyDatabase(backup, restored);
  const check = openReadOnly(restored);
  try {
    assert.equal(check.prepare('SELECT count(*) n FROM users').get().n, 2);
    assert.throws(() => check.prepare('DELETE FROM users').run());
    assert.equal(requestDiagnostics(check, 'missing'), null);
  } finally {
    check.close();
  }
  await assert.rejects(copyDatabase(source, backup));
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 2);
});
