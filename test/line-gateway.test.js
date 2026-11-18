const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { openDatabase } = require('../src/db/database');
const { seedDevelopmentData } = require('../src/db/seed');
const { createLineGateway } = require('../src/http/line-gateway');
const { linkLineTestUser } = require('../scripts/link-line-test-user');

async function setup(t, options = {}) {
  const db = openDatabase(':memory:');
  seedDevelopmentData(db);
  const token = 'dummy-service-token-for-line-gateway-tests';
  const secret = 'dummy-line-secret';
  const app = createLineGateway(db, { lineToken: token, lineSecret: secret, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
    db.close();
  });
  return { db, token, secret, base: `http://127.0.0.1:${server.address().port}` };
}

test('LINE公開入口はNFC・仮想解錠・静的ファイルを公開しない', async (t) => {
  const { base, token } = await setup(t);
  for (const path of [
    '/',
    '/api/bikes',
    '/api/bikes/03/unlock',
    '/api/requests',
    '/api/lock-reader/taps',
  ]) {
    const r = await fetch(base + path, {
      method: path === '/' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(r.status, 404);
  }
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/api/line/requests')).status, 426);
  assert.equal(
    (await fetch(base + '/api/line/requests', { headers: { 'X-Forwarded-Proto': 'https' } }))
      .status,
    401,
  );
});

test('署名済みlist_bikesで本人のavailable車だけを取得・userIdの自称では取得できない', async (t) => {
  const { db, base, token, secret } = await setup(t);
  const send = (userId, signature = true, extra = {}) => {
    const body = JSON.stringify({
      events: [
        {
          type: 'postback',
          webhookEventId: 'list-bikes-event',
          source: { userId },
          postback: { data: JSON.stringify({ action: 'list_bikes', ...extra }) },
        },
      ],
    });
    return fetch(base + '/webhooks/line', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Forwarded-Proto': 'https',
        'X-Line-Signature': signature
          ? crypto.createHmac('sha256', secret).update(body).digest('base64')
          : 'bad',
      },
    });
  };
  assert.equal((await send('U_DEMO_LENDER', false)).status, 401);
  assert.equal((await send('unknown')).status, 403);
  const response = await send('U_DEMO_LENDER');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    results: [{ bikes: [{ bike_id: 'B003', availability: 'available' }] }],
  });
  db.prepare("UPDATE bikes SET availability='reserved' WHERE bike_id='B003'").run();
  assert.deepEqual(await (await send('U_DEMO_LENDER')).json(), { results: [{ bikes: [] }] });
});

test('管理者の確認済み登録は冪等・他人の車/LINE紐付けを奪わない', (t) => {
  const db = openDatabase(':memory:');
  seedDevelopmentData(db);
  t.after(() => db.close());
  const input = {
    student_id: 'S2000',
    name: '試験用',
    line_user_id: 'U_TEST_OWNER',
    bike_id: 'B020',
    verified_by_operator: true,
  };
  assert.throws(() => linkLineTestUser(db, { ...input, verified_by_operator: false }));
  assert.deepEqual(linkLineTestUser(db, input), {
    student_id: 'S2000',
    bike_id: 'B020',
    linked: true,
  });
  assert.deepEqual(linkLineTestUser(db, input), {
    student_id: 'S2000',
    bike_id: 'B020',
    linked: true,
  });
  assert.throws(() => linkLineTestUser(db, { ...input, student_id: 'S2001' }));
  assert.throws(() => linkLineTestUser(db, { ...input, line_user_id: 'U_NEW', bike_id: 'B003' }));
  assert.throws(() =>
    linkLineTestUser(db, {
      ...input,
      student_id: 'S2001',
      line_user_id: 'U_OTHER',
      bike_id: 'B003',
    }),
  );
  assert.throws(() => linkLineTestUser(db, { ...input, bike_id: 'B021' }));
  assert.equal(
    db.prepare('SELECT owner_student_id FROM bikes WHERE bike_id=?').get('B003').owner_student_id,
    'S1002',
  );
});

test('デモLINE紐付けも明示的な置換指定なしには変更しない', (t) => {
  const db = openDatabase(':memory:');
  seedDevelopmentData(db);
  t.after(() => db.close());
  const input = {
    student_id: 'S1002',
    name: '試験貸し手',
    line_user_id: 'U_VERIFIED_TEST_LENDER',
    bike_id: 'B003',
    verified_by_operator: true,
  };
  assert.throws(() => linkLineTestUser(db, input));
  assert.equal(linkLineTestUser(db, { ...input, replace_demo_link: true }).linked, true);
});
