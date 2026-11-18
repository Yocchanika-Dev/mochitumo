const crypto = require('crypto');
const { HttpError } = require('../http/errors');
const {
  invalidRequest,
  validateEventId,
  validateResourceId,
  validateConfirmationId,
} = require('../http/validation');
const { constantTimeEqual } = require('../security/constant-time');
const { approve, cancel, requestLock } = require('../rental/service');
const { listAvailableOwnedBikes } = require('../rental/queries');

function processLineEvent(db, event, requestId) {
  if (!event || typeof event !== 'object') invalidRequest();
  if (event.type !== 'postback') return { ignored: true };
  if (typeof event.source?.userId !== 'string') invalidRequest();

  const user = db
    .prepare(
      `
    SELECT student_id FROM users WHERE line_user_id = ? AND status = 'active'
  `,
    )
    .get(event.source.userId);
  if (!user) {
    throw new HttpError(403, 'LINE_ACCOUNT_NOT_LINKED', 'LINE連携済みの利用者が必要です');
  }

  let data;
  try {
    data = JSON.parse(event.postback?.data);
  } catch {
    invalidRequest();
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalidRequest();
  if (data.action === 'list_bikes' && !requestId) {
    if (data.request_id !== undefined) validateResourceId(data.request_id);
    if (data.confirmation_id !== undefined) {
      validateConfirmationId(data.confirmation_id);
      validateResourceId(data.request_id);
    }
    validateEventId(event.webhookEventId);
    return { bikes: listAvailableOwnedBikes(db, user.student_id) };
  }
  if (typeof data.request_id !== 'string') invalidRequest();
  if (requestId && (data.request_id !== requestId || data.action !== 'approve')) invalidRequest();

  const input = {
    id: data.request_id,
    studentId: user.student_id,
    eventId: validateEventId(event.webhookEventId),
  };
  if (data.action === 'approve') {
    validateResourceId(data.request_id);
    validateResourceId(data.bike_id);
    if (data.confirmation_id !== undefined) validateConfirmationId(data.confirmation_id);
    return approve(db, { ...input, bikeId: data.bike_id, confirmationId: data.confirmation_id });
  }
  if (data.action === 'cancel') return cancel(db, { ...input, source: 'line' });
  if (data.action === 'lock') return requestLock(db, input);
  invalidRequest();
}

function createLineWebhookHandler(db, secret) {
  return (req, res) => {
    if (!secret) throw new HttpError(503, 'LINE_NOT_CONFIGURED', 'LINE署名検証が未設定です');
    if (!Buffer.isBuffer(req.body)) invalidRequest();
    const expected = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
    if (!constantTimeEqual(req.get('X-Line-Signature'), expected)) {
      throw new HttpError(401, 'INVALID_LINE_SIGNATURE', 'LINE署名が不正です');
    }
    let body;
    try {
      body = JSON.parse(req.body.toString('utf8'));
    } catch {
      invalidRequest();
    }
    if (!body || !Array.isArray(body.events) || body.events.length > 100) invalidRequest();
    if (req.params.id && body.events.length !== 1) invalidRequest();
    // 各イベントのトランザクションは独立。途中失敗時も成功済みreceiptは保持する。
    res.json({ results: body.events.map((event) => processLineEvent(db, event, req.params.id)) });
  };
}

module.exports = { createLineWebhookHandler };
