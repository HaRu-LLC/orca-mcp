/**
 * action=ask against a fake Orca CLI.
 * Reply arrival uses check --wait (returns when the message is written).
 * Unknown bot, paused bot, handoff, send failure, and timeout do not resend.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '../server.mjs');
const FAKE = path.resolve(__dirname, 'bot-question.fake-orca.mjs');
const TOKEN = 'bot-question-test-token-0123456789abcd';
const SIGNER = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startBridge(root) {
  const port = 18000 + Math.floor(Math.random() * 20000);
  const home = path.join(root, 'home');
  const audit = path.join(root, 'audit');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(audit, { recursive: true });
  const log = path.join(root, 'orca-argv.ndjson');
  const mailbox = path.join(root, 'mailbox.json');
  const control = path.join(root, 'control.json');
  fs.writeFileSync(control, '{}\n');
  const bin = path.join(root, 'orca.mjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport ${JSON.stringify(FAKE)};\n`);
  fs.chmodSync(bin, 0o755);
  const server = spawn(process.execPath, [SERVER, '--port', String(port)], {
    env: {
      ...process.env,
      HOME: home,
      ORCA_BRIDGE_TOKEN: TOKEN,
      ORCA_BRIDGE_STORE_SIGNER_KEY: SIGNER,
      ORCA_BRIDGE_AUDIT_DIR: audit,
      ORCA_BRIDGE_DEBUG: '0',
      ORCA_BRIDGE_TOOLSETS: 'status,dispatch',
      ORCA_BRIDGE_SENDER_TERMINAL: 'term_coord',
      ORCA_CLI_COMMAND: bin,
      FAKE_ORCA_LOG: log,
      FAKE_MAILBOX: mailbox,
      FAKE_BOT_CONTROL: control,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  server.stderr.on('data', (c) => stderr.push(c));
  let up = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      if (res.ok) {
        up = true;
        break;
      }
    } catch { /* not up */ }
    await sleep(40);
  }
  if (!up) {
    server.kill('SIGTERM');
    throw new Error(`bridge did not listen: ${Buffer.concat(stderr).toString().slice(-2000)}`);
  }
  return {
    port,
    log,
    mailbox,
    control,
    async stop() {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    },
  };
}

async function call(port, id, args) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'orca', arguments: args },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  const text = body.result?.content?.[0]?.text || '{}';
  return JSON.parse(text);
}

function argvLog(log) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function sendsSince(log, from) {
  return argvLog(log).slice(from).filter((a) => a[0] === 'orchestration' && a[1] === 'send');
}

function readBoxes(bridge) {
  if (!fs.existsSync(bridge.mailbox)) return {};
  const raw = fs.readFileSync(bridge.mailbox, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeBox(bridge, terminal, message) {
  const boxes = readBoxes(bridge);
  if (message == null) delete boxes[terminal];
  else boxes[terminal] = message;
  fs.writeFileSync(bridge.mailbox, JSON.stringify(boxes));
}

function flagValue(argv, name) {
  const prefix = `--${name}=`;
  const eq = argv.find((a) => String(a).startsWith(prefix));
  if (eq) return String(eq).slice(prefix.length);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  return undefined;
}

describe('action=ask bot question (fake Orca CLI)', () => {
  let bridge;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bot-ask-'));

  before(async () => {
    bridge = await startBridge(root);
  });
  after(async () => {
    await bridge?.stop();
  });

  it('asks one question and does not resend on refusal or timeout', async () => {
    const handoff = await call(bridge.port, 2, {
      action: 'ask',
      bot: 'Workspace cleanup',
      question: 'do the cleanup',
      type: 'handoff',
    });
    assert.equal(handoff.error, 'question_only');
    assert.equal(handoff.sent, false);
    assert.equal(handoff.resent, false);
    assert.equal(sendsSince(bridge.log, 0).length, 0);

    const missing = await call(bridge.port, 3, {
      action: 'ask',
      bot: 'No such bot',
      question: 'hello',
    });
    assert.equal(missing.error, 'bot_not_found');
    assert.equal(missing.sent, false);
    assert.equal(missing.resent, false);
    assert.ok(missing.known.includes('Workspace cleanup'));
    assert.equal(sendsSince(bridge.log, 0).length, 0);

    const paused = await call(bridge.port, 4, {
      action: 'ask',
      bot: 'Paused one',
      question: 'hello',
    });
    assert.equal(paused.error, 'bot_paused');
    assert.equal(paused.sent, false);
    assert.equal(sendsSince(bridge.log, 0).length, 0);

    const sentFrom = argvLog(bridge.log).length;
    const question = 'あなたは何をする bot ですか';
    const started = Date.now();
    const pending = call(bridge.port, 5, {
      action: 'ask',
      bot: 'Workspace cleanup',
      question,
      chat: 'chat_home',
      waitMs: 8000,
    });
    await sleep(250);
    writeBox(bridge, 'term_coord', {
      id: 'msg_a',
      type: 'status',
      subject: 'Re: question',
      body: '作業フォルダを片付けます。',
      thread_id: 'msg_q1',
      from_handle: 'bot:Workspace cleanup',
      payload: JSON.stringify({ requestId: 'msg_q1', botAnswer: { view: 'answered' } }),
      deliveryId: 'deliv_bot',
    });
    const asked = await pending;
    const elapsed = Date.now() - started;
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.equal(asked.resent, false);
    assert.equal(asked.to, 'bot:Workspace cleanup');
    assert.equal(asked.answer.body, '作業フォルダを片付けます。');
    assert.equal(asked.text, '作業フォルダを片付けます。');
    assert.equal(asked.consumed, false, JSON.stringify(asked));
    assert.equal(asked.left_in_inbox, true);
    assert.equal(readBoxes(bridge).term_coord.id, 'msg_a');
    assert.ok(elapsed < 3000, `ask waited ${elapsed}ms; check --wait should return when the reply arrives`);
    assert.ok(elapsed >= 200, `ask returned in ${elapsed}ms, before the reply was written`);

    const sent = sendsSince(bridge.log, sentFrom);
    assert.equal(sent.length, 1, JSON.stringify(sent));
    const argv = sent[0];
    assert.equal(argv[argv.indexOf('--to') + 1], 'bot:Workspace cleanup');
    assert.equal(argv[argv.indexOf('--type') + 1], 'question');
    assert.equal(argv.includes('handoff'), false);
    assert.equal(flagValue(argv, 'body'), question);
    assert.equal(flagValue(argv, 'subject'), question);
    assert.equal(argv.includes('--body'), false);
    assert.equal(argv[argv.indexOf('--chat') + 1], 'chat_home');
    assert.equal(argv[argv.indexOf('--from') + 1], 'term_coord');
    const checks = argvLog(bridge.log).slice(sentFrom).filter((a) => a[0] === 'orchestration' && a[1] === 'check');
    assert.ok(checks.length >= 1);
    assert.ok(checks.every((a) => a.includes('--peek')));
    assert.ok(checks[0].includes('--wait'));
    assert.equal(checks[0].includes('--run'), false);
    assert.equal(checks[0][checks[0].indexOf('--terminal') + 1], 'term_coord');

    writeBox(bridge, 'term_coord', {
      id: 'msg_other',
      type: 'status',
      from_handle: 'term_worker',
      thread_id: 'thr_other',
      body: 'unrelated unread that is not the answer',
      payload: JSON.stringify({ requestId: 'msg_other_q' }),
    });
    const timeoutFrom = argvLog(bridge.log).length;
    const timeoutStarted = Date.now();
    const timed = await call(bridge.port, 6, {
      action: 'ask',
      bot: 'Workspace cleanup',
      question: 'still there?',
      waitMs: 1200,
    });
    const timeoutElapsed = Date.now() - timeoutStarted;
    assert.equal(timed.ok, false, JSON.stringify(timed));
    assert.equal(timed.error, 'reply_timeout');
    assert.equal(timed.timedOut, true);
    assert.equal(timed.resent, false);
    assert.equal(timed.sent, true);
    assert.equal(sendsSince(bridge.log, timeoutFrom).length, 1);
    assert.equal(timed.mailboxes[0].terminal, 'term_coord');
    assert.equal(timed.mailboxes[0].rows[0].type, 'status');
    assert.equal(timed.mailboxes[0].rows[0].from, 'term_worker');
    assert.equal(timed.mailboxes[0].rows[0].request_id, 'msg_other_q');
    assert.equal(timed.mailboxes[0].rows[0].thread_id, 'thr_other');
    assert.match(timed.mailboxes[0].rows[0].body, /unrelated unread/);
    assert.ok(timed.mailboxes[0].rows[0].body.length <= 80);
    const timeoutChecks = argvLog(bridge.log).slice(timeoutFrom).filter((a) => a[0] === 'orchestration' && a[1] === 'check');
    assert.ok(timeoutChecks.length >= 1);
    assert.ok(timeoutChecks.every((a) => a.includes('--peek')));
    assert.equal(readBoxes(bridge).term_coord.id, 'msg_other');
    assert.ok(timeoutElapsed >= 1000, `timeout returned in ${timeoutElapsed}ms`);
    assert.ok(timeoutElapsed < 8000, `timeout took ${timeoutElapsed}ms`);

    fs.writeFileSync(bridge.mailbox, '{}');
    const bound = await call(bridge.port, 8, { action: 'await', runId: 'run_bound', waitMs: 400 });
    assert.equal(bound.run_id, 'run_bound', JSON.stringify(bound));
    writeBox(bridge, 'term_coord', {
      id: 'msg_worker',
      type: 'worker_done',
      dispatchId: 'ctx_worker',
      outcome: 'succeeded',
      subject: 'cleaned the desk',
      body: 'Removed three unused files from the workspace checkout.',
      deliveryId: 'deliv_w',
    });
    const runFrom = argvLog(bridge.log).length;
    const runQuestion = '--who are you';
    const runStarted = Date.now();
    const runPending = call(bridge.port, 9, {
      action: 'ask',
      bot: 'Workspace cleanup',
      question: runQuestion,
      waitMs: 8000,
    });
    await sleep(250);
    writeBox(bridge, 'run:run_bound', {
      id: 'msg_run_reply',
      type: 'status',
      from_handle: 'bot:Workspace cleanup',
      thread_id: 'msg_q1',
      body: 'run mailbox answer',
      payload: JSON.stringify({ requestId: 'msg_q1', botAnswer: { view: 'answered' } }),
      deliveryId: 'deliv_run',
    });
    const runAsked = await runPending;
    const runElapsed = Date.now() - runStarted;
    assert.equal(runAsked.ok, true, JSON.stringify(runAsked));
    assert.equal(runAsked.text, 'run mailbox answer');
    assert.equal(runAsked.consumed, false);
    assert.equal(runAsked.run_id, 'run_bound');
    assert.ok(runElapsed < 3000, `bound ask waited ${runElapsed}ms`);
    assert.ok(runElapsed >= 200, `bound ask returned in ${runElapsed}ms`);
    const runSend = sendsSince(bridge.log, runFrom);
    assert.equal(runSend.length, 1);
    assert.equal(flagValue(runSend[0], 'body'), runQuestion);
    assert.equal(flagValue(runSend[0], 'subject'), runQuestion);
    assert.equal(runSend[0].some((token) => token === runQuestion), false);
    const runChecks = argvLog(bridge.log).slice(runFrom).filter((a) => a[0] === 'orchestration' && a[1] === 'check');
    assert.ok(runChecks.length >= 1 && runChecks.every((a) => a.includes('--peek')));
    assert.ok(runChecks.every((a) => flagValue(a, 'terminal') === 'run:run_bound'), JSON.stringify(runChecks));
    assert.equal(readBoxes(bridge).term_coord.id, 'msg_worker');
    assert.equal(readBoxes(bridge)['run:run_bound'].id, 'msg_run_reply');
    const after = await call(bridge.port, 10, { action: 'await', runId: 'run_bound', waitMs: 500 });
    const afterText = JSON.stringify(after);
    assert.match(afterText, /msg_worker/);
    assert.equal(afterText.includes('run mailbox answer'), false);
    assert.equal(afterText.includes('msg_run_reply'), false);
    assert.equal(readBoxes(bridge).term_coord, undefined);
    assert.equal(readBoxes(bridge)['run:run_bound'].id, 'msg_run_reply');

    fs.writeFileSync(bridge.mailbox, '{}');
    fs.writeFileSync(bridge.control, JSON.stringify({ failSend: true }));
    const failFrom = argvLog(bridge.log).length;
    const failed = await call(bridge.port, 7, {
      action: 'ask',
      bot: 'Workspace cleanup',
      question: 'hello',
      waitMs: 5000,
    });
    assert.equal(failed.error, 'send_failed');
    assert.equal(failed.sent, false);
    assert.equal(failed.resent, false);
    const tail = argvLog(bridge.log).slice(failFrom);
    assert.equal(tail.filter((a) => a[1] === 'send').length, 1);
    assert.equal(tail.some((a) => a[1] === 'check'), false);
    fs.writeFileSync(bridge.control, '{}\n');
  });
});
