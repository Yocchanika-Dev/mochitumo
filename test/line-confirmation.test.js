const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db/database');
const { seedDevelopmentData, DEMO_CARD_UID } = require('../src/db/seed');
const { createNfcRentalRequest } = require('../src/nfc/request-service');

async function setup(t) {
  const db = openDatabase(':memory:');
  seedDevelopmentData(db);
  const id = createNfcRentalRequest(db, {
    deviceId: 'nfc-reader-01',
    cardUid: DEMO_CARD_UID,
    action: 'request',
    clientRequestId: crypto.randomUUID(),
  }).response.request_id;
  const token = 'dummy-service-token-for-confirmation-tests';
  const secret = 'dummy-signature-secret';
  const server = createApp({
    db,
    requireHttps: false,
    lineToken: token,
    lineSecret: secret,
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
    db.close();
  });
  const confirmation = crypto.randomUUID();
  const approval = {
    action: 'approve',
    request_id: id,
    bike_id: 'B003',
    confirmation_id: confirmation,
  };
  async function send(data, eventId = 'event-1', metadata = {}, signatureValid = true) {
    const raw = JSON.stringify({
      events: [
        {
          type: 'postback',
          webhookEventId: eventId,
          source: { userId: 'U_DEMO_LENDER' },
          postback: { data: JSON.stringify(data) },
          ...metadata,
        },
      ],
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/line`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Line-Signature': signatureValid
          ? crypto.createHmac('sha256', secret).update(raw).digest('base64')
          : 'invalid',
      },
      body: raw,
    });
    return { status: response.status, body: await response.json() };
  }
  return { db, id, confirmation, approval, send };
}

test('confirmation付き承認・メタデータ再配達は初回JSON、命令なし、同IDの各業務項目変更は409', async (t) => {
  const { db, approval, send } = await setup(t);
  const first = await send(approval, 'event-1', {
    replyToken: 'dummy-first',
    deliveryContext: { isRedelivery: false },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.results[0].request.status, 'approved');
  assert.equal(first.body.results[0].lock_command, null);
  assert.equal(first.body.results[0].next_action, 'tap_card');
  const receipt = db.prepare('SELECT * FROM operation_receipts').get();
  assert.deepEqual(
    await send(approval, 'event-1', {
      replyToken: 'dummy-retry',
      deliveryContext: { isRedelivery: true },
    }),
    first,
  );
  for (const changed of [
    { confirmation_id: crypto.randomUUID() },
    { request_id: 'req_other' },
    { bike_id: 'B_other' },
  ]) {
    const response = await send({ ...approval, ...changed });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'IDEMPOTENCY_CONFLICT');
  }
  const { confirmation_id, ...without } = approval;
  assert.equal((await send(without)).body.error, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(db.prepare('SELECT * FROM operation_receipts').get(), receipt);
  assert.equal(db.prepare('SELECT count(*) n FROM lock_commands').get().n, 0);
});

test('旧形式receiptを同じ旧本文で再現し、confirmation後付けは衝突、既存receiptは不変', async (t) => {
  const { db, id, approval, send } = await setup(t);
  const { confirmation_id, ...legacy } = approval;
  const initial = await send(legacy);
  assert.equal(initial.status, 200);
  // 移行前と同じ入力順・SHA256の固定形式を独立に作る。
  const oldHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ id, studentId: 'S1002', bikeId: 'B003', action: 'approve' }))
    .digest('hex');
  assert.equal(db.prepare('SELECT fingerprint FROM operation_receipts').get().fingerprint, oldHash);
  const historic = {
    results: [
      {
        request: { request_id: id, status: 'approved', bike_id: 'B003' },
        lock_command: null,
        next_action: 'tap_card',
        legacy_fixture: true,
      },
    ],
  };
  db.prepare('UPDATE operation_receipts SET response_json=?').run(
    JSON.stringify(historic.results[0]),
  );
  const before = db.prepare('SELECT * FROM operation_receipts').get();
  assert.deepEqual((await send(legacy)).body, historic);
  assert.equal((await send(approval)).body.error, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(db.prepare('SELECT * FROM operation_receipts').get(), before);
});

test('承認応答喪失の再確認はUI時間や最新状態に依存せず、再タッチ新eventはINVALID_STATE', async (t) => {
  const { db, id, approval, send } = await setup(t);
  const first = await send(approval);
  const newTap = await send(approval, 'new-tap-while-approved');
  assert.equal(newTap.status, 409);
  assert.equal(newTap.body.error, 'INVALID_STATE');
  // 独立テストDBで後続状態を模擬。実機の解錠成功を証明するものではない。
  db.prepare("UPDATE rental_requests SET status='rented' WHERE request_id=?").run(id);
  assert.deepEqual(
    await send(approval, 'event-1', {
      timestamp: 1,
      replyToken: 'another-dummy',
      deliveryContext: { isRedelivery: true },
    }),
    first,
  );
  const repeated = await send(approval, 'new-tap-event');
  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.error, 'INVALID_STATE');
  assert.equal(db.prepare('SELECT count(*) n FROM operation_receipts').get().n, 1);
});

test('list_bikes追加項目を許容、未知キー無視、再送は最新値で状態・receipt・命令を変更しない', async (t) => {
  const { db, id, confirmation, send } = await setup(t);
  const data = {
    action: 'list_bikes',
    request_id: id,
    confirmation_id: confirmation,
    extra: 'ignored',
  };
  assert.deepEqual((await send(data)).body, {
    results: [{ bikes: [{ bike_id: 'B003', availability: 'available' }] }],
  });
  db.prepare("UPDATE bikes SET availability='maintenance' WHERE bike_id='B003'").run();
  assert.deepEqual((await send({ ...data, confirmation_id: crypto.randomUUID() })).body, {
    results: [{ bikes: [] }],
  });
  assert.equal(
    db.prepare('SELECT status FROM rental_requests WHERE request_id=?').get(id).status,
    'requesting',
  );
  assert.equal(db.prepare('SELECT count(*) n FROM operation_receipts').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM lock_commands').get().n, 0);
  assert.equal((await send({ action: 'list_bikes' })).status, 200);
});

test('型・空白・129文字ID・非v4/不正UUIDは400、形式不正で申請を更新しない', async (t) => {
  const { db, approval, send } = await setup(t);
  for (const confirmation_id of [
    null,
    3,
    '',
    '550e8400-e29b-11d4-a716-446655440000',
    '550e8400-e29b-41d4-7716-446655440000',
    ' ' + crypto.randomUUID(),
    crypto.randomUUID() + '\n',
  ]) {
    assert.equal((await send({ ...approval, confirmation_id })).status, 400);
    assert.equal(
      (await send({ action: 'list_bikes', request_id: approval.request_id, confirmation_id }))
        .status,
      400,
    );
  }
  for (const value of [null, 3, '', '   ', 'x'.repeat(129)]) {
    assert.equal((await send({ ...approval, request_id: value })).status, 400);
    assert.equal((await send({ ...approval, bike_id: value })).status, 400);
    assert.equal((await send({ action: 'list_bikes', request_id: value })).status, 400);
  }
  assert.equal(
    (await send({ action: 'list_bikes', confirmation_id: approval.confirmation_id })).status,
    400,
  );
  assert.equal(db.prepare('SELECT count(*) n FROM operation_receipts').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM rental_requests').get().status, 'requesting');
});

test('128文字のリソースIDは形式検証を通過し、未知キーは承認fingerprintに含めない', async (t) => {
  const { approval, send } = await setup(t);
  assert.equal(
    (
      await send({
        action: 'list_bikes',
        request_id: 'x'.repeat(128),
        confirmation_id: approval.confirmation_id,
      })
    ).status,
    200,
  );
  assert.equal(
    (await send({ ...approval, bike_id: 'x'.repeat(128) })).body.error,
    'BIKE_NOT_FOUND',
  );
  assert.equal(
    (await send({ ...approval, request_id: 'x'.repeat(128) })).body.error,
    'REQUEST_NOT_FOUND',
  );
  const first = await send({ ...approval, extra: 'ignored' });
  assert.equal(first.status, 200);
  assert.deepEqual(await send({ ...approval, extra: 'changed' }), first);
});

test('再送でも署名と現在の有効本人紐付けが必要', async (t) => {
  const { db, approval, send } = await setup(t);
  assert.equal((await send(approval)).status, 200);
  assert.equal((await send(approval, 'event-1', {}, false)).status, 401);
  db.prepare("UPDATE users SET status='disabled' WHERE student_id='S1002'").run();
  const replay = await send(approval);
  assert.equal(replay.status, 403);
  assert.equal(replay.body.error, 'LINE_ACCOUNT_NOT_LINKED');
});
