/**
 * Local patch 8: action=release also removes the worktree its dispatch created.
 *
 * The worktree is removed only when ALL of these hold (otherwise it is kept and
 * the reason is returned as worktree: { state: 'retained', reason }):
 *   1. a creation record of THIS clientKey matches the released dispatch
 *      (dispatchId and/or terminalHandle), and the record made a NEW worktree
 *      (worktree=current is the user's own checkout — never removed)
 *   2. Orca knows the worktree and it is not the main worktree (isMainWorktree)
 *   3. git sees a linked worktree (git-dir != git-common-dir) with an empty
 *      `git status --porcelain`
 *   4. no commit on HEAD is missing from main / any remote ref (unpushed work)
 *   5. no terminal other than the one this release just closed is open in it
 * keepWorktree:true skips removal (reason keep_worktree_requested).
 *
 * Effects are injected so the decision logic is unit-testable.
 */

import { matchCreationRecord, worktreePathOf } from './creation-records.mjs';

function str(v) {
  return v == null ? '' : String(v).trim();
}

function retained(reason, extra = {}) {
  return { state: 'retained', reason, ...extra };
}

/**
 * Find the creation record for this release. Unlike reclaim, the handle need
 * not be unique in the record: the release already proved ownership.
 */
export function findReleaseCreationRecord(records, { dispatchId, terminalHandle, clientKey, now } = {}) {
  const d = str(dispatchId);
  const h = str(terminalHandle);
  if (!d && !h) return { ok: false, reason: 'creation_record_not_found' };
  const m = matchCreationRecord(records, {
    dispatchId: d || undefined,
    terminalHandle: h || undefined,
    clientKey,
    now,
  });
  if (m.ok) return { ok: true, record: m.record };
  // ambiguous/no handle only matters for reclaim; the record itself matched.
  if (m.code === 'creation_record_ambiguous_handle' || m.code === 'creation_record_no_handle') {
    const ck = str(clientKey) || 'default';
    const list = Array.isArray(records) ? records : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (r && r.clientKey === ck && (!d || str(r.dispatchId) === d)) {
        if (!str(r.worktreePath)) return { ok: false, reason: 'creation_record_no_worktree' };
        return { ok: true, record: r };
      }
    }
  }
  const reason = {
    creation_record_expired: 'creation_record_expired',
    creation_record_no_worktree: 'creation_record_no_worktree',
  }[m.code] || 'creation_record_not_found';
  return { ok: false, reason };
}

/**
 * @param {object} p
 * @param {string|null} p.dispatchId
 * @param {string|null} p.terminalHandle   handle of the released worker (record match)
 * @param {string|null} [p.closedHandle]   handle this release confirmed closed; only
 *                                         this one may still be listed in the worktree
 * @param {boolean} p.terminalClosed       release confirmed the worker is closed
 * @param {boolean} [p.keepWorktree]
 * @param {string} p.clientKey
 * @param {object} deps
 * @param {() => object[]} deps.readCreationRecords
 * @param {(argv: string[], opts?: object) => Promise<object>} deps.runJson  orca CLI
 * @param {(env: object) => boolean} deps.envOk
 * @param {(cwd: string, args: string[]) => Promise<string>} deps.git  stdout; throws on error
 * @param {number} [deps.now]
 * @returns {Promise<{state:'removed', path:string} | {state:'retained', reason:string}>}
 */
export async function cleanupDispatchWorktree(p = {}, deps = {}) {
  const { readCreationRecords, runJson, envOk, git } = deps;
  if (p.keepWorktree === true) return retained('keep_worktree_requested');
  if (!p.terminalClosed) return retained('terminal_not_closed');
  if (typeof readCreationRecords !== 'function' || typeof runJson !== 'function' || typeof git !== 'function') {
    return retained('cleanup_unavailable');
  }

  // 1. creation record of THIS client
  let records;
  try {
    records = readCreationRecords();
  } catch {
    return retained('creation_record_unreadable');
  }
  const found = findReleaseCreationRecord(records, {
    dispatchId: p.dispatchId,
    terminalHandle: p.terminalHandle,
    clientKey: p.clientKey,
    now: deps.now,
  });
  if (!found.ok) return retained(found.reason);
  const record = found.record;
  const handle = str(p.terminalHandle);
  if (handle && Array.isArray(record.handles) && !record.handles.map(str).includes(handle)) {
    return retained('terminal_not_in_creation_record');
  }
  if (str(record.worktreeMode) === 'current') return retained('worktree_not_created_by_dispatch');
  const wtPath = worktreePathOf(record.worktreePath);
  if (!wtPath || !wtPath.startsWith('/')) return retained('creation_record_no_worktree');
  const base = { path: wtPath };

  // 2. Orca's view: exists, not main
  const shown = await runJson(['worktree', 'show', '--worktree', `path:${wtPath}`, '--json'], { timeoutMs: 15_000 });
  if (!envOk(shown)) return retained('worktree_not_found', base);
  const wt = shown.envelope?.result?.worktree || shown.envelope?.result || {};
  if (worktreePathOf(wt.path) !== wtPath) return retained('worktree_path_mismatch', base);
  if (wt.isMainWorktree !== false) return retained('main_worktree', base);
  if (wt.isBare === true) return retained('main_worktree', base);

  // 3. git: linked worktree + clean
  try {
    const top = str(await git(wtPath, ['rev-parse', '--show-toplevel']));
    if (worktreePathOf(top) !== wtPath) return retained('worktree_path_mismatch', base);
    const gitDir = str(await git(wtPath, ['rev-parse', '--absolute-git-dir']));
    const common = str(await git(wtPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    if (!gitDir || !common || gitDir === common) return retained('main_worktree', base);
    const status = await git(wtPath, ['status', '--porcelain', '--untracked-files=all']);
    if (str(status)) return retained('uncommitted_changes', base);

    // 4. no commit outside main / remote refs
    const refs = str(await git(wtPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/main', 'refs/heads/master']))
      .split('\n').map(str).filter(Boolean);
    const unpushed = str(await git(wtPath, ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...refs]));
    if (unpushed !== '0') return retained('unpushed_commits', { ...base, unpushed_commits: Number(unpushed) || unpushed });
  } catch (e) {
    return retained('git_check_failed', { ...base, error: String(e?.message || e).slice(0, 200) });
  }

  // 5. only this release's terminal may have been open
  const listed = await runJson(['terminal', 'list', '--worktree', `path:${wtPath}`, '--json'], { timeoutMs: 15_000 });
  if (!envOk(listed)) return retained('terminal_list_failed', base);
  const terms = listed.envelope?.result?.terminals;
  if (!Array.isArray(terms)) return retained('terminal_list_failed', base);
  if (listed.envelope?.result?.truncated === true) return retained('terminal_list_failed', base);
  const closed = str(p.closedHandle);
  const others = terms.filter((t) => t && str(t.handle) && str(t.handle) !== closed);
  if (others.length > 0) {
    return retained('other_terminals_open', { ...base, open_terminals: others.length });
  }

  const rm = await runJson(['worktree', 'rm', '--worktree', `path:${wtPath}`, '--json'], { timeoutMs: 60_000 });
  if (!envOk(rm)) {
    const code = rm?.envelope?.error?.code || rm?.error?.code || 'unknown';
    return retained('worktree_rm_failed', { ...base, code });
  }
  return { state: 'removed', path: wtPath };
}
