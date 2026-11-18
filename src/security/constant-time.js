const crypto = require('crypto');

function constantTimeEqual(left, right) {
  if (left == null || right == null) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { constantTimeEqual };
