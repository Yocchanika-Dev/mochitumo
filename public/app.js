const lightButton = document.querySelector('#light-button');
const unlockButton = document.querySelector('#unlock-button');
const message = document.querySelector('#message');

async function sendCommand(endpoint, button) {
  const buttons = [lightButton, unlockButton];
  buttons.forEach((item) => {
    item.disabled = true;
  });

  message.className = 'message';
  message.textContent = '命令を送信しています…';

  try {
    const response = await fetch(endpoint, { method: 'POST' });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || '命令の送信に失敗しました');
    }

    message.className = 'message success';
    message.textContent = data.message;
  } catch (error) {
    console.error(error);
    message.className = 'message error';
    message.textContent = '通信に失敗しました。サーバーを確認してください。';
  } finally {
    buttons.forEach((item) => {
      item.disabled = false;
    });
    button.focus();
  }
}

lightButton.addEventListener('click', () => {
  sendCommand('/api/bikes/03/light', lightButton);
});

unlockButton.addEventListener('click', () => {
  sendCommand('/api/bikes/03/unlock', unlockButton);
});
