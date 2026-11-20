/**
 * Stand-in for the Orca CLI used by bot-question.integration.test.mjs.
 * Prints one JSON envelope. Not a published file.
 *
 * Estimated shapes (no live orca in this environment):
 *   bot list --json → result.bots[]
 *   orchestration send → result.message.id
 *   orchestration check --wait blocks until FAKE_MAILBOX has one JSON message
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const logPath = process.env.FAKE_ORCA_LOG;
if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(argv)}\n`);

function out(result, ok = true) {
  const body = ok
    ? { ok: true, result }
    : { ok: false, error: result && result.code ? result : { code: 'failed', message: String(result) } };
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(ok ? 0 : 1);
}

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('--')) return argv[i + 1];
  return '';
}

const words = [];
for (const a of argv) {
  if (a.startsWith('--')) break;
  words.push(a);
}
const cmd = words.join(' ');

function control() {
  const file = process.env.FAKE_BOT_CONTROL;
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

if (cmd === 'status') out({ version: '9.9.9', ok: true });

if (cmd === 'terminal show') {
  out({
    terminal: {
      handle: flag('terminal'),
      connected: true,
      writable: true,
      title: 'coordinator',
    },
  });
}

if (cmd === 'bot list') {
  const extra = control();
  out({
    bots: extra.bots || [
      {
        id: 'bot_ws',
        name: 'Workspace cleanup',
        agent: 'claude',
        paused: false,
        specialty: 'cleans a workspace',
        chats: { count: 1, home: true },
      },
      {
        id: 'bot_paused',
        name: 'Paused one',
        agent: 'claude',
        paused: true,
        specialty: null,
        chats: { count: 0, home: false },
      },
    ],
  });
}

if (cmd === 'orchestration send') {
  if (control().failSend) out({ code: 'send_rejected', message: 'refused' }, false);
  out({ message: { id: 'msg_q1', type: 'question' }, sent: true });
}

if (cmd === 'orchestration check') {
  const wait = argv.includes('--wait');
  const peek = argv.includes('--peek');
  const timeout = Number(flag('timeout-ms') || 0);
  const mailbox = process.env.FAKE_MAILBOX;
  const started = Date.now();
  const readMail = () => {
    if (!mailbox || !fs.existsSync(mailbox)) return null;
    const raw = fs.readFileSync(mailbox, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  };
  let message = readMail();
  if (wait && !message) {
    while (Date.now() - started < timeout) {
      const next = readMail();
      if (next) {
        message = next;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
  if (message) {
    if (!peek && mailbox) fs.writeFileSync(mailbox, '');
    out({
      count: 1,
      messages: [message],
      deliveryId: message.deliveryId || 'deliv_bot',
      timedOut: false,
    });
  }
  out({ count: 0, messages: [], deliveryId: null, timedOut: wait });
}

if (cmd === 'orchestration inbox') {
  const mailbox = process.env.FAKE_MAILBOX;
  let message = null;
  if (mailbox && fs.existsSync(mailbox)) {
    const raw = fs.readFileSync(mailbox, 'utf8').trim();
    if (raw) message = JSON.parse(raw);
  }
  out({ messages: message ? [message] : [], count: message ? 1 : 0 });
}

out({ code: 'unhandled', argv }, false);
