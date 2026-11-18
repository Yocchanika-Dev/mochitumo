const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openDatabase } = require('../src/db/database');
const { seedDevelopmentData, DEMO_CARD_UID, DEMO_DEVICE_KEY } = require('../src/db/seed');
const { createNfcRentalRequest } = require('../src/nfc/request-service');
const { approve } = require('../src/rental/service');
const { unlockForHttpReader, unlockForSerialReader } = require('../src/rental/card-unlock');
const { MockSerialAdapter } = require('../src/serial/adapters');
const { SerialBridge } = require('../src/serial/bridge');
const { createApp } = require('../server');

function setup(t, filename = ':memory:') {
  const db = openDatabase(filename);
  seedDevelopmentData(db);
  t.after(() => {
    if (db.open) db.close();
  });
  const id = createNfcRentalRequest(db, {
    deviceId: 'nfc-reader-01',
    cardUid: DEMO_CARD_UID,
    action: 'request',
    clientRequestId: crypto.randomUUID(),
  }).response.request_id;
  db.prepare("UPDATE bikes SET device_id='BIKE03',relay_id='RELAY01' WHERE bike_id='B003'").run();
  const approveNow = () =>
    approve(db, { id, studentId: 'S1002', bikeId: 'B003', eventId: 'approval' });
  const input = {
    card_uid: DEMO_CARD_UID,
    action: 'unlock',
    client_request_id: crypto.randomUUID(),
  };
  const tap = (body) =>
    unlockForSerialReader(db, { relayId: 'RELAY01', deviceId: 'BIKE03', body: body || input });
  return { db, id, input, tap, approveNow };
}
function commandCount(db) {
  return db.prepare('SELECT count(*) AS n FROM lock_commands').get().n;
}

test('承認のみでは解錠せず・承認済み借り手のタッチで初めて命令を1件作る', (t) => {
  const { db, tap, approveNow } = setup(t);
  const a = approveNow();
  assert.equal(a.request.status, 'approved');
  assert.equal(a.lock_command, null);
  assert.equal(commandCount(db), 0);
  const first = tap();
  assert.equal(first.created, true);
  assert.equal(first.response.request.status, 'approved');
  assert.equal(commandCount(db), 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM unlock_authorizations').get().n, 1);
  assert.equal(tap().created, false);
  assert.deepEqual(tap().response, first.response);
  assert.equal(commandCount(db), 1);
});

test('未承認・他人のカード・別自転車・未登録/無効カード・不正な機器を拒否', (t) => {
  const { db, tap, input, approveNow } = setup(t);
  assert.throws(
    () => tap(),
    (e) => e.code === 'NO_APPROVED_RENTAL',
  );
  approveNow();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO nfc_cards(card_uid,student_id,status,issued_at,created_at,updated_at) VALUES ('1122334455667788','S1002','active',?,?,?)",
  ).run(now, now, now);
  assert.throws(
    () => tap({ ...input, card_uid: '1122334455667788' }),
    (e) => e.code === 'NOT_APPROVED_BORROWER',
  );
  assert.throws(
    () => tap({ ...input, card_uid: 'FFFFFFFFFFFFFFFF' }),
    (e) => e.code === 'CARD_NOT_REGISTERED',
  );
  db.prepare("UPDATE nfc_cards SET status='disabled' WHERE card_uid=?").run(DEMO_CARD_UID);
  assert.throws(
    () => tap(),
    (e) => e.code === 'CARD_DISABLED',
  );
  assert.throws(
    () => unlockForSerialReader(db, { relayId: 'OTHER', deviceId: 'BIKE03', body: input }),
    (e) => e.code === 'LOCK_READER_NOT_REGISTERED',
  );
  assert.throws(
    () =>
      unlockForSerialReader(db, {
        relayId: 'RELAY01',
        deviceId: 'BIKE03',
        bikeId: 'OTHER',
        body: input,
      }),
    (e) => e.code === 'LOCK_READER_NOT_REGISTERED',
  );
  assert.equal(commandCount(db), 0);
});

test('別UUIDの繰返しタッチも同じ命令を使い、内容の違う同UUIDは競合', (t) => {
  const { db, tap, input, approveNow } = setup(t);
  approveNow();
  const a = tap();
  const b = tap({
    ...input,
    card_uid: DEMO_CARD_UID.toLowerCase(),
    client_request_id: crypto.randomUUID(),
  });
  assert.equal(a.response.lock_command.command_id, b.response.lock_command.command_id);
  assert.equal(commandCount(db), 1);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO nfc_cards(card_uid,student_id,status,issued_at,created_at,updated_at) VALUES ('1122334455667788','S1002','active',?,?,?)",
  ).run(now, now, now);
  assert.throws(
    () => tap({ ...input, card_uid: '1122334455667788' }),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  db.prepare("UPDATE lock_commands SET status='failed'").run();
  assert.throws(
    () => tap({ ...input, client_request_id: crypto.randomUUID() }),
    (e) => e.code === 'UNLOCK_RETRY_REQUIRED',
  );
});

test('USBカードタッチ→受付返信→命令→ACK→成功のみrented・旧命令はタッチ前に送信しない', (t) => {
  const { db, id, input, approveNow } = setup(t);
  approveNow();
  // 旧版で承認時に作られたqueued命令を想定。移行時にも勝手には送らない。
  db.prepare(
    "INSERT INTO lock_commands(command_id,request_id,bike_id,action,status,created_at) VALUES ('legacy',?,'B003','unlock','queued',?)",
  ).run(id, new Date().toISOString());
  const adapter = new MockSerialAdapter();
  const bridge = new SerialBridge(db, adapter, { relayId: 'RELAY01' });
  bridge.start();
  t.after(() => bridge.close());
  bridge.tick();
  assert.equal(adapter.sent.length, 0);
  const message =
    JSON.stringify({
      v: 1,
      message_type: 'card_tap',
      device_id: 'BIKE03',
      relay_id: 'RELAY01',
      ...input,
    }) + '\n';
  adapter.receive(message.slice(0, 25));
  adapter.receive(message.slice(25));
  const receipt = JSON.parse(adapter.sent[0]);
  const command = JSON.parse(adapter.sent[1]);
  assert.equal(receipt.message_type, 'card_tap_result');
  assert.equal(receipt.success, true);
  assert.equal(command.message_type, 'command');
  assert.equal(command.command_id, 'legacy');
  adapter.receive(JSON.stringify({ ...command, message_type: 'ack' }) + '\n');
  assert.equal(
    db.prepare('SELECT status FROM rental_requests WHERE request_id=?').get(id).status,
    'approved',
  );
  adapter.receive(
    JSON.stringify({ ...command, message_type: 'result', result: 'unlock_success' }) + '\n',
  );
  assert.equal(
    db.prepare('SELECT status FROM rental_requests WHERE request_id=?').get(id).status,
    'rented',
  );
  adapter.receive(message); // 同じ操作再送は命令を新発行しない。
  assert.equal(commandCount(db), 1);
  assert.equal(
    adapter.sent.filter((line) => JSON.parse(line).message_type === 'command').length,
    1,
  );
});

test('HTTPS入口は端末認証とbike固定対応が必須・自称bike_id/student_idを拒否', async (t) => {
  const { db, input, approveNow } = setup(t);
  approveNow();
  const app = createApp({ db, requireHttps: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
  });
  const url = `http://127.0.0.1:${server.address().port}/api/lock-reader/taps`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Device-Id': 'nfc-reader-01',
    'X-Device-Key': DEMO_DEVICE_KEY,
  };
  const post = (body, auth = headers) =>
    fetch(url, {
      method: 'POST',
      headers: auth,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  assert.equal((await post(input, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post(input)).status, 403);
  db.prepare('INSERT INTO lock_readers(device_id,bike_id,created_at) VALUES (?, ?, ?)').run(
    'nfc-reader-01',
    'B003',
    new Date().toISOString(),
  );
  assert.equal((await post('{')).status, 400);
  assert.equal((await post({ ...input, bike_id: 'OTHER' })).status, 400);
  assert.equal((await post({ ...input, student_id: 'S1001' })).status, 400);
  const results = await Promise.all([post(input), post(input)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.equal(commandCount(db), 1);
  db.prepare("UPDATE devices SET status='disabled' WHERE device_id='nfc-reader-01'").run();
  assert.equal((await post(input)).status, 401);
});

test('カード無効化後は成功操作の再送でも拒否する', (t) => {
  const { db, tap, approveNow } = setup(t);
  approveNow();
  tap();
  db.prepare("UPDATE nfc_cards SET status='disabled' WHERE card_uid=?").run(DEMO_CARD_UID);
  assert.throws(
    () => tap(),
    (e) => e.code === 'CARD_DISABLED',
  );
  assert.equal(commandCount(db), 1);
});

test('カードタッチ操作と権限は再起動後も保存され、同じcommandだけを返す', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobaeco-card-unlock-'));
  const filename = path.join(dir, 'restart.sqlite');
  const { db, input, approveNow, tap } = setup(t, filename);
  approveNow();
  const first = tap();
  db.close();
  const reopened = openDatabase(filename);
  try {
    const replay = unlockForSerialReader(reopened, {
      relayId: 'RELAY01',
      deviceId: 'BIKE03',
      body: input,
    });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.response, first.response);
    assert.equal(commandCount(reopened), 1);
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM unlock_authorizations').get().n, 1);
  } finally {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('USBで他人のタッチは拒否返信のみ・権限のない旧sent命令の成功結果も不受理', (t) => {
  const { db, id, input, approveNow } = setup(t);
  approveNow();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO nfc_cards(card_uid,student_id,status,issued_at,created_at,updated_at) VALUES ('1122334455667788','S1002','active',?,?,?)",
  ).run(now, now, now);
  const adapter = new MockSerialAdapter();
  const bridge = new SerialBridge(db, adapter, { relayId: 'RELAY01' });
  bridge.start();
  t.after(() => bridge.close());
  adapter.receive(
    JSON.stringify({
      v: 1,
      message_type: 'card_tap',
      relay_id: 'RELAY01',
      device_id: 'BIKE03',
      ...input,
      card_uid: '1122334455667788',
    }) + '\n',
  );
  const reply = JSON.parse(adapter.sent[0]);
  assert.equal(reply.success, false);
  assert.equal(reply.error, 'NOT_APPROVED_BORROWER');
  assert.equal(commandCount(db), 0);
  db.prepare(
    "INSERT INTO lock_commands(command_id,request_id,bike_id,action,status,created_at) VALUES ('old-sent',?,'B003','unlock','sent',?)",
  ).run(id, now);
  adapter.receive(
    JSON.stringify({
      v: 1,
      message_type: 'result',
      command_id: 'old-sent',
      request_id: id,
      bike_id: 'B003',
      device_id: 'BIKE03',
      relay_id: 'RELAY01',
      result: 'unlock_success',
    }) + '\n',
  );
  assert.equal(
    db.prepare('SELECT status FROM rental_requests WHERE request_id=?').get(id).status,
    'approved',
  );
  assert.equal(
    db.prepare("SELECT status FROM lock_commands WHERE command_id='old-sent'").get().status,
    'sent',
  );
});

test('カードタッチHTTPS必須設定ではHTTPを拒否する', async (t) => {
  const { db } = setup(t);
  const app = createApp({ db, requireHttps: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lock-reader/taps`, {
      method: 'POST',
    });
    assert.equal(response.status, 426);
    assert.equal((await response.json()).error, 'HTTPS_REQUIRED');
  } finally {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
  }
});

test('Mockが命令受信直後にACKと結果を返してもJSON行を混ぜない', (t) => {
  const { db, id, input, approveNow } = setup(t);
  approveNow();
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const adapter = new MockSerialAdapter();
  const bridge = new SerialBridge(db, adapter, { relayId: 'RELAY01' });
  bridge.start();
  t.after(() => bridge.close());
  adapter.on('sent', (command) => {
    if (command.message_type !== 'command') return;
    adapter.receive(JSON.stringify({ ...command, message_type: 'ack' }) + '\n');
    assert.equal(
      db.prepare('SELECT status FROM lock_commands WHERE command_id=?').get(command.command_id)
        .status,
      'acknowledged',
    );
    adapter.receive(
      JSON.stringify({ ...command, message_type: 'result', result: 'unlock_success' }) + '\n',
    );
  });
  adapter.receive(
    JSON.stringify({
      v: 1,
      message_type: 'card_tap',
      device_id: 'BIKE03',
      relay_id: 'RELAY01',
      ...input,
    }) + '\n',
  );
  assert.equal(
    db.prepare('SELECT status FROM rental_requests WHERE request_id=?').get(id).status,
    'rented',
  );
  assert.deepEqual(warnings, []);
});
