/**
 * Stand-in for the Orca CLI. Prints one JSON envelope on stdout.
 * Not a published file. Driven by structured-session.integration.test.mjs.
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const logPath = process.env.FAKE_ORCA_LOG;
if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(argv)}\n`);

function out(result, ok = true) {
  process.stdout.write(`${JSON.stringify({ ok, result, ...(ok ? {} : { error: result }) })}\n`);
  process.exit(ok ? 0 : 1);
}

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return '';
}

const mode = process.env.FAKE_ORCA_MODE || 'structured';
const sid = '75a099c4-1111-4111-8111-111111111111';
const chatHandle = `structured-agent-session-${sid}`;
const wt = process.env.FAKE_WORKTREE;

const words = [];
for (const a of argv) {
  if (a.startsWith('--')) break;
  words.push(a);
}
const cmd = words.join(' ');

if (cmd === 'status') {
  out({ version: '9.9.9', ok: true });
}
if (cmd === 'terminal show') {
  out({ terminal: { handle: flag('terminal'), connected: true, writable: true, title: 'coordinator', preview: 'Working\nTurns: 1\nTool calls: 1' } });
}
if (cmd === 'terminal list') {
  out({ terminals: [] });
}
if (cmd === 'terminal read') {
  out({ terminal: { tail: ['Working', 'Turns: 1', 'Tool calls: 1'] } });
}
if (cmd === 'terminal wait' || cmd === 'terminal send') {
  out({ ok: true });
}
if (cmd === 'agent list') {
  out({
    agents: [{
      orcaSessionId: sid,
      kind: 'chat',
      worktreeId: `repo::${wt}`,
      workspace: wt,
      state: 'working',
      title: 'worker',
    }],
  });
}
if (cmd === 'orchestration run-create') out({ run: { id: 'run_structured' } });
if (cmd === 'orchestration run-use') out({ bound: true });
if (cmd === 'orchestration task-create') out({ task: { id: 'task_structured' } });
if (cmd === 'worktree create') {
  if (mode === 'terminal') {
    out({
      path: wt,
      id: `repo::${wt}`,
      agentTerminalHandle: 'term_worker',
      launch: { outcome: { kind: 'terminal', handle: 'term_worker' }, receipt: { reason: 'requested', detail: 'terminal' } },
    });
  }
  if (mode === 'no-handle') {
    out({
      path: wt,
      id: `repo::${wt}`,
      launch: { outcome: { kind: 'structured' }, receipt: { reason: 'user_default', detail: 'no handle' } },
    });
  }
  out({
    path: wt,
    id: `repo::${wt}`,
    launch: {
      outcome: { kind: 'structured', handle: chatHandle, sessionId: sid },
      receipt: {
        reason: 'user_default',
        detail: 'Started a structured chat session, the default for new agent tabs in your settings.',
      },
    },
  });
}
if (cmd === 'orchestration dispatch') {
  const audit = process.env.FAKE_AUDIT_DIR;
  const creations = audit ? `${audit}/creations.ndjson` : '';
  if (creations && !fs.existsSync(creations)) {
    out({ code: 'creation_record_missing_before_bind' }, false);
  }
  const text = fs.readFileSync(creations, 'utf8');
  if (mode !== 'terminal' && !text.includes(chatHandle)) {
    out({ code: 'structured_handle_not_recorded_before_bind' }, false);
  }
  if (argv.includes('--inject')) {
    out({ dispatch: { id: 'ctx_terminal', status: 'dispatched' }, injected: true });
  }
  if (mode === 'fail-bind') out({ code: 'bind_failed' }, false);
  const to = flag('to');
  if (to !== `orca_session_id:${sid}`) out({ code: 'unexpected_to', to }, false);
  out({
    dispatch: { id: 'ctx_structured', task_id: 'task_structured', status: 'dispatched' },
    preamble: '',
  });
}
if (cmd === 'orchestration send') out({ id: 'msg_spec', accepted: true });
if (cmd === 'orchestration reply') out({ id: flag('id'), replied: true });
if (cmd === 'orchestration check') {
  const wait = argv.includes('--wait');
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
    if (mailbox) fs.writeFileSync(mailbox, '');
    out({
      runId: flag('run') || 'run_structured',
      count: 1,
      messages: [message],
      deliveryId: message.deliveryId || 'deliv_1',
      timedOut: false,
    });
  }
  out({
    runId: flag('run') || 'run_structured',
    count: 0,
    messages: [],
    deliveryId: null,
    timedOut: wait,
  });
}
if (cmd === 'orchestration worker-release') {
  // orchestration dispatch owns no terminal (Orca CLI spec): retained, no process action.
  out({ state: 'retained', reason: 'no_owned_resource' });
}
if (cmd === 'orchestration worker-stop') {
  // Fence only. Does not close the unsupervised chat.
  out({ state: 'fenced' });
}
if (cmd === 'worktree show') {
  out({ worktree: { path: wt, isMainWorktree: false, isBare: false } });
}

out({ code: 'unhandled', argv }, false);
