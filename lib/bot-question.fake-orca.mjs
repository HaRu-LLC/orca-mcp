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
  const prefix = `--${name}=`;
  const eq = argv.find((a) => String(a).startsWith(prefix));
  if (eq) return String(eq).slice(prefix.length);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('--')) return argv[i + 1];
  return '';
}

function readBoxes() {
  const mailbox = process.env.FAKE_MAILBOX;
  if (!mailbox || !fs.existsSync(mailbox)) return {};
  const raw = fs.readFileSync(mailbox, 'utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    if (parsed.id && parsed.type) return { term_coord: parsed };
    return parsed;
  } catch {
    return {};
  }
}

function writeBoxes(boxes) {
  const mailbox = process.env.FAKE_MAILBOX;
  if (mailbox) fs.writeFileSync(mailbox, JSON.stringify(boxes));
}

function runStatePath() {
  if (process.env.FAKE_RUN_STATE) return process.env.FAKE_RUN_STATE;
  if (process.env.FAKE_MAILBOX) return `${process.env.FAKE_MAILBOX}.run.json`;
  return '';
}

function readRunState() {
  const file = runStatePath();
  if (!file || !fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeRunState(state) {
  const file = runStatePath();
  if (file) fs.writeFileSync(file, JSON.stringify(state));
}

function allMessages() {
  const boxes = readBoxes();
  const messages = [];
  for (const value of Object.values(boxes)) messages.push(...firstBatch(value));
  return messages;
}

function boxKey() {
  // `--run` is the run mailbox (`run:<id>`), even when `--terminal` is the sender.
  const run = flag('run');
  if (run) return `run:${String(run).replace(/^run:/, '')}`;
  return flag('terminal') || 'term_coord';
}

function firstBatch(value) {
  if (!value) return [];
  if (value.batches && Array.isArray(value.batches)) {
    const first = value.batches[0];
    if (!first) return [];
    return Array.isArray(first) ? first : [first];
  }
  if (Array.isArray(value)) return value;
  return [value];
}

function boxMessages(key) {
  return firstBatch(readBoxes()[key]);
}

function consumeBatch(key) {
  const boxes = readBoxes();
  const value = boxes[key];
  if (!value) return;
  if (value.batches && Array.isArray(value.batches)) {
    value.batches.shift();
    if (value.batches.length === 0) delete boxes[key];
    else boxes[key] = value;
  } else {
    delete boxes[key];
  }
  writeBoxes(boxes);
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

if (cmd === 'orchestration run-use') {
  const id = flag('id');
  if (id) writeRunState({ ...readRunState(), usedRunId: id });
  out({ bound: true, runId: id || null });
}

if (cmd === 'orchestration run-current') {
  const extra = control();
  if (extra.failRunCurrent) out({ code: 'run_current_unavailable', message: 'run-current failed' }, false);
  if (Object.prototype.hasOwnProperty.call(extra, 'currentRunId')) {
    out({ runId: extra.currentRunId || null, objective: extra.currentRunId ? 'external' : undefined });
  }
  out({ runId: readRunState().usedRunId || null });
}

if (cmd === 'orchestration send') {
  if (control().failSend) out({ code: 'send_rejected', message: 'refused' }, false);
  const message = { id: control().sendMessageId || 'msg_q1', type: 'question' };
  if (control().sendRunId) {
    message.run_id = control().sendRunId;
    message.to = control().sendTo || `run:${control().sendRunId}`;
  }
  out({ message, sent: true });
}

if (cmd === 'orchestration check') {
  const wait = argv.includes('--wait');
  const peek = argv.includes('--peek');
  const timeout = Number(flag('timeout-ms') || 0);
  const key = boxKey();
  const started = Date.now();
  let messages = boxMessages(key);
  if (wait && messages.length === 0) {
    while (Date.now() - started < timeout) {
      const next = boxMessages(key);
      if (next.length) {
        messages = next;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
  if (messages.length) {
    if (!peek) consumeBatch(key);
    out({
      count: messages.length,
      messages,
      deliveryId: messages[0].deliveryId || 'deliv_bot',
      timedOut: false,
    });
  }
  out({ count: 0, messages: [], deliveryId: null, timedOut: wait });
}

if (cmd === 'orchestration inbox') {
  const terminal = flag('terminal');
  const messages = terminal ? boxMessages(terminal) : allMessages();
  out({ messages, count: messages.length });
}

out({ code: 'unhandled', argv }, false);
