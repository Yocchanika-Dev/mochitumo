const { EventEmitter } = require('events');

class MockSerialAdapter extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.sent = [];
  }
  start() {
    this.connected = true;
    this.emit('open');
  }
  write(line) {
    if (!this.connected) throw new Error('disconnected');
    this.sent.push(line);
    this.emit('sent', JSON.parse(line));
  }
  receive(line) {
    this.emit('data', line);
  }
  disconnect() {
    this.connected = false;
    this.emit('close');
  }
  close() {
    this.disconnect();
  }
}

class UsbSerialAdapter extends EventEmitter {
  constructor({ path, baudRate = 115200, reconnectMs = 2000, createPort } = {}) {
    super();
    Object.assign(this, { path, baudRate, reconnectMs, connected: false, stopped: true });
    this.createPort =
      createPort ||
      ((options) => {
        const { SerialPort } = require('serialport');
        return new SerialPort(options);
      });
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  connect() {
    if (this.stopped || this.connected || this.connecting) return;
    this.connecting = true;
    const port = (this.port = this.createPort({
      path: this.path,
      baudRate: this.baudRate,
      autoOpen: false,
    }));
    port.on('data', (data) => {
      if (!this.stopped && port === this.port) this.emit('data', data);
    });
    port.on('error', () => {
      if (!this.stopped && port === this.port) this.emit('transportError');
    });
    port.on('close', () => {
      if (port !== this.port) return;
      this.connected = false;
      this.connecting = false;
      this.emit('close');
      this.reconnect();
    });
    port.open((error) => {
      if (this.stopped || port !== this.port) {
        if (!error && port.isOpen) port.close();
        return;
      }
      this.connecting = false;
      if (error) {
        this.emit('transportError');
        this.reconnect();
        return;
      }
      this.connected = true;
      this.emit('open');
    });
  }
  reconnect() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.reconnectMs);
    this.timer.unref();
  }
  write(line) {
    if (!this.connected) throw new Error('disconnected');
    this.port.write(line, (error) => {
      if (error) this.emit('transportError');
    });
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    const port = this.port;
    this.port = null;
    this.connected = false;
    this.connecting = false;
    if (port?.isOpen) port.close();
    this.emit('close');
  }
}
module.exports = { MockSerialAdapter, UsbSerialAdapter };
