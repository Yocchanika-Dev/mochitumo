const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db/database');
const {
  DEMO_CARD_UID,
  DEMO_DEVICE_ID,
  DEMO_DEVICE_KEY,
  seedDevelopmentData,
} = require('../src/db/seed');
const { disableNfcCard, replaceNfcCard } = require('../src/nfc/card-service');

const REQUEST_ID_1 = '550e8400-e29b-41d4-a716-446655440000';
const REQUEST_ID_2 = '550e8400-e29b-41d4-a716-446655440001';

async function startServer(db, appOptions = {}) {
  const app = createApp({ db, requireHttps: false, ...appOptions });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  return { app, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function makeClient(baseUrl) {
  return async function postRequest({
    body = {
      card_uid: DEMO_CARD_UID,
      action: 'request',
      client_request_id: REQUEST_ID_1,
    },
    deviceId = DEMO_DEVICE_ID,
    deviceKey = DEMO_DEVICE_KEY,
    rawBody,
  } = {}) {
    const response = await fetch(`${baseUrl}/api/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId,
        'X-Device-Key': deviceKey,
      },
      body: rawBody ?? JSON.stringify(body),
    });
    return { response, body: await response.json() };
  };
}

async function createContext(t, appOptions = {}) {
  const db = openDatabase(':memory:');
  seedDevelopmentData(db, { deviceKey: DEMO_DEVICE_KEY });
  const running = await startServer(db, appOptions);

  t.after(async () => {
    await stopServer(running.server);
    if (db.open) {
      db.close();
    }
  });

  return { ...running, db, postRequest: makeClient(running.baseUrl) };
}

function setRequestStatus(db, requestId, status) {
  if (status === 'cancelled') {
    db.prepare(
      `
      UPDATE rental_requests
      SET status = 'cancelled', cancelled_at = ?, updated_at = ?
      WHERE request_id = ?
    `,
    ).run(new Date().toISOString(), new Date().toISOString(), requestId);
    return;
  }

  db.prepare(
    `
    UPDATE rental_requests
    SET status = ?, lender_student_id = 'S1002', bike_id = 'B003', updated_at = ?
    WHERE request_id = ?
  `,
  ).run(status, new Date().toISOString(), requestId);
}

test('正常な新規申請は201と確定レスポンスを返す', async (t) => {
  const { db, postRequest } = await createContext(t);
  const result = await postRequest();

  assert.equal(result.response.status, 201);
  assert.deepEqual(Object.keys(result.body).sort(), [
    'request_id',
    'status',
    'student_id',
    'success',
  ]);
  assert.equal(result.body.success, true);
  assert.match(result.body.request_id, /^req_/);
  assert.equal(result.body.student_id, 'S1001');
  assert.equal(result.body.status, 'requesting');

  const stored = db
    .prepare('SELECT * FROM rental_requests WHERE request_id = ?')
    .get(result.body.request_id);
  assert.equal(stored.source_device_id, DEMO_DEVICE_ID);
  assert.equal(stored.client_request_id, REQUEST_ID_1);
});

test('同じ内容の再送は200で初回と同じ結果を返す', async (t) => {
  const { db, postRequest } = await createContext(t);
  const first = await postRequest();
  setRequestStatus(db, first.body.request_id, 'approved');
  const replay = await postRequest({
    body: {
      card_uid: '01:2e:5c:e5:d8:10:70:67',
      action: 'request',
      client_request_id: REQUEST_ID_1,
    },
  });

  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal(replay.body.status, 'requesting');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rental_requests').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get().count, 1);
});

test('同じ操作IDで異なる内容ならIDEMPOTENCY_CONFLICT', async (t) => {
  const { postRequest } = await createContext(t);
  await postRequest();
  const conflict = await postRequest({
    body: {
      card_uid: 'FFFFFFFFFFFFFFFF',
      action: 'request',
      client_request_id: REQUEST_ID_1,
    },
  });

  assert.equal(conflict.response.status, 409);
  assert.deepEqual(conflict.body, {
    success: false,
    error: 'IDEMPOTENCY_CONFLICT',
    message: '同じ操作IDで異なる申請内容が送信されました',
  });
});

test('requesting・approved・rented中の別申請を拒否する', async (t) => {
  for (const status of ['requesting', 'approved', 'rented']) {
    await t.test(status, async (child) => {
      const { db, postRequest } = await createContext(child);
      const first = await postRequest();
      if (status !== 'requesting') {
        setRequestStatus(db, first.body.request_id, status);
      }

      const duplicate = await postRequest({
        body: {
          card_uid: DEMO_CARD_UID,
          action: 'request',
          client_request_id: REQUEST_ID_2,
        },
      });

      assert.equal(duplicate.response.status, 409);
      assert.equal(duplicate.body.error, 'ACTIVE_REQUEST_EXISTS');
      assert.equal(duplicate.body.existing_request_id, first.body.request_id);
      assert.equal(duplicate.body.existing_status, status);
    });
  }
});

test('cancelled・returned後は新規申請を許可する', async (t) => {
  for (const status of ['cancelled', 'returned']) {
    await t.test(status, async (child) => {
      const { db, postRequest } = await createContext(child);
      const first = await postRequest();
      setRequestStatus(db, first.body.request_id, status);
      const next = await postRequest({
        body: {
          card_uid: DEMO_CARD_UID,
          action: 'request',
          client_request_id: REQUEST_ID_2,
        },
      });

      assert.equal(next.response.status, 201);
      assert.notEqual(next.body.request_id, first.body.request_id);
    });
  }
});

test('FeliCa IDmを大文字化し区切りを除去して先頭0を保持する', async (t) => {
  for (const cardUid of [
    '012e5ce5d8107067',
    '01:2e:5c:e5:d8:10:70:67',
    '01-2e-5c-e5-d8-10-70-67',
  ]) {
    await t.test(cardUid, async (child) => {
      const { db, postRequest } = await createContext(child);
      const result = await postRequest({
        body: {
          card_uid: cardUid,
          action: 'request',
          client_request_id: REQUEST_ID_1,
        },
      });
      assert.equal(result.response.status, 201);
      assert.equal(
        db
          .prepare('SELECT card_uid FROM nfc_cards WHERE student_id = ? AND status = ?')
          .get('S1001', 'active').card_uid,
        '012E5CE5D8107067',
      );
    });
  }
});

test('16桁以外・不正文字・空白を含むIDmを拒否する', async (t) => {
  const invalidValues = [
    '12E5CE5D8107067',
    '0012E5CE5D8107067',
    '012E5CE5D810706Z',
    '01 2E 5C E5 D8 10 70 67',
  ];

  for (const cardUid of invalidValues) {
    await t.test(cardUid, async (child) => {
      const { postRequest } = await createContext(child);
      const result = await postRequest({
        body: {
          card_uid: cardUid,
          action: 'request',
          client_request_id: REQUEST_ID_1,
        },
      });
      assert.equal(result.response.status, 400);
      assert.equal(result.body.error, 'INVALID_REQUEST');
    });
  }
});

test('未登録カードをCARD_NOT_REGISTEREDで拒否する', async (t) => {
  const { postRequest } = await createContext(t);
  const result = await postRequest({
    body: {
      card_uid: 'FFFFFFFFFFFFFFFF',
      action: 'request',
      client_request_id: REQUEST_ID_1,
    },
  });
  assert.equal(result.response.status, 404);
  assert.equal(result.body.error, 'CARD_NOT_REGISTERED');
});

test('無効カードをCARD_DISABLEDで拒否する', async (t) => {
  const { db, postRequest } = await createContext(t);
  disableNfcCard(db, DEMO_CARD_UID);
  const result = await postRequest();
  assert.equal(result.response.status, 403);
  assert.equal(result.body.error, 'CARD_DISABLED');
});

test('カード再発行では旧IDmを無効化して新IDmを利用できる', async (t) => {
  const { db, postRequest } = await createContext(t);
  const replacementUid = '1122334455667788';
  replaceNfcCard(db, DEMO_CARD_UID, replacementUid);

  const oldCard = await postRequest();
  const newCard = await postRequest({
    body: {
      card_uid: replacementUid,
      action: 'request',
      client_request_id: REQUEST_ID_2,
    },
  });
  assert.equal(oldCard.body.error, 'CARD_DISABLED');
  assert.equal(newCard.response.status, 201);
});

test('未登録・不正キー・無効端末をDEVICE_AUTH_FAILEDで拒否する', async (t) => {
  const { db, postRequest } = await createContext(t);
  const unknown = await postRequest({ deviceId: 'unknown-reader' });
  const wrongKey = await postRequest({ deviceKey: 'wrong-device-key-0000' });
  db.prepare("UPDATE devices SET status = 'disabled' WHERE device_id = ?").run(DEMO_DEVICE_ID);
  const disabled = await postRequest();

  for (const result of [unknown, wrongKey, disabled]) {
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error, 'DEVICE_AUTH_FAILED');
  }
});

test('端末認証後に不正JSON・余分なstudent_id・不正actionを拒否する', async (t) => {
  const { postRequest } = await createContext(t);
  const malformed = await postRequest({ rawBody: '{"card_uid":' });
  const withStudentId = await postRequest({
    body: {
      card_uid: DEMO_CARD_UID,
      action: 'request',
      client_request_id: REQUEST_ID_1,
      student_id: 'S9999',
    },
  });
  const unsupported = await postRequest({
    body: {
      card_uid: DEMO_CARD_UID,
      action: 'cancel',
      client_request_id: REQUEST_ID_2,
    },
  });

  for (const result of [malformed, withStudentId, unsupported]) {
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, 'INVALID_REQUEST');
  }
});

test('同時再送でもrequestを1件だけ作成する', async (t) => {
  const { db, postRequest } = await createContext(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => postRequest()));
  const statuses = results.map((result) => result.response.status);
  assert.equal(statuses.filter((status) => status === 201).length, 1);
  assert.equal(statuses.filter((status) => status === 200).length, 7);
  assert.equal(new Set(results.map((result) => result.body.request_id)).size, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rental_requests').get().count, 1);
});

test('サーバー再起動後も同じ初回結果を返す', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobaeco-nfc-test-'));
  const databasePath = path.join(tempDir, 'restart.sqlite');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const firstDb = openDatabase(databasePath);
  seedDevelopmentData(firstDb, { deviceKey: DEMO_DEVICE_KEY });
  const firstServer = await startServer(firstDb);
  const first = await makeClient(firstServer.baseUrl)();
  await stopServer(firstServer.server);
  firstDb.close();

  const secondDb = openDatabase(databasePath);
  const secondServer = await startServer(secondDb);
  const replay = await makeClient(secondServer.baseUrl)();
  await stopServer(secondServer.server);
  secondDb.close();

  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, first.body);
});

test('DB内部エラーでスタックトレースや端末キーを返さない', async (t) => {
  const { db, postRequest } = await createContext(t);
  const secret = 'secret-device-key-never-return';
  db.close();
  const result = await postRequest({ deviceKey: secret });
  const serialized = JSON.stringify(result.body);

  assert.equal(result.response.status, 500);
  assert.deepEqual(result.body, {
    success: false,
    error: 'INTERNAL_ERROR',
    message: 'サーバー内部でエラーが発生しました',
  });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.toLowerCase().includes('stack'), false);
});

test('HTTPS必須設定ではHTTPを拒否する', async (t) => {
  const { postRequest } = await createContext(t, { requireHttps: true });
  const result = await postRequest();
  assert.equal(result.response.status, 426);
  assert.equal(result.body.error, 'HTTPS_REQUIRED');
});

test('不正な端末キーをログへ出力しない', async (t) => {
  const { postRequest } = await createContext(t);
  const secret = 'invalid-secret-key-never-log';
  const messages = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => messages.push(args.join(' '));
  console.error = (...args) => messages.push(args.join(' '));

  try {
    const result = await postRequest({ deviceKey: secret });
    assert.equal(result.response.status, 401);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(messages.join('\n').includes(secret), false);
});
