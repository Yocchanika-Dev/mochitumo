const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db/database');

let baseUrl;
let db;
let server;

before(async () => {
  db = openDatabase(':memory:');
  server = createApp({ db, requireHttps: false, enableVirtualBike: true }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  db.close();
});

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

test('LIGHTとUNLOCKのコマンドライフサイクル', async (t) => {
  let lightCommand;
  let lightCompletedAt;

  await t.test('LIGHTコマンドをpendingで生成する', async () => {
    const { response, body } = await request('/api/bikes/03/light', {
      method: 'POST',
    });

    assert.equal(response.status, 201);
    assert.ok(body.commandId);
    assert.equal(body.bikeId, '03');
    assert.equal(body.type, 'LIGHT');
    assert.equal(body.status, 'pending');
    assert.ok(body.createdAt);
    lightCommand = body;
  });

  await t.test('GETだけではLIGHTをcompletedにしない', async () => {
    const first = await request('/api/bikes/03/command');
    const second = await request('/api/bikes/03/command');

    assert.equal(first.body.commandId, lightCommand.commandId);
    assert.equal(first.body.status, 'pending');
    assert.equal(second.body.commandId, lightCommand.commandId);
    assert.equal(second.body.status, 'pending');
  });

  await t.test('完了通知後はLIGHTを再取得しない', async () => {
    const completed = await request(`/api/bikes/03/commands/${lightCommand.commandId}/complete`, {
      method: 'POST',
    });

    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.status, 'completed');
    assert.ok(completed.body.completedAt);
    lightCompletedAt = completed.body.completedAt;

    const next = await request('/api/bikes/03/command');
    assert.deepEqual(next.body, { command: 'NONE' });
  });

  await t.test('完了通知を再送しても安全に同じ結果を返す', async () => {
    const duplicate = await request(`/api/bikes/03/commands/${lightCommand.commandId}/complete`, {
      method: 'POST',
    });

    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.status, 'completed');
    assert.equal(duplicate.body.completedAt, lightCompletedAt);
  });

  await t.test('存在しないcommandIdの完了通知は404を返す', async () => {
    const { response, body } = await request('/api/bikes/03/commands/not-found/complete', {
      method: 'POST',
    });

    assert.equal(response.status, 404);
    assert.equal(body.error, 'COMMAND_NOT_FOUND');
  });

  await t.test('UNLOCKコマンドも生成・取得・完了できる', async () => {
    const created = await request('/api/bikes/03/unlock', { method: 'POST' });
    assert.equal(created.response.status, 201);
    assert.ok(created.body.commandId);
    assert.equal(created.body.type, 'UNLOCK');
    assert.equal(created.body.status, 'pending');

    const pending = await request('/api/bikes/03/command');
    assert.equal(pending.body.commandId, created.body.commandId);

    const completed = await request(`/api/bikes/03/commands/${created.body.commandId}/complete`, {
      method: 'POST',
    });
    assert.equal(completed.body.status, 'completed');

    const next = await request('/api/bikes/03/command');
    assert.deepEqual(next.body, { command: 'NONE' });
  });

  await t.test('履歴に完了済みの2コマンドを保持する', async () => {
    const { body } = await request('/api/bikes/03/commands');
    assert.equal(body.length, 2);
    assert.deepEqual(
      body.map((command) => command.type),
      ['LIGHT', 'UNLOCK'],
    );
    assert.ok(body.every((command) => command.status === 'completed'));
  });
});
