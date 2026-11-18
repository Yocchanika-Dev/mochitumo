const fs = require('fs');

// 任意ファイルの暗黙読込・シェル実行・変数展開は行わない。
// process環境がファイル値より優先される。
function loadEnvironmentFile(filename = process.env.BACKEND_ENV_FILE, env = process.env) {
  if (!filename) return;
  const entries = [];
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line.trim());
    if (!match) throw new Error('Invalid environment file syntax');
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0])
        throw new Error('Invalid environment file syntax');
      value = value.slice(1, -1);
    }
    entries.push([match[1], value]);
  }
  for (const [key, value] of entries) if (env[key] === undefined) env[key] = value;
}

function validateRuntimeEnvironment(env = process.env) {
  if (!['off', 'mock', 'usb'].includes(env.SERIAL_MODE || 'off'))
    throw new Error('Invalid SERIAL_MODE');
  if (env.ENABLE_VIRTUAL_BIKE !== undefined && !['true', 'false'].includes(env.ENABLE_VIRTUAL_BIKE))
    throw new Error('Invalid ENABLE_VIRTUAL_BIKE');
  if (env.NODE_ENV === 'production' && env.ENABLE_VIRTUAL_BIKE === 'true')
    throw new Error('Virtual demo is forbidden in production');
  if (env.SERIAL_MODE === 'usb') {
    const baud = Number(env.SERIAL_BAUD_RATE || 115200);
    if (!env.SERIAL_PORT || !env.SERIAL_RELAY_ID || !Number.isSafeInteger(baud) || baud <= 0)
      throw new Error('Invalid USB serial configuration');
  }
  if (Boolean(env.BACKEND_EVENTS_URL) !== Boolean(env.BACKEND_EVENTS_TOKEN))
    throw new Error('Both notification URL and token are required');
  if (env.BACKEND_EVENTS_URL) {
    let url;
    try {
      url = new URL(env.BACKEND_EVENTS_URL);
    } catch {
      throw new Error('Invalid notification URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Notification URL requires HTTPS without credentials');
  }
}

module.exports = { loadEnvironmentFile, validateRuntimeEnvironment };
