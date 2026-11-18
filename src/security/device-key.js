const crypto = require('crypto');
const { constantTimeEqual } = require('./constant-time');

const DERIVED_KEY_LENGTH = 32;

function deriveDeviceKey(deviceKey, saltHex) {
  return crypto.scryptSync(deviceKey, Buffer.from(saltHex, 'hex'), DERIVED_KEY_LENGTH);
}

function createDeviceKeyRecord(deviceKey) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(deviceKey, salt, DERIVED_KEY_LENGTH);
  return {
    saltHex: salt.toString('hex'),
    hashHex: hash.toString('hex'),
  };
}

function verifyDeviceKey(deviceKey, saltHex, expectedHashHex) {
  try {
    const actual = deriveDeviceKey(deviceKey, saltHex);
    const expected = Buffer.from(expectedHashHex, 'hex');
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = {
  createDeviceKeyRecord,
  verifyDeviceKey,
};
