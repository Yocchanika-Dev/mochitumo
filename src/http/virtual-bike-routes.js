const crypto = require('crypto');
const express = require('express');
const COMMAND_TYPES = Object.freeze({ LIGHT: 'LIGHT', UNLOCK: 'UNLOCK' });

// 既存v0.2互換のメモリ内デモ。正式貸出DB・USBとは独立している。
function createVirtualBikeRouter() {
  const router = express.Router();
  const bike = { id: '03', name: 'Bike 03', status: 'available', commands: [] };
  function createCommand(type) {
    const command = {
      commandId: crypto.randomUUID(),
      bikeId: bike.id,
      type,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    bike.commands.push(command);
    console.log(`[Bike03] Created command ${type}`);
    console.log(`Command ID: ${command.commandId}`);
    return command;
  }
  router.get('/bikes', (req, res) => {
    res.json([{ id: bike.id, name: bike.name, status: bike.status }]);
  });
  router.post('/bikes/03/light', (req, res) => {
    res.status(201).json({
      ...createCommand(COMMAND_TYPES.LIGHT),
      message: 'Bike03を光らせる命令を送信しました',
    });
  });
  router.post('/bikes/03/unlock', (req, res) => {
    res
      .status(201)
      .json({ ...createCommand(COMMAND_TYPES.UNLOCK), message: 'Bike03に解錠命令を送信しました' });
  });
  router.get('/bikes/03/command', (req, res) => {
    res.json(bike.commands.find((command) => command.status === 'pending') || { command: 'NONE' });
  });
  router.post('/bikes/03/commands/:commandId/complete', (req, res) => {
    const command = bike.commands.find((item) => item.commandId === req.params.commandId);
    if (!command)
      return res
        .status(404)
        .json({ error: 'COMMAND_NOT_FOUND', message: '指定されたコマンドが見つかりません' });
    if (command.status === 'completed') {
      console.log(`[Bike03] Command already completed: ${command.commandId}`);
      return res.json(command);
    }
    command.status = 'completed';
    command.completedAt = new Date().toISOString();
    console.log(`[Bike03] Command completed: ${command.commandId}`);
    return res.json(command);
  });
  router.get('/bikes/03/commands', (req, res) => res.json(bike.commands));
  return router;
}
module.exports = { createVirtualBikeRouter };
