const { HttpError } = require('../http/errors');

const ALLOWED_BODY_KEYS = new Set(['action', 'card_uid', 'client_request_id']);

function normalizeCardUid(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_REQUEST', 'card_uidは文字列で指定してください');
  }

  const normalized = value.replace(/[:-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(normalized)) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      'card_uidは区切り文字を除いて16桁の16進文字列で指定してください',
    );
  }

  return normalized;
}

function validateCardOperation(body, action) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'JSONオブジェクトを指定してください');
  }

  const keys = Object.keys(body);
  const hasUnexpectedKey = keys.some((key) => !ALLOWED_BODY_KEYS.has(key));
  if (hasUnexpectedKey || keys.length !== ALLOWED_BODY_KEYS.size) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      'Bodyにはcard_uid、action、client_request_idだけを指定してください',
    );
  }

  const cardUid = normalizeCardUid(body.card_uid);

  if (body.action !== action) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      action === 'request'
        ? 'MVPで利用できるactionはrequestだけです'
        : 'ロック側で利用できるactionはunlockだけです',
    );
  }

  if (
    typeof body.client_request_id !== 'string' ||
    !/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(
      body.client_request_id,
    )
  ) {
    throw new HttpError(400, 'INVALID_REQUEST', 'client_request_idはUUID形式で指定してください');
  }

  return {
    action,
    cardUid,
    clientRequestId: body.client_request_id,
  };
}

function validateRequestBody(body) {
  return validateCardOperation(body, 'request');
}
function validateLockTapBody(body) {
  return validateCardOperation(body, 'unlock');
}

module.exports = { normalizeCardUid, validateRequestBody, validateLockTapBody };
