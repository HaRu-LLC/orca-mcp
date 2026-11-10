import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanupDispatchWorktree, findReleaseCreationRecord } from './worktree-cleanup.mjs';

const WT = '/tmp/wt/fix8';
const H = 'term_own';
const NOW = Date.parse('2026-11-10T04:00:00Z');

function rec(over = {}) {
  return {
    v: 1,
    ts: '2026-11-10T03:00:00Z',
    clientKey: 'master',
    ok: true,
    stage: 'ready',
    worktreeMode: 'new-top-level',
    worktreePath: WT,
    dispatchId: 'ctx_own',
    taskId: 'task_own',
    handles: [H],
    ...over,
  };
}

function envOk(d) {
  return d && d.ok === true && d.envelope;
}

function okEnv(result) {
  return { ok: true, envelope: { ok: true, result } };
}

/** Fake world: everything clean unless overridden. Records calls. */
function world(over = {}) {
  const calls = [];
  const w = {
    records: [rec()],
    show: { path: WT, isMainWorktree: false, isBare: false },
    terminals: [],
    status: '',
    unpushed: '0',
    gitDir: '/repo/.git/worktrees/fix8',
    common: '/repo/.git',
    top: WT,
    rmOk: true,
    ...over,
  };
  const deps = {
    now: NOW,
    envOk,
    readCreationRecords: () => w.records,
    runJson: async (argv) => {
      calls.push(argv.join(' '));
      if (argv[0] === 'worktree' && argv[1] === 'show') {
        return w.show ? okEnv({ worktree: w.show }) : { ok: false, envelope: { ok: false, error: { code: 'selector_not_found' } } };
      }
      if (argv[0] === 'terminal' && argv[1] === 'list') return okEnv({ terminals: w.terminals, truncated: false });
      if (argv[0] === 'worktree' && argv[1] === 'rm') {
        return w.rmOk ? okEnv({ removed: true }) : { ok: false, envelope: { ok: false, error: { code: 'rm_failed' } } };
      }
      throw new Error(`unexpected ${argv.join(' ')}`);
    },
    git: async (cwd, args) => {
      calls.push(`git ${args.join(' ')}`);
      const a = args.join(' ');
      if (a === 'rev-parse --show-toplevel') return `${w.top}\n`;
      if (a === 'rev-parse --absolute-git-dir') return `${w.gitDir}\n`;
      if (a.includes('--git-common-dir')) return `${w.common}\n`;
      if (args[0] === 'status') return w.status;
      if (args[0] === 'for-each-ref') return 'refs/heads/main\n';
      if (args[0] === 'rev-list') return `${w.unpushed}\n`;
      throw new Error(`unexpected git ${a}`);
    },
  };
  return { w, deps, calls };
}

const P = { dispatchId: 'ctx_own', terminalHandle: H, closedHandle: H, terminalClosed: true, clientKey: 'master' };

describe('local patch 8: release removes the dispatch worktree', () => {
  it('removes a clean worktree created by this client after the close', async () => {
    const { deps, calls } = world({ terminals: [{ handle: H }] });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.deepEqual(out, { state: 'removed', path: WT });
    assert.equal(calls.at(-1), `worktree rm --worktree path:${WT} --json`);
    assert.ok(!calls.at(-1).includes('--force'));
  });

  it('keepWorktree:true keeps it with zero effects', async () => {
    const { deps, calls } = world();
    const out = await cleanupDispatchWorktree({ ...P, keepWorktree: true }, deps);
    assert.deepEqual(out, { state: 'retained', reason: 'keep_worktree_requested' });
    assert.equal(calls.length, 0);
  });

  it('does nothing before the terminal is closed', async () => {
    const { deps, calls } = world();
    const out = await cleanupDispatchWorktree({ ...P, terminalClosed: false }, deps);
    assert.equal(out.reason, 'terminal_not_closed');
    assert.equal(calls.length, 0);
  });

  it('another client\'s record is not ours', async () => {
    const { deps, calls } = world({ records: [rec({ clientKey: 'sid:other' })] });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.deepEqual(out, { state: 'retained', reason: 'creation_record_not_found' });
    assert.equal(calls.length, 0);
  });

  it('no record for this dispatch → retained', async () => {
    const { deps } = world({ records: [rec({ dispatchId: 'ctx_other', handles: ['term_x'] })] });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'creation_record_not_found');
  });

  it('worktree=current (user checkout) is never removed', async () => {
    const { deps, calls } = world({ records: [rec({ worktreeMode: 'current' })] });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'worktree_not_created_by_dispatch');
    assert.ok(!calls.some((c) => c.startsWith('worktree rm')));
  });

  it('expired record → retained', async () => {
    const { deps } = world({ records: [rec({ ts: '2026-10-01T00:00:00Z' })] });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'creation_record_expired');
  });

  it('isMainWorktree from Orca → retained', async () => {
    const { deps, calls } = world({ show: { path: WT, isMainWorktree: true } });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'main_worktree');
    assert.ok(!calls.some((c) => c.startsWith('worktree rm')));
  });

  it('missing isMainWorktree is treated as main (fail closed)', async () => {
    const { deps } = world({ show: { path: WT } });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'main_worktree');
  });

  it('git says it is the main checkout (git-dir == common dir) → retained', async () => {
    const { deps } = world({ gitDir: '/repo/.git', common: '/repo/.git' });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'main_worktree');
  });

  it('unknown worktree in Orca → retained', async () => {
    const { deps } = world({ show: null });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'worktree_not_found');
  });

  it('uncommitted / untracked changes → retained', async () => {
    const { deps, calls } = world({ status: '?? new.txt\n' });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'uncommitted_changes');
    assert.equal(out.path, WT);
    assert.ok(!calls.some((c) => c.startsWith('worktree rm')));
  });

  it('commits not in main nor any remote → retained', async () => {
    const { deps, calls } = world({ unpushed: '2' });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'unpushed_commits');
    assert.equal(out.unpushed_commits, 2);
    assert.ok(calls.includes('git rev-list --count HEAD --not --remotes refs/heads/main'));
  });

  it('another terminal open in the worktree → retained', async () => {
    const { deps, calls } = world({ terminals: [{ handle: H }, { handle: 'term_someone' }] });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'other_terminals_open');
    assert.ok(!calls.some((c) => c.startsWith('worktree rm')));
  });

  it('own handle still listed but not confirmed closed → retained', async () => {
    const { deps } = world({ terminals: [{ handle: H }] });
    const out = await cleanupDispatchWorktree({ ...P, closedHandle: null }, deps);
    assert.equal(out.reason, 'other_terminals_open');
  });

  it('handle not in the matched record → retained', async () => {
    const { deps } = world({ records: [rec({ handles: ['term_a', 'term_b'] })] });
    const out = await cleanupDispatchWorktree({ ...P, terminalHandle: 'term_c', closedHandle: 'term_c' }, deps);
    assert.equal(out.state, 'retained');
  });

  it('git failure → retained, never removed', async () => {
    const { deps, calls } = world();
    deps.git = async () => { throw new Error('boom'); };
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'git_check_failed');
    assert.ok(!calls.some((c) => c.startsWith('worktree rm')));
  });

  it('worktree rm failure → retained with code', async () => {
    const { deps } = world({ rmOk: false });
    const out = await cleanupDispatchWorktree(P, deps);
    assert.equal(out.reason, 'worktree_rm_failed');
    assert.equal(out.code, 'rm_failed');
  });

  it('record with several handles still matches by dispatchId', () => {
    const m = findReleaseCreationRecord([rec({ handles: ['a', 'b'] })], { dispatchId: 'ctx_own', clientKey: 'master', now: NOW });
    assert.equal(m.ok, true);
  });
});

describe('local patch 8: git checks against a real repository', () => {
  const git = async (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  function setup() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtclean-')));
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'wt');
    const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
    fs.mkdirSync(repo);
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    g(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
    return { root, repo, wt, g };
  }
  function deps(wt, repo, removed) {
    return {
      now: NOW,
      envOk,
      git,
      readCreationRecords: () => [rec({ worktreePath: wt })],
      runJson: async (argv) => {
        if (argv[1] === 'show') {
          const p = argv[3].slice(5);
          return okEnv({ worktree: { path: p, isMainWorktree: p === repo } });
        }
        if (argv[1] === 'list') return okEnv({ terminals: [] });
        if (argv[1] === 'rm') { removed.push(argv[3]); return okEnv({}); }
        throw new Error('unexpected');
      },
    };
  }

  it('clean linked worktree → removed; dirty / local commit → retained', async () => {
    const { root, repo, wt, g } = setup();
    try {
      const removed = [];
      let out = await cleanupDispatchWorktree(P, deps(wt, repo, removed));
      assert.deepEqual(out, { state: 'removed', path: wt });

      fs.writeFileSync(path.join(wt, 'x.txt'), 'x');
      out = await cleanupDispatchWorktree(P, deps(wt, repo, removed));
      assert.equal(out.reason, 'uncommitted_changes');

      g(wt, 'add', 'x.txt');
      g(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
      out = await cleanupDispatchWorktree(P, deps(wt, repo, removed));
      assert.equal(out.reason, 'unpushed_commits');

      g(repo, 'merge', '-q', '--ff-only', 'feat');
      out = await cleanupDispatchWorktree(P, deps(wt, repo, removed));
      assert.equal(out.state, 'removed');
      assert.equal(removed.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the main checkout is never removed even if a record points at it', async () => {
    const { root, repo } = setup();
    try {
      const removed = [];
      const d = deps(repo, '/not-main', removed); // Orca wrongly says not main
      const out = await cleanupDispatchWorktree(P, d);
      assert.equal(out.reason, 'main_worktree'); // git-dir == common-dir
      assert.equal(removed.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
