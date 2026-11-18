const crypto = require('crypto');
const { DEMO_DEVICE_ID, DEMO_DEVICE_KEY, DEMO_CARD_UID } = require('./src/development-defaults');

const apiUrl = process.env.NFC_API_URL || 'http://localhost:3000';
const deviceId = process.env.NFC_MOCK_DEVICE_ID || DEMO_DEVICE_ID;
const deviceKey = process.env.NFC_MOCK_DEVICE_KEY || DEMO_DEVICE_KEY;
const cardUid = process.env.NFC_MOCK_CARD_UID || DEMO_CARD_UID;
const action = process.env.NFC_ACTION || 'request';
const clientRequestId = process.env.NFC_CLIENT_REQUEST_ID || crypto.randomUUID();

async function main() {
  const operation = process.env.NFC_OPERATION || 'request';
  if (!['request', 'status', 'cancel', 'unlock'].includes(operation))
    throw new Error('NFC_OPERATIONが不正です');
  const requestId = process.env.NFC_REQUEST_ID;
  if (['status', 'cancel'].includes(operation) && !requestId)
    throw new Error('NFC_REQUEST_IDが必要です');
  const endpoint =
    operation === 'unlock'
      ? '/api/lock-reader/taps'
      : operation === 'request'
        ? '/api/requests'
        : `/api/requests/${encodeURIComponent(requestId)}${operation === 'cancel' ? '/cancel' : ''}`;
  const url = new URL(endpoint, apiUrl);
  if (url.protocol !== 'https:' && process.env.ALLOW_INSECURE_NFC_HTTP !== 'true') {
    throw new Error('HTTPでのMock NFC実行にはALLOW_INSECURE_NFC_HTTP=trueが必要です');
  }

  console.log(`[Mock NFC] Sending request from device ${deviceId}`);
  console.log(`[Mock NFC] client_request_id: ${clientRequestId}`);

  let body;
  if (operation === 'request') {
    body = { card_uid: cardUid, action, client_request_id: clientRequestId };
  } else if (operation === 'cancel') {
    body = { card_uid: cardUid, event_id: process.env.NFC_EVENT_ID || clientRequestId };
  } else if (operation === 'unlock') {
    body = { card_uid: cardUid, action: 'unlock', client_request_id: clientRequestId };
  }
  const response = await fetch(url, {
    method: operation === 'status' ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': deviceId,
      'X-Device-Key': deviceKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const result = await response.json();
  console.log(`[Mock NFC] HTTP ${response.status}`);
  console.log(JSON.stringify(result, null, 2));

  if (!response.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[Mock NFC] ${error.message}`);
  process.exitCode = 1;
});
