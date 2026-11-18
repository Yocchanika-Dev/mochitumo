const BASE_URL = process.env.ATOM_SERVER_URL || 'http://localhost:3000';
const POLL_INTERVAL_MS = 1000;
const executedCommandIds = new Set();
let polling = false;

async function completeCommand(commandId) {
  const response = await fetch(`${BASE_URL}/api/bikes/03/commands/${commandId}/complete`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`完了通知に失敗しました: HTTP ${response.status}`);
  }

  console.log(`Command completed: ${commandId}`);
}

function executeCommand(command) {
  console.log('[Virtual Atom Bike03]');
  console.log(`Received command: ${command.type}`);

  if (command.type === 'LIGHT') {
    console.log('💡 LED ON');
  } else if (command.type === 'UNLOCK') {
    console.log('🔓 LOCK OPEN');
  } else {
    throw new Error(`未対応のコマンドです: ${command.type}`);
  }
}

async function pollCommand() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch(`${BASE_URL}/api/bikes/03/command`);
    if (!response.ok) {
      throw new Error(`コマンド取得に失敗しました: HTTP ${response.status}`);
    }

    const command = await response.json();
    if (command.command === 'NONE') {
      return;
    }

    if (executedCommandIds.has(command.commandId)) {
      console.log(`[Virtual Atom Bike03] ${command.commandId} は既に実行済みなので再実行しません`);
      await completeCommand(command.commandId);
      return;
    }

    executeCommand(command);
    executedCommandIds.add(command.commandId);
    await completeCommand(command.commandId);
  } catch (error) {
    console.error(`[Virtual Atom Bike03] ${error.message}`);
  } finally {
    polling = false;
  }
}

console.log(`[Virtual Atom Bike03] Polling ${BASE_URL} every 1 second`);
pollCommand();
setInterval(pollCommand, POLL_INTERVAL_MS);
