/**
 * Dispatch against a fake Orca CLI.
 * Covers structured chat placement, early creation records, await returning
 * when mail arrives, reply, worker_done, release without terminal close,
 * reclaim of a failed bind, and the existing terminal inject path.
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
const FAKE = path.resolve(__dirname, 'structured-session.fake-orca.mjs');
const TOKEN = 'structured-session-test-token-0123456789';
const SIGNER = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startBridge(root, mode) {
  const port = 18000 + Math.floor(Math.random() * 20000);
  const home = path.join(root, 'home');
  const audit = path.join(root, 'audit');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(audit, { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  const log = path.join(root, 'orca-argv.ndjson');
  const mailbox = path.join(root, 'mailbox.json');
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
      ORCA_BRIDGE_DEFAULT_REPO: wt,
      ORCA_CLI_COMMAND: bin,
      FAKE_ORCA_MODE: mode,
      FAKE_ORCA_LOG: log,
      FAKE_MAILBOX: mailbox,
      FAKE_AUDIT_DIR: audit,
      FAKE_WORKTREE: wt,
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
    server,
    log,
    mailbox,
    audit,
    wt,
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
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('structured session dispatch (fake Orca CLI)', () => {
  let bridge;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-structured-'));

  before(async () => {
    bridge = await startBridge(root, 'structured');
  });
  after(async () => {
    await bridge?.stop();
  });

  it('dispatch → question → reply → worker_done → release, await returns on arrival', async () => {
    const spec = 'Fix the structured session path and report.';
    const started = Date.now();
    const dispatched = await call(bridge.port, 2, {
      action: 'dispatch',
      spec,
      repo: bridge.wt,
      name: 'chat-worker',
    });
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    assert.equal(dispatched.session_kind, 'structured');
    assert.equal(dispatched.dispatch_id, 'ctx_structured');
    assert.equal(dispatched.terminal_handle, 'structured-agent-session-75a099c4-1111-4111-8111-111111111111');
    assert.equal(dispatched.mail_address, 'orca_session_id:75a099c4-1111-4111-8111-111111111111');
    assert.ok(Date.now() - started < 8000, 'structured dispatch must not wait on a TUI');

    const calls = argvLog(bridge.log);
    const flat = calls.map((a) => a.join(' '));
    assert.ok(flat.some((l) => l.includes('orchestration dispatch') && l.includes('--to orca_session_id:75a099c4-1111-4111-8111-111111111111') && !l.includes('--inject')));
    const send = calls.find((a) => a[0] === 'orchestration' && a[1] === 'send' && a.includes('--type') && a[a.indexOf('--type') + 1] === 'dispatch');
    assert.ok(send, 'spec must be mailed to the chat');
    const body = send[send.indexOf('--body') + 1];
    assert.match(body, /Fix the structured session path/);
    assert.match(body, /orca-bridge-worker-contract/);
    assert.equal(flat.some((l) => l.startsWith('terminal wait')), false);
    assert.equal(flat.some((l) => l.startsWith('terminal send')), false);
    assert.equal(flat.some((l) => l.startsWith('terminal close')), false);

    const question = {
      id: 'msg_q',
      type: 'question',
      dispatchId: 'ctx_structured',
      taskId: 'task_structured',
      body: 'Which file?',
      deliveryId: 'deliv_q',
    };
    const awaitStarted = Date.now();
    const pending = call(bridge.port, 3, { action: 'await', runId: 'run_structured', waitMs: 8000 });
    await sleep(250);
    fs.writeFileSync(bridge.mailbox, JSON.stringify(question));
    const awaited = await pending;
    const elapsed = Date.now() - awaitStarted;
    assert.equal(awaited.summary?.status, 'question', JSON.stringify(awaited.summary));
    assert.ok(elapsed < 3000, `await waited ${elapsed}ms; check --wait should return when the message arrives`);
    assert.ok(elapsed >= 200, `await returned in ${elapsed}ms, before the message was written`);

    const reply = await call(bridge.port, 4, {
      action: 'cli',
      args: ['orchestration', 'reply', '--id', 'msg_q', '--body', 'src/server.mjs', '--json'],
    });
    assert.equal(reply.ok !== false, true, JSON.stringify(reply));

    fs.writeFileSync(bridge.mailbox, JSON.stringify({
      id: 'msg_done',
      type: 'worker_done',
      dispatchId: 'ctx_structured',
      taskId: 'task_structured',
      outcome: 'succeeded',
      subject: 'done',
      body: 'Landed the chat path. Tests cover the fake CLI. Live Orca still needs a check.',
      deliveryId: 'deliv_done',
    }));
    const done = await call(bridge.port, 5, { action: 'await', runId: 'run_structured', waitMs: 4000, ack: awaited.deliveryId });
    assert.equal(done.summary?.status, 'worker_done', JSON.stringify(done.summary));

    const released = await call(bridge.port, 6, {
      action: 'release',
      dispatchId: 'ctx_structured',
      terminalHandle: dispatched.terminal_handle,
      keepWorktree: false,
    });
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(released.mode, 'structured-session');
    assert.equal(released.worker_release_retained, true);
    assert.match(released.note, /worker-stop fences/);
    assert.doesNotMatch(released.note, /terminal close/);
    assert.equal(released.worktree?.state, 'retained');
    assert.equal(released.worktree?.reason, 'terminal_not_closed');
    const after = argvLog(bridge.log).map((a) => a.join(' '));
    assert.equal(after.some((l) => l.startsWith('terminal close')), false);
    assert.equal(after.some((l) => l.startsWith('worktree rm')), false);
    assert.ok(after.some((l) => l.includes('worker-release')));
    assert.ok(after.some((l) => l.includes('worker-stop')));
  });
});

describe('failed structured dispatch is reclaimable', () => {
  it('records the chat handle before bind fails, and reclaim finds it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-structured-fail-'));
    const bridge = await startBridge(root, 'fail-bind');
    try {
      const dispatched = await call(bridge.port, 2, {
        action: 'dispatch',
        spec: 'This bind will fail.',
        repo: bridge.wt,
        name: 'chat-fail',
      });
      assert.equal(dispatched.ok, false);
      assert.equal(dispatched.stage, 'dispatch-bind');
      assert.equal(dispatched.terminal_handle, 'structured-agent-session-75a099c4-1111-4111-8111-111111111111');
      const lines = fs.readFileSync(path.join(bridge.audit, 'creations.ndjson'), 'utf8').trim().split('\n');
      const records = lines.map((l) => JSON.parse(l));
      assert.ok(records.some((r) => (r.handles || []).includes(dispatched.terminal_handle)));
      const reclaimed = await call(bridge.port, 3, {
        action: 'reclaim',
        terminalHandle: dispatched.terminal_handle,
      });
      assert.equal(reclaimed.ok, true, JSON.stringify(reclaimed));
      assert.equal(reclaimed.reclaimed.terminal_handle, dispatched.terminal_handle);
    } finally {
      await bridge.stop();
    }
  });

  it('a structured launch with no handle is recorded before place-agent returns', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-structured-noh-'));
    const bridge = await startBridge(root, 'no-handle');
    try {
      const dispatched = await call(bridge.port, 2, {
        action: 'dispatch',
        spec: 'No handle.',
        repo: bridge.wt,
        name: 'chat-noh',
      });
      assert.equal(dispatched.ok, false);
      assert.equal(dispatched.stage, 'place-agent');
      const records = fs.readFileSync(path.join(bridge.audit, 'creations.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(records.some((r) => r.stage === 'place-agent' && r.worktreePath === bridge.wt));
      const reclaimed = await call(bridge.port, 3, { action: 'reclaim', taskId: 'task_structured' });
      assert.equal(reclaimed.ok, false);
      assert.notEqual(reclaimed.code, 'creation_record_not_found');
      assert.equal(reclaimed.code, 'creation_record_no_handle');
    } finally {
      await bridge.stop();
    }
  });
});

describe('terminal launch path stays on inject', () => {
  it('still injects and does not mail the brief as a chat', { timeout: 30_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-terminal-'));
    const bridge = await startBridge(root, 'terminal');
    try {
      const dispatched = await call(bridge.port, 2, {
        action: 'dispatch',
        spec: 'Terminal worker.',
        repo: bridge.wt,
        name: 'term-worker',
      });
      assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
      assert.equal(dispatched.session_kind, 'terminal');
      assert.equal(dispatched.terminal_handle, 'term_worker');
      const flat = argvLog(bridge.log).map((a) => a.join(' '));
      assert.ok(flat.some((l) => l.includes('orchestration dispatch') && l.includes('--inject')));
      assert.ok(flat.some((l) => l.startsWith('terminal wait')));
      assert.equal(
        flat.some((l) => l.includes('orchestration send') && l.includes('--type dispatch')),
        false,
      );
    } finally {
      await bridge.stop();
    }
  });
});
