const crypto = require('crypto');

async function main() {
  const base = process.env.LINE_BACKEND_URL || 'https://localhost:3000';
  const token = process.env.LINE_SERVICE_TOKEN;
  if (!token || token.length < 32) throw new Error('LINE_SERVICE_TOKEN (32文字以上) が必要です');
  if (new URL(base).protocol !== 'https:' && process.env.ALLOW_INSECURE_NFC_HTTP !== 'true')
    throw new Error('HTTPSを使用してください');
  const headers = { Authorization: `Bearer ${token}` };
  const requestId = process.env.LINE_MOCK_REQUEST_ID;
  let response;
  if (requestId) {
    const secret = process.env.LINE_CHANNEL_SECRET;
    const userId = process.env.LINE_MOCK_USER_ID;
    if (!secret || !userId) throw new Error('LINE_CHANNEL_SECRET と LINE_MOCK_USER_ID が必要です');
    const action = process.env.LINE_MOCK_ACTION || 'approve';
    const body = JSON.stringify({
      events: [
        {
          type: 'postback',
          webhookEventId: process.env.LINE_MOCK_EVENT_ID || crypto.randomUUID(),
          source: { userId },
          postback: {
            data: JSON.stringify({
              action,
              request_id: requestId,
              bike_id: process.env.LINE_MOCK_BIKE_ID || 'B003',
            }),
          },
        },
      ],
    });
    response = await fetch(`${base}/webhooks/line`, {
      method: 'POST',
      body,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'X-Line-Signature': crypto.createHmac('sha256', secret).update(body).digest('base64'),
      },
    });
  } else response = await fetch(`${base}/api/line/requests`, { headers });
  console.log(`HTTP ${response.status}`);
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
}
main().catch(() => {
  console.error('Mock LINE failed: URL・認証設定・接続状態を確認してください');
  process.exitCode = 1;
});
