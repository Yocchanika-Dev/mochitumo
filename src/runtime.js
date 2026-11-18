function getEventDeliveryOptions(env = process.env) {
  return env.BACKEND_EVENTS_URL && env.BACKEND_EVENTS_TOKEN
    ? { url: env.BACKEND_EVENTS_URL, token: env.BACKEND_EVENTS_TOKEN }
    : undefined;
}

function createRuntimeOptions(env = process.env) {
  require('./config').validateRuntimeEnvironment(env);
  let serialAdapter;
  if (env.SERIAL_MODE === 'usb') {
    if (!env.SERIAL_PORT || !env.SERIAL_RELAY_ID)
      throw new Error('SERIAL_PORT and SERIAL_RELAY_ID are required');
    const { UsbSerialAdapter } = require('./serial/adapters');
    serialAdapter = new UsbSerialAdapter({
      path: env.SERIAL_PORT,
      baudRate: Number(env.SERIAL_BAUD_RATE || 115200),
    });
  } else if (env.SERIAL_MODE === 'mock') {
    const { MockSerialAdapter } = require('./serial/adapters');
    serialAdapter = new MockSerialAdapter();
  }
  return {
    databasePath: env.DATABASE_PATH,
    enableVirtualBike: env.NODE_ENV !== 'production' && env.ENABLE_VIRTUAL_BIKE === 'true',
    requireHttps: env.NODE_ENV === 'production' || env.ALLOW_INSECURE_NFC_HTTP !== 'true',
    trustProxy: env.TRUST_PROXY,
    serialAdapter,
    serialOptions: { relayId: env.SERIAL_RELAY_ID },
    eventDelivery: getEventDeliveryOptions(env),
  };
}
module.exports = { createRuntimeOptions, getEventDeliveryOptions };
