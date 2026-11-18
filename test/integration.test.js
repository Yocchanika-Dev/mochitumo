const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { openDatabase } = require('../src/db/database');
const { seedDevelopmentData, DEMO_DEVICE_KEY, DEMO_CARD_UID } = require('../src/db/seed');
const { createNfcRentalRequest } = require('../src/nfc/request-service');
const { approve, cancel, requestLock } = require('../src/rental/service');
const { createApp } = require('../server');
const { MockSerialAdapter, UsbSerialAdapter } = require('../src/serial/adapters');
const { SerialBridge } = require('../src/serial/bridge');
const { unlockForSerialReader } = require('../src/rental/card-unlock');

function touch(db) {
  return unlockForSerialReader(db, {
    relayId: 'RELAY01',
    deviceId: 'BIKE03',
    body: { card_uid: DEMO_CARD_UID, action: 'unlock', client_request_id: crypto.randomUUID() },
  });
}

function setup(t) {
  const db = openDatabase(':memory:');
  seedDevelopmentData(db);
  t.after(() => db.close());
  const id = createNfcRentalRequest(db, {
    deviceId: 'nfc-reader-01',
    cardUid: DEMO_CARD_UID,
    action: 'request',
    clientRequestId: crypto.randomUUID(),
  }).response.request_id;
  return { db, id };
}
const approval = (id) => ({ id, studentId: 'S1002', bikeId: 'B003', eventId: 'evt-1' });
const cancellation = (id) => ({
  id,
  studentId: 'S1001',
  source: 'nfc:nfc-reader-01',
  eventId: 'cancel-1',
});
function status(db, id) {
  return db.prepare('SELECT status FROM rental_requests WHERE request_id=?').get(id).status;
}

test('承認は一件のみ・再送は同じ結果・内容変更と権限外を拒否', (t) => {
  const { db, id } = setup(t);
  assert.throws(
    () => approve(db, { ...approval(id), studentId: 'S1001' }),
    (e) => e.code === 'SELF_APPROVAL',
  );
  const first = approve(db, approval(id));
  assert.equal(status(db, id), 'approved');
  assert.deepEqual(approve(db, approval(id)), first);
  assert.throws(
    () => approve(db, { ...approval(id), bikeId: 'other' }),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => approve(db, { ...approval(id), eventId: 'evt-2' }),
    (e) => e.code === 'INVALID_STATE',
  );
  assert.throws(
    () => cancel(db, cancellation(id)),
    (e) => e.code === 'INVALID_STATE',
  );
  assert.equal(first.lock_command, null);
  assert.equal(first.next_action, 'tap_card');
  assert.equal(db.prepare('SELECT count(*) AS n FROM lock_commands').get().n, 0);
});
test('取消が先に成立したら承認拒否・借り手限定・再送可能', (t) => {
  const { db, id } = setup(t);
  assert.throws(
    () => cancel(db, { ...cancellation(id), studentId: 'S1002' }),
    (e) => e.code === 'REQUEST_NOT_FOUND',
  );
  const result = cancel(db, cancellation(id));
  assert.deepEqual(cancel(db, cancellation(id)), result);
  assert.throws(
    () => approve(db, approval(id)),
    (e) => e.code === 'INVALID_STATE',
  );
  assert.equal(status(db, id), 'cancelled');
});
test('USB Mock: 部分JSON・不正JSON・ACK・不正機器・重複結果・返却', (t) => {
  const { db, id } = setup(t);
  db.prepare("UPDATE bikes SET device_id='BIKE03',relay_id='RELAY01' WHERE bike_id='B003'").run();
  const adapter = new MockSerialAdapter();
  const bridge = new SerialBridge(db, adapter, { relayId: 'RELAY01' });
  bridge.start();
  t.after(() => bridge.close());
  adapter.receive('not json\n' + 'x'.repeat(1100) + '\n');
  assert.equal(adapter.sent.length, 0);
  approve(db, approval(id));
  const a = touch(db).response;
  bridge.tick();
  const command = JSON.parse(adapter.sent[0]);
  const message = { ...command, message_type: 'result', result: 'unlock_success' };
  adapter.receive(JSON.stringify({ ...message, device_id: 'BAD' }) + '\n');
  assert.equal(status(db, id), 'approved');
  adapter.receive(JSON.stringify({ ...message, message_type: 'ack' }) + '\n');
  assert.equal(status(db, id), 'approved');
  assert.equal(
    db.prepare('SELECT status FROM lock_commands WHERE command_id=?').get(a.lock_command.command_id)
      .status,
    'acknowledged',
  );
  const line = JSON.stringify(message) + '\n';
  adapter.receive(line.slice(0, 20));
  adapter.receive(line.slice(20));
  adapter.receive(line);
  assert.equal(status(db, id), 'rented');
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM event_logs WHERE event_type='request.rented'").get().n,
    1,
  );
  requestLock(db, { id, studentId: 'S1001', eventId: 'return-1' });
  bridge.tick();
  const lock = JSON.parse(adapter.sent.at(-1));
  adapter.receive(
    JSON.stringify({ ...lock, message_type: 'result', result: 'lock_success' }) + '\n',
  );
  assert.equal(status(db, id), 'returned');
  assert.equal(
    db.prepare("SELECT availability FROM bikes WHERE bike_id='B003'").get().availability,
    'available',
  );
});
test('USB: 失敗はapproved維持・切断再接続・同じIDで再送・タイムアウト', (t) => {
  const { db, id } = setup(t);
  db.prepare("UPDATE bikes SET device_id='BIKE03',relay_id='RELAY01' WHERE bike_id='B003'").run();
  const adapter = new MockSerialAdapter();
  const bridge = new SerialBridge(db, adapter, {
    relayId: 'RELAY01',
    timeoutMs: 5,
    maxAttempts: 2,
  });
  bridge.start();
  t.after(() => bridge.close());
  approve(db, approval(id));
  touch(db);
  adapter.disconnect();
  bridge.tick();
  assert.equal(adapter.sent.length, 0);
  adapter.start();
  assert.equal(adapter.sent.length, 1);
  db.prepare("UPDATE lock_commands SET sent_at='2000-01-01T00:00:00Z'").run();
  bridge.tick();
  assert.equal(JSON.parse(adapter.sent[0]).command_id, JSON.parse(adapter.sent[1]).command_id);
  db.prepare("UPDATE lock_commands SET sent_at='2000-01-01T00:00:00Z'").run();
  bridge.tick();
  assert.equal(db.prepare('SELECT status FROM lock_commands').get().status, 'timed_out');
  assert.equal(status(db, id), 'approved');
  adapter.receive(
    JSON.stringify({
      ...JSON.parse(adapter.sent[0]),
      message_type: 'result',
      result: 'unlock_failed',
    }) + '\n',
  );
  assert.equal(status(db, id), 'approved');
  assert.equal(db.prepare('SELECT status FROM lock_commands').get().status, 'failed');
});

async function httpContext(t) {
  const { db, id } = setup(t);
  const token = 'test-only-line-service-token-32-characters';
  const secret = 'test-line-secret';
  const app = createApp({ db, requireHttps: false, lineToken: token, lineSecret: secret });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}` };
  const nfc = { 'X-Device-Id': 'nfc-reader-01', 'X-Device-Key': DEMO_DEVICE_KEY };
  return { db, id, base, headers, nfc, secret };
}
test('LINE一覧・差分cursor・無認証拒否・NFC状態取得と取消', async (t) => {
  const { id, base, headers, nfc } = await httpContext(t);
  assert.equal((await fetch(`${base}/api/line/requests`)).status, 401);
  const listing = await (await fetch(`${base}/api/line/requests`, { headers })).json();
  assert.equal(listing.requests[0].borrower_display_name, '借り手デモ');
  const events = await (await fetch(`${base}/api/line/events?after=0`, { headers })).json();
  assert.equal(events.events[0].event_type, 'request.created');
  assert.equal(
    (await (await fetch(`${base}/api/line/events?after=${events.next_cursor}`, { headers })).json())
      .events.length,
    0,
  );
  assert.equal((await fetch(`${base}/api/requests/${id}`, { headers: nfc })).status, 200);
  const result = await fetch(`${base}/api/requests/${id}/cancel`, {
    method: 'POST',
    headers: { ...nfc, 'Content-Type': 'application/json' },
    body: JSON.stringify({ card_uid: DEMO_CARD_UID, event_id: 'nfc-cancel-1' }),
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, 'cancelled');
});
test('LINE raw署名を検証・偽装userId拒否・同時承認は一件・成功再送', async (t) => {
  const { db, id, base, headers, secret } = await httpContext(t);
  const post = async (eventId, signature = true) => {
    const body = JSON.stringify({
      events: [
        {
          type: 'postback',
          webhookEventId: eventId,
          source: { userId: 'U_DEMO_LENDER' },
          postback: {
            data: JSON.stringify({ action: 'approve', request_id: id, bike_id: 'B003' }),
          },
        },
      ],
    });
    return fetch(`${base}/api/requests/${id}/approve`, {
      method: 'POST',
      body,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'X-Line-Signature': signature
          ? crypto.createHmac('sha256', secret).update(body).digest('base64')
          : 'bad',
      },
    });
  };
  assert.equal((await post('evt1', false)).status, 401);
  const results = await Promise.all([post('evt1'), post('evt2')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? 'evt1' : 'evt2';
  assert.equal((await post(winner)).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lock_commands').get().n, 0);
});
test('USB adapterはポート不在でも停止せず再接続を試みる', async (t) => {
  const adapter = new UsbSerialAdapter({ path: '/dev/mobaeco-nonexistent', reconnectMs: 10 });
  let errors = 0;
  adapter.on('transportError', () => errors++);
  adapter.start();
  t.after(() => adapter.close());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(adapter.connected, false);
  assert.ok(errors > 0);
});

test('HTTP取消と承認の同時競合では片方だけ成立する', async (t) => {
  const { db, id, base, headers, nfc, secret } = await httpContext(t);
  const body = JSON.stringify({
    events: [
      {
        type: 'postback',
        webhookEventId: 'race-approve',
        source: { userId: 'U_DEMO_LENDER' },
        postback: { data: JSON.stringify({ action: 'approve', request_id: id, bike_id: 'B003' }) },
      },
    ],
  });
  const responses = await Promise.all([
    fetch(`${base}/webhooks/line`, {
      method: 'POST',
      body,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'X-Line-Signature': crypto.createHmac('sha256', secret).update(body).digest('base64'),
      },
    }),
    fetch(`${base}/api/requests/${id}/cancel`, {
      method: 'POST',
      headers: { ...nfc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_uid: DEMO_CARD_UID, event_id: 'race-cancel' }),
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const count = db.prepare('SELECT count(*) AS n FROM lock_commands').get().n;
  assert.ok(['approved', 'cancelled'].includes(status(db, id)));
  assert.equal(count, 0);
});
test('自転車の所有権検証・1人1台制約・未承認の施錠要求拒否', (t) => {
  const { db, id } = setup(t);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users VALUES ('S1003',NULL,'別の貸し手','active',?,?)").run(now, now);
  assert.throws(
    () => approve(db, { ...approval(id), studentId: 'S1003' }),
    (e) => e.code === 'BIKE_NOT_OWNED',
  );
  assert.throws(
    () => requestLock(db, { id, studentId: 'S1001', eventId: 'bad-lock' }),
    (e) => e.code === 'INVALID_STATE',
  );
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO bikes(bike_id,owner_student_id,availability,created_at,updated_at) VALUES ('B004','S1002','available',?,?)",
      )
      .run(now, now),
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM lock_commands').get().n, 0);
});
