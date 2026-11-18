class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof HttpError ? error.message : 'サーバー内部でエラーが発生しました';
  const details = error instanceof HttpError ? error.details : {};

  return res.status(status).json({
    success: false,
    error: code,
    message,
    ...details,
  });
}

function errorHandler(error, req, res, next) {
  if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
    return sendError(res, new HttpError(400, 'INVALID_REQUEST', 'JSONの形式が正しくありません'));
  }
  if (res.headersSent) return next(error);
  return sendError(res, error);
}

module.exports = { HttpError, sendError, errorHandler };
