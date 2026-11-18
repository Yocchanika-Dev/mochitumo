const { HttpError } = require('./errors');
const { constantTimeEqual } = require('../security/constant-time');

function requireHttps(required, message = 'HTTPSが必要です') {
  return (req, res, next) => {
    if (required && !req.secure) {
      return next(new HttpError(426, 'HTTPS_REQUIRED', message));
    }
    return next();
  };
}

function authenticateLineService(token) {
  return (req, res, next) => {
    if (!token || token.length < 32) {
      return next(new HttpError(503, 'LINE_NOT_CONFIGURED', 'LINE認証が未設定です'));
    }
    if (!constantTimeEqual(req.get('Authorization'), `Bearer ${token}`)) {
      return next(new HttpError(401, 'SERVICE_AUTH_FAILED', 'サービス認証に失敗しました'));
    }
    return next();
  };
}

module.exports = { requireHttps, authenticateLineService };
