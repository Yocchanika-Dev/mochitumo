const crypto = require('crypto');
const { HttpError } = require('../http/errors');
const { verifyDeviceKey } = require('../security/device-key');

const FAKE_SALT = crypto
  .createHash('sha256')
  .update('unknown-device-salt')
  .digest('hex')
  .slice(0, 32);
const FAKE_HASH = crypto.scryptSync('unknown-device-key', Buffer.from(FAKE_SALT, 'hex'), 32);

function invalidCredentials() {
  return new HttpError(401, 'DEVICE_AUTH_FAILED', '端末認証に失敗しました');
}

function authenticateNfcDevice(db) {
  const findDevice = db.prepare(`
    SELECT device_id, device_key_salt, device_key_hash, status
    FROM devices
    WHERE device_id = ?
  `);
  const touchDevice = db.prepare(`
    UPDATE devices
    SET last_authenticated_at = ?, updated_at = ?
    WHERE device_id = ?
  `);

  return (req, res, next) => {
    const deviceId = req.get('X-Device-Id');
    const deviceKey = req.get('X-Device-Key');

    if (
      typeof deviceId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(deviceId) ||
      typeof deviceKey !== 'string' ||
      deviceKey.length < 16 ||
      deviceKey.length > 256
    ) {
      return next(invalidCredentials());
    }

    const device = findDevice.get(deviceId);
    const verified = device
      ? verifyDeviceKey(deviceKey, device.device_key_salt, device.device_key_hash)
      : verifyDeviceKey(deviceKey, FAKE_SALT, FAKE_HASH.toString('hex'));

    if (!device || !verified || device.status !== 'active') {
      return next(invalidCredentials());
    }

    const now = new Date().toISOString();
    touchDevice.run(now, now, device.device_id);
    req.auth = { deviceId: device.device_id, type: 'nfc_device' };
    return next();
  };
}

module.exports = { authenticateNfcDevice };
