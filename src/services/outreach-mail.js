import nodemailer from 'nodemailer';
import net from 'node:net';
import {
  OUTREACH_SENDER, OutreachError, assertOutreachCanSend, normalizeOutreachEmail,
  outreachFooter, readOutreachConfig, validateOutreachTemplate,
} from './outreach-validation.js';

export function outreachSmtpOptions(env = process.env) {
  const config = readOutreachConfig(env);
  if (!config.smtpConfigured) throw new OutreachError('SMTP 설정을 확인해주세요.', 503, 'OUTREACH_NOT_CONFIGURED');
  return {
    host: 'smtp.naver.com', port: config.smtpPort, secure: config.smtpPort === 465,
    requireTLS: config.smtpPort === 587,
    auth: { user: OUTREACH_SENDER.email, pass: env.OUTREACH_SMTP_PASSWORD },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'smtp.naver.com' },
    pool: false, maxRecipients: 1, disableFileAccess: true, disableUrlAccess: true,
    connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    logger: false, debug: false, transactionLog: false,
  };
}

export function createOutreachMailer({
  env = () => process.env, createTransport = nodemailer.createTransport,
  connectSocket = options => net.createConnection(options),
} = {}) {
  return {
    async send({ email, subject, body, unsubscribeUrl, messageId, signal }) {
      const settings = env();
      const config = readOutreachConfig(settings);
      assertOutreachCanSend(config);
      const to = normalizeOutreachEmail(email);
      // Validate the rendered snapshot again. Never accept arbitrary Nodemailer options.
      const content = validateOutreachTemplate({ subject, body }, { rendered: true });
      const link = new URL(unsubscribeUrl);
      if (link.origin !== config.publicUrl || link.pathname !== '/api/outreach/unsubscribe'
        || link.username || link.password || [...link.searchParams.keys()].length !== 1
        || !/^[A-Za-z0-9_-]{43}$/.test(link.searchParams.get('token') || '') || link.hash) {
        throw new OutreachError('수신거부 링크를 확인해주세요.');
      }
      if (typeof messageId !== 'string' || !/^<outreach-[0-9a-f-]{36}@pr-text\.com>$/.test(messageId)) throw new OutreachError('메일 식별값을 확인해주세요.');
      if (signal?.aborted) throw new OutreachError('메일 전송이 중단되었습니다.', 503, 'OUTREACH_SEND_ABORTED');
      let ownedSocket, finishSocket, closing = false;
      const aborted = () => new OutreachError('메일 전송 결과를 확인하지 못했습니다.', 503, 'OUTREACH_SEND_ABORTED');
      const closeSocket = () => {
        closing = true;
        ownedSocket?.destroy();
        finishSocket?.(aborted());
      };
      const getSocket = (options, callback) => {
        if (closing || ownedSocket) return callback(aborted());
        let settled = false;
        const done = error => {
          if (settled) return;
          settled = true;
          finishSocket = null;
          // Keep TLS wrapping/STARTTLS and certificate checks inside Nodemailer.
          callback(error, error ? undefined : { connection: ownedSocket, secured: false });
        };
        finishSocket = done;
        try {
          ownedSocket = connectSocket({ host: options.host, port: options.port });
          ownedSocket.once('error', done);
          ownedSocket.once('connect', () => done(closing ? aborted() : null));
          ownedSocket.once('close', () => done(aborted()));
        } catch (error) { done(error); }
      };
      const transport = createTransport({ ...outreachSmtpOptions(settings), getSocket });
      let timer, abort;
      try {
        const message = {
          from: { name: OUTREACH_SENDER.name, address: OUTREACH_SENDER.email },
          replyTo: OUTREACH_SENDER.email, to,
          envelope: { from: OUTREACH_SENDER.email, to: [to] },
          subject: content.subject, text: content.body + outreachFooter(link.toString()),
          messageId, headers: { 'List-Unsubscribe': `<${link.toString()}>` },
          disableFileAccess: true, disableUrlAccess: true,
        };
        const deadline = new Promise((resolve, reject) => {
          abort = () => { closeSocket(); transport.close?.(); reject(aborted()); };
          timer = setTimeout(abort, 45_000);
          signal?.addEventListener('abort', abort, { once: true });
        });
        return await Promise.race([transport.sendMail(message), deadline]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        // SMTPTransport.close() alone does not stop an active non-pooled socket.
        closeSocket();
        transport.close?.();
      }
    },
  };
}
