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
import { conformsToOutputSchema, LEGACY_ORCA_OUTPUT_SCHEMA } from './audit.mjs';

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
  const parsed = JSON.parse(text);
  const structured = body.result?.structuredContent;
  assert.equal(
    conformsToOutputSchema(parsed),
    true,
    `output schema: ${JSON.stringify(parsed)}`,
  );
  assert.equal(
    conformsToOutputSchema(structured, LEGACY_ORCA_OUTPUT_SCHEMA),
    true,
    `legacy output schema: ${JSON.stringify(structured)}`,
  );
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null) {
      assert.equal(Object.prototype.hasOwnProperty.call(structured, key), false, key);
      assert.equal(parsed[key], null);
    } else {
      assert.deepEqual(structured[key], value);
    }
  }
  return parsed;
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
    assert.equal(flagValue(argv, 'subject'), '質問');
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
    fs.writeFileSync(bridge.control, JSON.stringify({
      sendRunId: 'bot_run',
      sendTo: 'dispatch:bot_disp',
    }));
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
    assert.equal(flagValue(runSend[0], 'subject'), '質問');
    assert.equal(runSend[0].some((token) => token === runQuestion), false);
    const runChecks = argvLog(bridge.log).slice(runFrom).filter((a) => a[0] === 'orchestration' && a[1] === 'check');
    assert.ok(runChecks.length >= 1 && runChecks.every((a) => a.includes('--peek')));
    assert.ok(runChecks.every((a) => flagValue(a, 'terminal') === 'run:run_bound'), JSON.stringify(runChecks));
    assert.equal(readBoxes(bridge).term_coord.id, 'msg_worker');
    assert.equal(readBoxes(bridge)['run:run_bound'].id, 'msg_run_reply');
    assert.ok(runChecks.every((a) => flagValue(a, 'terminal') !== 'run:bot_run'));
    assert.ok(runChecks.every((a) => flagValue(a, 'terminal') !== 'dispatch:bot_disp'));
    writeBox(bridge, 'run:run_bound', [
      readBoxes(bridge)['run:run_bound'],
      {
        id: 'msg_follow',
        type: 'status',
        thread_id: 'msg_q1',
        from_handle: 'bot:Workspace cleanup',
        body: 'follow-up on the same thread',
        payload: JSON.stringify({ requestId: 'msg_q1' }),
      },
      {
        id: 'msg_run_done',
        type: 'worker_done',
        dispatchId: 'ctx_run',
        outcome: 'succeeded',
        subject: 'finished the cleanup',
        body: 'The run batch still has the worker_done after the reply is omitted.',
        deliveryId: 'deliv_run_done',
      },
    ]);
    const after = await call(bridge.port, 10, { action: 'await', runId: 'run_bound', waitMs: 500 });
    const afterText = JSON.stringify(after);
    assert.match(afterText, /msg_run_done/);
    assert.match(afterText, /msg_follow/);
    assert.equal(afterText.includes('msg_run_reply'), false);
    assert.equal(afterText.includes('run mailbox answer'), false);
    const awaitChecks = argvLog(bridge.log).filter((a) => a[0] === 'orchestration' && a[1] === 'check' && flagValue(a, 'run') === 'run_bound');
    assert.ok(awaitChecks.length >= 1, JSON.stringify(awaitChecks));
    assert.equal(readBoxes(bridge).term_coord.id, 'msg_worker');
    assert.equal(readBoxes(bridge)['run:run_bound'], undefined);

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

describe('bot reply ahead of worker_done after restart', () => {
  it('reports the reply as a normal message and still returns worker_done', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bot-restart-'));
    const first = await startBridge(root);
    try {
      fs.writeFileSync(first.control, JSON.stringify({
        sendRunId: 'bot_run',
        sendTo: 'dispatch:bot_disp',
      }));
      const bound = await call(first.port, 2, { action: 'await', runId: 'run_restart', waitMs: 300 });
      assert.equal(bound.run_id, 'run_restart', JSON.stringify(bound));
      writeBox(first, 'run:run_restart', {
        batches: [
          [{
            id: 'msg_restart_reply',
            type: 'status',
            from_handle: 'bot:Workspace cleanup',
            thread_id: 'msg_q1',
            body: 'restart answer',
            payload: JSON.stringify({ requestId: 'msg_q1', botAnswer: { view: 'answered' } }),
            deliveryId: 'deliv_reply',
          }],
          [{
            id: 'msg_restart_done',
            type: 'worker_done',
            dispatchId: 'ctx_restart',
            outcome: 'succeeded',
            subject: 'finished after the answer',
            body: 'Worker done was behind the bot answer and arrived in the same await.',
            deliveryId: 'deliv_done',
          }],
        ],
      });
      const asked = await call(first.port, 3, {
        action: 'ask',
        bot: 'Workspace cleanup',
        question: 'status?',
        waitMs: 2000,
      });
      assert.equal(asked.ok, true, JSON.stringify(asked));
      assert.equal(asked.text, 'restart answer');
      assert.equal(asked.run_id, 'run_restart');
      const askChecks = argvLog(first.log).filter((a) => a[0] === 'orchestration' && a[1] === 'check' && a.includes('--peek'));
      assert.ok(askChecks.every((a) => flagValue(a, 'terminal') === 'run:run_restart'));
    } finally {
      await first.stop();
    }

    const second = await startBridge(root);
    try {
      const after = await call(second.port, 4, { action: 'await', runId: 'run_restart', waitMs: 500 });
      const text = JSON.stringify(after);
      assert.match(text, /msg_restart_reply/);
      assert.match(text, /restart answer/);
      assert.match(text, /msg_restart_done/);
    } finally {
      await second.stop();
    }
  });
});

describe('ask follows an Orca binding the bridge did not create', () => {
  let bridge;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bot-external-run-'));

  before(async () => {
    bridge = await startBridge(root);
  });
  after(async () => {
    await bridge?.stop();
  });

  it('waits on run:<id> from run-current and matches payload.requestId', async () => {
    const questionId = 'msg_fd04b6a32025';
    fs.writeFileSync(bridge.control, JSON.stringify({
      currentRunId: 'run_6b418c19f549',
      sendMessageId: questionId,
    }));
    fs.writeFileSync(bridge.mailbox, JSON.stringify({
      term_coord: {
        id: 'msg_unrelated',
        type: 'status',
        from_handle: 'term_worker',
        body: 'not the answer',
        payload: JSON.stringify({ requestId: 'msg_other' }),
      },
    }));
    const from = argvLog(bridge.log).length;
    const started = Date.now();
    const pending = call(bridge.port, 2, {
      action: 'ask',
      bot: 'Workspace cleanup',
      question: 'あなたは何をする bot ですか',
      waitMs: 8000,
    });
    await sleep(250);
    writeBox(bridge, 'run:run_6b418c19f549', {
      id: 'msg_ext_reply',
      type: 'status',
      from_handle: 'orca_session_id:794d8283-aaaa',
      to: 'run:run_6b418c19f549',
      subject: 'Re: 質問',
      body: '作業フォルダを片付けます。',
      handled: false,
      payload: JSON.stringify({ requestId: questionId }),
    });
    const asked = await pending;
    const elapsed = Date.now() - started;
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.equal(asked.run_id, 'run_6b418c19f549');
    assert.equal(asked.question_id, questionId);
    assert.equal(asked.text, '作業フォルダを片付けます。');
    assert.equal(asked.answer.request_id, questionId);
    assert.equal(asked.answer.from, 'orca_session_id:794d8283-aaaa');
    assert.equal(asked.answer.subject, 'Re: 質問');
    assert.equal(asked.consumed, false);
    assert.equal(asked.resent, false);
    assert.ok(elapsed < 3000, `external ask waited ${elapsed}ms`);
    assert.ok(elapsed >= 200, `external ask returned in ${elapsed}ms`);
    const tail = argvLog(bridge.log).slice(from);
    const runCurrent = tail.findIndex((a) => a[0] === 'orchestration' && a[1] === 'run-current');
    const sendAt = tail.findIndex((a) => a[0] === 'orchestration' && a[1] === 'send');
    assert.ok(runCurrent >= 0 && sendAt > runCurrent, JSON.stringify(tail.map((a) => a.slice(0, 4))));
    assert.equal(tail[runCurrent][tail[runCurrent].indexOf('--from') + 1], 'term_coord');
    assert.equal(tail.filter((a) => a[1] === 'send').length, 1);
    const checks = tail.filter((a) => a[0] === 'orchestration' && a[1] === 'check');
    assert.ok(checks.length >= 1, JSON.stringify(tail));
    assert.ok(checks.every((a) => a.includes('--peek')));
    assert.ok(checks.every((a) => flagValue(a, 'terminal') === 'run:run_6b418c19f549'), JSON.stringify(checks));
    assert.equal(readBoxes(bridge).term_coord.id, 'msg_unrelated');
    assert.equal(readBoxes(bridge)['run:run_6b418c19f549'].id, 'msg_ext_reply');
  });

  it('peeks the terminal and the host inbox when run-current cannot be asked', async () => {
    const questionId = 'msg_c85d9af474a9';
    fs.writeFileSync(bridge.control, JSON.stringify({
      failRunCurrent: true,
      sendMessageId: questionId,
    }));
    fs.writeFileSync(bridge.mailbox, '{}');
    const from = argvLog(bridge.log).length;
    const started = Date.now();
    const pending = call(bridge.port, 3, {
      action: 'ask',
      bot: 'Workspace cleanup',
      question: 'まだいる？',
      waitMs: 8000,
    });
    await sleep(200);
    writeBox(bridge, 'run:run_external', {
      id: 'msg_wide_reply',
      type: 'status',
      from_handle: 'orca_session_id:794d8283-bbbb',
      to: 'run:run_external',
      subject: 'Re: 質問',
      body: 'host inbox answer',
      handled: false,
      payload: JSON.stringify({ requestId: questionId }),
    });
    const asked = await pending;
    const elapsed = Date.now() - started;
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.equal(asked.run_id, null);
    assert.equal(asked.text, 'host inbox answer');
    assert.equal(asked.answer.request_id, questionId);
    assert.equal(asked.resent, false);
    assert.equal(asked.consumed, false);
    assert.ok(elapsed < 4000, `unscoped ask waited ${elapsed}ms`);
    const tail = argvLog(bridge.log).slice(from);
    assert.equal(tail.filter((a) => a[1] === 'send').length, 1);
    const checks = tail.filter((a) => a[1] === 'check');
    assert.ok(checks.some((a) => flagValue(a, 'terminal') === 'term_coord'), JSON.stringify(checks));
    const inboxes = tail.filter((a) => a[1] === 'inbox');
    assert.ok(
      inboxes.some((a) => !a.includes('--terminal') && !a.some((token) => String(token).startsWith('--terminal='))),
      JSON.stringify(inboxes),
    );
    assert.equal(readBoxes(bridge)['run:run_external'].id, 'msg_wide_reply');
  });
});
