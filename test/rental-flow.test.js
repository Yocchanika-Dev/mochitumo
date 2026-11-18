const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { openDatabase } = require('../src/db/database');
const { seedDevelopmentData, DEMO_CARD_UID, DEMO_DEVICE_KEY } = require('../src/db/seed');
const { createApp } = require('../server');
const { MockSerialAdapter } = require('../src/serial/adapters');
const { EventSender } = require('../src/line/event-sender');
const { requestDiagnostics } = require('../src/db/maintenance');

test('HTTP申請→Mock通知→署名承認→USBタッチ→実行結果→返却の通し試験', async (t) => {
  const db = openDatabase(':memory:');
  seedDevelopmentData(db);
  db.prepare("UPDATE users SET line_user_id='U_DEMO_BORROWER' WHERE student_id='S1001'").run();
  db.prepare("UPDATE bikes SET device_id='BIKE03',relay_id='RELAY01' WHERE bike_id='B003'").run();
  const adapter = new MockSerialAdapter();
  const secret = 'dummy-test-channel';
  const token = 'dummy-test-service-token-32-characters-minimum';
  const app = createApp({
    db,
    requireHttps: false,
    lineSecret: secret,
    lineToken: token,
    serialAdapter: adapter,
    serialOptions: { relayId: 'RELAY01' },
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
    app.locals.closeDatabase();
    db.close();
  });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = {
    card_uid: DEMO_CARD_UID,
    action: 'request',
    client_request_id: crypto.randomUUID(),
  };
  const nfc = () =>
    fetch(base + '/api/requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': 'nfc-reader-01',
        'X-Device-Key': DEMO_DEVICE_KEY,
      },
      body: JSON.stringify(body),
    });
  const first = await nfc();
  assert.equal(first.status, 201);
  const created = await first.json();
  const second = await nfc();
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), created);
  const id = created.request_id;
  const sent = [];
  const sender = new EventSender(db, {
    url: 'https://example.invalid/events',
    token: 'dummy-test-token-only',
    fetchImpl: async (_, options) => {
      sent.push(options.body);
      return { status: sent.length === 1 ? 202 : 200 };
    },
  });
  const event = db.prepare('SELECT event_id FROM line_outbox').get();
  assert.equal((await sender.send(event.event_id)).http_status, 202);
  assert.equal((await sender.send(event.event_id)).http_status, 200);
  assert.equal(sent[0], sent[1]);
  async function line(userId, data, eventId) {
    const raw = JSON.stringify({
      events: [
        {
          type: 'postback',
          webhookEventId: eventId,
          source: { userId },
          postback: { data: JSON.stringify(data) },
        },
      ],
    });
    const response = await fetch(base + '/webhooks/line', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Line-Signature': crypto.createHmac('sha256', secret).update(raw).digest('base64'),
      },
      body: raw,
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  const approval = { action: 'approve', request_id: id, bike_id: 'B003' };
  const approved = await line('U_DEMO_LENDER', approval, 'approval');
  assert.equal(approved.results[0].lock_command, null);
  assert.deepEqual(await line('U_DEMO_LENDER', approval, 'approval'), approved);
  app.locals.serial.tick();
  assert.equal(adapter.sent.length, 0);
  const status = () => requestDiagnostics(db, id).request.status;
  function receive(message) {
    adapter.receive(JSON.stringify(message) + '\n');
  }
  const tap = {
    v: 1,
    message_type: 'card_tap',
    device_id: 'BIKE03',
    relay_id: 'RELAY01',
    action: 'unlock',
    card_uid: DEMO_CARD_UID,
    client_request_id: crypto.randomUUID(),
  };
  receive(tap);
  const unlock = JSON.parse(adapter.sent.find((s) => JSON.parse(s).message_type === 'command'));
  receive({ ...unlock, message_type: 'ack' });
  assert.equal(status(), 'approved');
  receive({ ...unlock, message_type: 'result', result: 'unlock_success' });
  assert.equal(status(), 'rented');
  receive(tap);
  await line('U_DEMO_BORROWER', { action: 'lock', request_id: id }, 'return');
  app.locals.serial.tick();
  const lock = JSON.parse(adapter.sent.at(-1));
  assert.equal(lock.action, 'lock');
  receive({ ...lock, message_type: 'ack' });
  assert.equal(status(), 'rented');
  receive({ ...lock, message_type: 'result', result: 'lock_success' });
  receive({ ...lock, message_type: 'result', result: 'lock_success' });
  assert.equal(status(), 'returned');
  assert.equal(
    db.prepare("SELECT availability FROM bikes WHERE bike_id='B003'").get().availability,
    'available',
  );
  assert.equal(db.prepare('SELECT count(*) n FROM lock_commands').get().n, 2);
  const diagnostic = JSON.stringify(requestDiagnostics(db, id));
  assert.ok(!diagnostic.includes(DEMO_DEVICE_KEY));
  assert.ok(!diagnostic.includes(DEMO_CARD_UID));
});
