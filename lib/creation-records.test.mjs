import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreationRecord,
  mayAddListedHandles,
  parseCreationRecords,
  matchCreationRecord,
  verifyLiveTerminal,
  worktreePathOf,
  RECLAIM_MAX_AGE_MS,
} from './creation-records.mjs';

const WT = '/Users/x/dev/worktrees/repo/smoke';
const NOW = Date.parse('2026-11-10T03:00:00Z');

function env(result) {
  return { ok: true, envelope: { ok: true, result } };
}

// place-agent failure shape: worktree created, no agent handle returned
const placeAgentSteps = [
  { step: 'run-create', ...env({ run: { id: 'run_1' } }) },
  { step: 'task-create', ...env({ task: { id: 'task_1' } }) },
  { step: 'worktree-create', ...env({ path: WT, id: `abc::${WT}` }) },
];
const placeAgentResult = { ok: false, stage: 'place-agent', run_id: 'run_1', task_id: 'task_1' };

describe('buildCreationRecord', () => {
  it('records a place-agent failure (worktree but no handle)', () => {
    const r = buildCreationRecord({
      steps: placeAgentSteps,
      result: placeAgentResult,
      args: { worktree: 'new-top-level', name: 'smoke', agent: 'omp' },
      clientKey: 'master',
      now: NOW,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'place-agent');
    assert.equal(r.worktreePath, WT);
    assert.equal(r.runId, 'run_1');
    assert.equal(r.taskId, 'task_1');
    assert.deepEqual(r.handles, []);
    assert.equal(r.clientKey, 'master');
    assert.equal(mayAddListedHandles(r), true);
  });

  it('records a successful dispatch with handle and dispatch id', () => {
    const steps = [
      ...placeAgentSteps.slice(0, 2),
      { step: 'worktree-create', ...env({ path: WT, agentTerminalHandle: 'term_a' }) },
      { step: 'dispatch-inject', ...env({ dispatch: { id: 'ctx_1' } }) },
    ];
    const r = buildCreationRecord({ steps, result: { ok: true, terminal_handle: 'term_a' }, args: {}, clientKey: 'master', now: NOW });
    assert.deepEqual(r.handles, ['term_a']);
    assert.equal(r.dispatchId, 'ctx_1');
    assert.equal(r.ok, true);
    assert.equal(mayAddListedHandles(r), false);
  });

  it('returns null when nothing was created', () => {
    const r = buildCreationRecord({
      steps: placeAgentSteps.slice(0, 2),
      result: { ok: false, stage: 'worktree-create' },
      args: {},
      clientKey: 'master',
    });
    assert.equal(r, null);
  });

  it('never adds listed handles for worktree=current', () => {
    const r = buildCreationRecord({
      steps: [{ step: 'terminal-create', ...env({ terminal: { worktreePath: WT } }) }],
      result: { ok: false, stage: 'place-agent' },
      args: { worktree: 'current' },
      clientKey: 'master',
    });
    assert.equal(mayAddListedHandles(r), false);
  });
});

describe('matchCreationRecord', () => {
  const rec = (o) => ({
    v: 1, ts: new Date(NOW - 60_000).toISOString(), clientKey: 'master',
    worktreePath: WT, handles: ['term_a'], runId: 'run_1', taskId: 'task_1', dispatchId: null, ...o,
  });

  it('matches by handle for the same client', () => {
    const m = matchCreationRecord([rec()], { terminalHandle: 'term_a', clientKey: 'master', now: NOW });
    assert.equal(m.ok, true);
    assert.equal(m.handle, 'term_a');
  });

  it('matches by taskId and resolves the single handle', () => {
    const m = matchCreationRecord([rec()], { taskId: 'task_1', clientKey: 'master', now: NOW });
    assert.equal(m.ok, true);
    assert.equal(m.handle, 'term_a');
  });

  it('rejects another client key', () => {
    const m = matchCreationRecord([rec()], { terminalHandle: 'term_a', clientKey: 'sid:abc', now: NOW });
    assert.equal(m.code, 'creation_record_not_found');
  });

  it('rejects a handle not in the record', () => {
    const m = matchCreationRecord([rec()], { terminalHandle: 'term_other', clientKey: 'master', now: NOW });
    assert.equal(m.code, 'creation_record_not_found');
  });

  it('rejects mismatched combination of ids', () => {
    const m = matchCreationRecord([rec()], { terminalHandle: 'term_a', taskId: 'task_2', clientKey: 'master', now: NOW });
    assert.equal(m.code, 'creation_record_not_found');
  });

  it('requires a selector', () => {
    assert.equal(matchCreationRecord([rec()], { clientKey: 'master' }).code, 'reclaim_selector_required');
  });

  it('rejects expired records', () => {
    const old = rec({ ts: new Date(NOW - RECLAIM_MAX_AGE_MS - 1).toISOString() });
    assert.equal(matchCreationRecord([old], { terminalHandle: 'term_a', clientKey: 'master', now: NOW }).code, 'creation_record_expired');
  });

  it('asks for terminalHandle when the record has several handles', () => {
    const m = matchCreationRecord([rec({ handles: ['term_a', 'term_b'] })], { taskId: 'task_1', clientKey: 'master', now: NOW });
    assert.equal(m.code, 'creation_record_ambiguous_handle');
  });

  it('fails closed when the record has no worktree', () => {
    const m = matchCreationRecord([rec({ worktreePath: null })], { terminalHandle: 'term_a', clientKey: 'master', now: NOW });
    assert.equal(m.code, 'creation_record_no_worktree');
  });
});

describe('verifyLiveTerminal', () => {
  it('accepts a live terminal in the recorded worktree', () => {
    const v = verifyLiveTerminal([{ handle: 'term_a', worktreeId: `abc::${WT}` }], { handle: 'term_a', worktreePath: WT });
    assert.equal(v.ok, true);
  });
  it('rejects a terminal that is gone', () => {
    assert.equal(verifyLiveTerminal([], { handle: 'term_a', worktreePath: WT }).code, 'terminal_not_live');
  });
  it('rejects a terminal in another worktree (forged record pointing at a foreign terminal)', () => {
    const v = verifyLiveTerminal([{ handle: 'term_a', worktreeId: 'abc::/Users/x/dev/other' }], { handle: 'term_a', worktreePath: WT });
    assert.equal(v.code, 'terminal_worktree_mismatch');
  });
});

describe('helpers', () => {
  it('worktreePathOf strips repo id and path: prefix', () => {
    assert.equal(worktreePathOf(`abc::${WT}`), WT);
    assert.equal(worktreePathOf(`path:${WT}/`), WT);
  });
  it('parseCreationRecords skips bad lines', () => {
    const rs = parseCreationRecords(`{"v":1,"x":1}\nnot json\n{"v":2}\n`);
    assert.equal(rs.length, 1);
  });
});

describe('launchOutcomeTerminalHandle', () => {
  it('reads result.launch.outcome.handle when kind is terminal', async () => {
    const { launchOutcomeTerminalHandle } = await import('./creation-records.mjs');
    assert.equal(launchOutcomeTerminalHandle({ launch: { outcome: { kind: 'terminal', handle: 'term_x' } } }), 'term_x');
  });
  it('ignores chat outcomes and missing shapes', async () => {
    const { launchOutcomeTerminalHandle } = await import('./creation-records.mjs');
    assert.equal(launchOutcomeTerminalHandle({ launch: { outcome: { kind: 'chat', handle: 'chat_1' } } }), '');
    assert.equal(launchOutcomeTerminalHandle({}), '');
    assert.equal(launchOutcomeTerminalHandle(null), '');
  });
  it('creation record picks up the launch outcome handle', () => {
    const r = buildCreationRecord({
      steps: [{ step: 'worktree-create', ...env({ path: WT, launch: { outcome: { kind: 'terminal', handle: 'term_l' } } }) }],
      result: { ok: true },
      args: {},
      clientKey: 'master',
    });
    assert.deepEqual(r.handles, ['term_l']);
  });
});
