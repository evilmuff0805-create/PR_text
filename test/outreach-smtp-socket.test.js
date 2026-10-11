import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { createOutreachMailer } from '../src/services/outreach-mail.js';
import { newUnsubscribeToken } from '../src/services/outreach-validation.js';

const ready = port => ({
  APP_URL: 'https://example.com', OUTREACH_SENDING_ENABLED: 'true',
  OUTREACH_SMTP_PASSWORD: 'synthetic-test-password', OUTREACH_SMTP_PORT: String(port),
});
const message = signal => ({
  email: 'recipient@example.com', subject: '(광고) 예시 안내', body: '예시 제작 서비스 소개입니다.',
  unsubscribeUrl: `https://example.com/api/outreach/unsubscribe?token=${newUnsubscribeToken()}`,
  messageId: '<outreach-12982d70-6348-44ac-a716-04d796ce3ae2@pr-text.com>', signal,
});

async function dummyServer(t, onConnection = () => {}) {
  const sockets = new Set();
  let markClosed;
  const closed = new Promise(resolve => { markClosed = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); markClosed(); });
    onConnection(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, closed };
}

for (const port of [587, 465]) {
  test(`actual Nodemailer ${port} TLS setup is aborted by closing the owned loopback TCP socket`, { timeout: 5000 }, async t => {
    let enteredTls;
    const tlsStarted = new Promise(resolve => { enteredTls = resolve; });
    const commands = [];
    const server = await dummyServer(t, socket => {
      let phase = port === 465 ? 'tls' : 'ehlo';
      if (phase === 'ehlo') socket.write('220 local.test ESMTP\r\n');
      socket.on('data', chunk => {
        if (phase === 'tls') { enteredTls(); return; }
        const command = chunk.toString('ascii').trim();
        commands.push(command);
        if (phase === 'ehlo' && command.startsWith('EHLO ')) {
          phase = 'starttls';
          socket.write('250-local.test\r\n250 STARTTLS\r\n');
        } else if (phase === 'starttls' && command === 'STARTTLS') {
          phase = 'tls';
          socket.write('220 Ready to start TLS\r\n');
        }
      });
    });
    const controller = new AbortController();
    let ownedSocket, connectionCalls = 0;
    const mailer = createOutreachMailer({ env: () => ready(port), connectSocket: options => {
      connectionCalls++;
      assert.deepEqual(options, { host: 'smtp.naver.com', port });
      ownedSocket = net.createConnection({ host: '127.0.0.1', port: server.port });
      return ownedSocket;
    } });
    const sending = mailer.send(message(controller.signal));
    const failure = assert.rejects(sending, error => error.code === 'OUTREACH_SEND_ABORTED');
    await tlsStarted;
    controller.abort();
    await failure;
    await server.closed;
    assert.equal(ownedSocket.destroyed, true);
    assert.equal(connectionCalls, 1);
    assert.equal(commands.some(command => /^(?:AUTH|MAIL|RCPT|DATA)\b/.test(command)), false);
    if (port === 587) assert.deepEqual(commands.map(command => command.split(' ')[0]), ['EHLO', 'STARTTLS']);
    else assert.deepEqual(commands, []);
  });
}

test('the 45-second hard deadline destroys an actual socket even when transport.close is a no-op', { timeout: 5000 }, async t => {
  const server = await dummyServer(t);
  let entered, ownedSocket, transportClosed = 0;
  const connected = new Promise(resolve => { entered = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const mailer = createOutreachMailer({
    env: () => ready(587),
    connectSocket: () => {
      ownedSocket = net.createConnection({ host: '127.0.0.1', port: server.port });
      return ownedSocket;
    },
    createTransport: options => ({
      sendMail: () => new Promise((resolve, reject) => options.getSocket(options, (error, connection) => {
        if (error) reject(error);
        else { assert.equal(connection.secured, false); entered(); }
      })),
      close: () => transportClosed++,
    }),
  });
  const failure = assert.rejects(mailer.send(message()), error => error.code === 'OUTREACH_SEND_ABORTED');
  await connected;
  t.mock.timers.tick(45_000);
  await failure;
  t.mock.timers.reset();
  await server.closed;
  assert.equal(ownedSocket.destroyed, true);
  assert.ok(transportClosed > 0);
});

test('abort during connection setup fences a late connect event and never supplies a live socket', async () => {
  const socket = new EventEmitter();
  socket.destroy = () => { socket.destroyed = true; };
  const controller = new AbortController();
  const results = [];
  let options;
  const mailer = createOutreachMailer({
    env: () => ready(587), connectSocket: () => socket,
    createTransport: value => {
      options = value;
      return { sendMail: () => new Promise((resolve, reject) => options.getSocket(options, (error, info) => {
        results.push({ error, info });
        if (error) reject(error); else resolve(info);
      })) };
    },
  });
  const failure = assert.rejects(mailer.send(message(controller.signal)), error => error.code === 'OUTREACH_SEND_ABORTED');
  controller.abort();
  await failure;
  socket.emit('connect');
  assert.equal(socket.destroyed, true);
  assert.equal(results.length, 1);
  assert.equal(results[0].info, undefined);
  let lateError;
  options.getSocket(options, error => { lateError = error; });
  assert.equal(lateError.code, 'OUTREACH_SEND_ABORTED');
});
