const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { openDatabase } = require('../src/db/database');
const { seedDevelopmentData, DEMO_CARD_UID } = require('../src/db/seed');
const { createNfcRentalRequest } = require('../src/nfc/request-service');
const { EventSender } = require('../src/line/event-sender');

function setup(t, fetchImpl) {
  const db = openDatabase(':memory:');
  seedDevelopmentData(db);
  t.after(() => db.close());
  const input = {
    deviceId: 'nfc-reader-01',
    cardUid: DEMO_CARD_UID,
    action: 'request',
    clientRequestId: crypto.randomUUID(),
  };
  createNfcRentalRequest(db, input);
  createNfcRentalRequest(db, input);
  const event = db.prepare('SELECT * FROM line_outbox').get();
  const sender = new EventSender(db, {
    url: 'https://example.invalid/events',
    token: 'dummy-test-token-only',
    fetchImpl,
  });
  return { db, event, sender };
}
test('申請再送でもoutbox一件・202→明示再送200・本文とIDを維持', async (t) => {
  const calls = [];
  const { db, event, sender } = setup(t, async (url, options) => {
    calls.push(options);
    return { status: calls.length === 1 ? 202 : 200 };
  });
  assert.equal(db.prepare('SELECT count(*) AS n FROM line_outbox').get().n, 1);
  assert.equal((await sender.send()).http_status, 202);
  db.prepare("UPDATE users SET name='changed' WHERE student_id='S1001'").run();
  assert.equal((await sender.send(event.event_id)).http_status, 200);
  assert.equal(calls[0].body, calls[1].body);
  const payload = JSON.parse(calls[0].body);
  assert.deepEqual(Object.keys(payload).sort(), ['event_id', 'event_type', 'request']);
  assert.deepEqual(Object.keys(payload.request).sort(), [
    'borrower_display_name',
    'request_id',
    'status',
  ]);
  assert.equal(JSON.parse(calls[0].body).request.borrower_display_name, '借り手デモ');
  assert.equal(calls[0].redirect, 'error');
});
test('ネットワーク失敗は再試行・401/400は停止・同時送信にlease', async (t) => {
  const { db, event, sender } = setup(t, async () => {
    throw new Error('secret must not be logged');
  });
  assert.equal((await sender.send()).status, 'pending');
  assert.equal(db.prepare('SELECT attempts FROM line_outbox').get().attempts, 1);
  sender.fetchImpl = async () => ({ status: 401 });
  assert.equal((await sender.send(event.event_id)).status, 'failed');
  sender.fetchImpl = async () => ({ status: 400 });
  assert.equal((await sender.send(event.event_id)).status, 'failed');
  let release;
  sender.fetchImpl = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = sender.send(event.event_id);
  const other = new EventSender(db, {
    url: 'https://example.invalid/events',
    token: 'dummy-test-token-only',
    fetchImpl: () => {
      throw new Error('must not send');
    },
  });
  assert.equal((await other.send(event.event_id)).status, 'no_event');
  release({ status: 202 });
  await first;
});
test('取消済みの未送信募集はskip・HTTPS必須・rollback時は送信対象なし', async (t) => {
  const { db, sender } = setup(t, () => {
    throw new Error('must not send');
  });
  db.prepare("UPDATE rental_requests SET status='cancelled'").run();
  assert.equal((await sender.send()).status, 'no_event');
  assert.equal(db.prepare('SELECT status FROM line_outbox').get().status, 'skipped');
  assert.throws(
    () => new EventSender(db, { url: 'http://example.invalid', token: 'dummy-test-token-only' }),
  );
  const before = db.prepare('SELECT count(*) AS n FROM line_outbox').get().n;
  assert.throws(() =>
    db.transaction(() => {
      createNfcRentalRequest(db, {
        deviceId: 'nfc-reader-01',
        cardUid: DEMO_CARD_UID,
        action: 'request',
        clientRequestId: crypto.randomUUID(),
      });
      throw new Error('rollback');
    })(),
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM line_outbox').get().n, before);
});
