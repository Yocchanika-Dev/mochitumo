const { HttpError } = require('./errors');

function invalidRequest() {
  throw new HttpError(400, 'INVALID_REQUEST', 'リクエスト形式が正しくありません');
}

function validateEventId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    invalidRequest();
  }
  return value;
}

function validateResourceId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) invalidRequest();
  return value;
}

function validateConfirmationId(value) {
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    invalidRequest();
  return value;
}

module.exports = { invalidRequest, validateEventId, validateResourceId, validateConfirmationId };
