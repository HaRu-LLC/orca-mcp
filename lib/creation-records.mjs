/**
 * Creation records + reclaim matching (local patch, not upstream).
 *
 * dispatch が worktree / terminal を作ったら、成功・失敗に関わらず作成記録を残す。
 * 所有権がメモリにしか無い（store signer なし）ため、中継の再起動や dispatch の
 * 途中失敗（例: place-agent）で持ち主のいない端末が残る。action=reclaim は、
 * 作成記録と ID が合い、かつ Orca の現在の端末一覧と照合が合ったときだけ、
 * その端末の所有権を同じ clientKey に戻す。
 *
 * Pure helpers only (no process I/O) so unit tests can import them.
 *
 * 受け入れたリスク: worker も中継と同じ uid で動くため、記録ファイル自体は
 * worker でも書き換えられる。Orca の端末一覧（handle が実在し、記録の worktree の
 * 中にある）との照合で狭めるが、ゼロにはならない。
 */

export const CREATION_RECORD_VERSION = 1;
export const RECLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function str(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return s;
}

function firstStr(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const s = str(obj[k]);
    if (s) return s;
  }
  return '';
}

function stepResult(step) {
  const r = step && step.envelope && step.envelope.result;
  return r && typeof r === 'object' ? r : null;
}

function lastStep(steps, prefix) {
  if (!Array.isArray(steps)) return null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && typeof s.step === 'string' && s.step.startsWith(prefix)) return s;
  }
  return null;
}

/**
 * Orca (current) returns the agent terminal of `worktree create --agent` under
 * result.launch.outcome = { kind: 'terminal', handle }. kind 'chat' has no
 * terminal, so it yields '' (caller then fails at place-agent as before).
 */
export function launchOutcomeTerminalHandle(result) {
  const outcome = result && result.launch && result.launch.outcome;
  if (!outcome || typeof outcome !== 'object') return '';
  const kind = str(outcome.kind);
  if (kind && kind !== 'terminal') return '';
  return firstStr(outcome, 'handle', 'terminalHandle');
}

/** Strip Orca's `<repoId>::` prefix and `path:` selector prefix. */
export function worktreePathOf(value) {
  let s = str(value);
  if (!s) return '';
  const i = s.lastIndexOf('::');
  if (i >= 0) s = s.slice(i + 2);
  if (s.startsWith('path:')) s = s.slice(5);
  return s.replace(/\/+$/, '');
}

/**
 * Build a creation record from dispatch steps + result. Returns null when the
 * dispatch created nothing (no worktree, no terminal).
 */
export function buildCreationRecord({ steps, result, args = {}, clientKey, now = Date.now() } = {}) {
  const res = result && typeof result === 'object' ? result : {};
  const handles = new Set();

  const wtStep = lastStep(steps, 'worktree-create');
  const wr = stepResult(wtStep);
  let worktreePath = '';
  let worktreeId = '';
  if (wr) {
    worktreePath = worktreePathOf(firstStr(wr, 'path') || firstStr(wr.worktree, 'path'));
    worktreeId = firstStr(wr, 'id') || firstStr(wr.worktree, 'id');
    for (const h of [
      firstStr(wr, 'agentTerminalHandle'),
      launchOutcomeTerminalHandle(wr),
      firstStr(wr.startupTerminal, 'handle'),
      firstStr(wr, 'handle'),
    ]) if (h) handles.add(h);
  }

  const termStep = lastStep(steps, 'terminal-create');
  const tr = stepResult(termStep);
  if (tr) {
    for (const h of [
      firstStr(tr, 'handle'),
      firstStr(tr.terminal, 'handle'),
      firstStr(tr, 'agentTerminalHandle'),
    ]) if (h) handles.add(h);
    if (!worktreePath) {
      worktreePath = worktreePathOf(
        firstStr(tr.terminal, 'worktreePath', 'worktreeId') || firstStr(tr, 'worktreePath', 'worktreeId'),
      );
    }
  }

  const resHandle = firstStr(res, 'terminal_handle', 'terminalHandle');
  if (resHandle) handles.add(resHandle);
  if (!worktreePath) worktreePath = worktreePathOf(firstStr(res, 'worktree'));

  if (!wr && !tr && handles.size === 0) return null;

  let dispatchId = firstStr(res, 'dispatch_id', 'dispatchId');
  if (!dispatchId) {
    const dStep = lastStep(steps, 'dispatch-');
    const dr = stepResult(dStep);
    if (dr) dispatchId = firstStr(dr.dispatch, 'id') || firstStr(dr, 'dispatchId', 'dispatch_id');
  }
  const runStep = lastStep(steps, 'run-create');
  const taskStep = lastStep(steps, 'task-create');
  const runId =
    firstStr(res, 'run_id', 'runId') ||
    firstStr(stepResult(runStep)?.run, 'id') ||
    str(args.run_id);
  const taskId =
    firstStr(res, 'task_id', 'taskId') ||
    firstStr(stepResult(taskStep)?.task, 'id');

  return {
    v: CREATION_RECORD_VERSION,
    ts: new Date(now).toISOString(),
    clientKey: str(clientKey) || 'default',
    ok: res.ok !== false,
    stage: str(res.stage) || null,
    worktreeMode: str(args.worktree) || 'new-top-level',
    worktreePath: worktreePath || null,
    worktreeId: worktreeId || null,
    name: str(args.name) || null,
    agent: str(args.agent) || null,
    runId: runId || null,
    taskId: taskId || null,
    dispatchId: dispatchId || null,
    handles: [...handles],
  };
}

/**
 * Handles found by listing a NEW worktree's terminals may be added (every
 * terminal in a worktree the bridge just created is bridge-made). Never for
 * worktree=current — that is the user's own checkout.
 */
export function mayAddListedHandles(record) {
  return Boolean(
    record &&
      record.worktreeMode !== 'current' &&
      record.worktreePath &&
      Array.isArray(record.handles) &&
      record.handles.length === 0,
  );
}

/** Parse ndjson text into records (bad lines skipped). */
export function parseCreationRecords(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r && typeof r === 'object' && r.v === CREATION_RECORD_VERSION) out.push(r);
    } catch { /* skip */ }
  }
  return out;
}

/**
 * Find the newest record of this clientKey whose ID matches the selector.
 * @returns {{ ok: true, record: object, handle: string } | { ok: false, code: string, detail: string }}
 */
export function matchCreationRecord(records, {
  terminalHandle,
  dispatchId,
  taskId,
  clientKey,
  now = Date.now(),
  maxAgeMs = RECLAIM_MAX_AGE_MS,
} = {}) {
  const h = str(terminalHandle);
  const d = str(dispatchId);
  const t = str(taskId);
  if (!h && !d && !t) {
    return { ok: false, code: 'reclaim_selector_required', detail: 'Pass terminalHandle, dispatchId, or taskId from the original dispatch.' };
  }
  const ck = str(clientKey) || 'default';
  const list = Array.isArray(records) ? records : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!r || r.clientKey !== ck) continue;
    const handles = Array.isArray(r.handles) ? r.handles.map(str).filter(Boolean) : [];
    if (h && !handles.includes(h)) continue;
    if (d && str(r.dispatchId) !== d) continue;
    if (t && str(r.taskId) !== t) continue;
    const age = now - Date.parse(r.ts);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
      return { ok: false, code: 'creation_record_expired', detail: 'The matching creation record is too old to reclaim.' };
    }
    let handle = h;
    if (!handle) {
      if (handles.length !== 1) {
        return {
          ok: false,
          code: handles.length === 0 ? 'creation_record_no_handle' : 'creation_record_ambiguous_handle',
          detail: handles.length === 0
            ? 'The creation record has no terminal handle.'
            : 'The creation record has several handles; pass terminalHandle.',
        };
      }
      handle = handles[0];
    }
    if (!str(r.worktreePath)) {
      return { ok: false, code: 'creation_record_no_worktree', detail: 'The creation record has no worktree to verify against.' };
    }
    return { ok: true, record: r, handle };
  }
  return { ok: false, code: 'creation_record_not_found', detail: 'No creation record of this client matches the given id.' };
}

/**
 * Verify against Orca's live terminal list: handle exists and lives in the
 * recorded worktree.
 * @param {object[]} terminals  `orca terminal list --json` → result.terminals
 */
export function verifyLiveTerminal(terminals, { handle, worktreePath } = {}) {
  const h = str(handle);
  const want = worktreePathOf(worktreePath);
  const list = Array.isArray(terminals) ? terminals : [];
  const t = list.find((x) => x && str(x.handle) === h);
  if (!t) return { ok: false, code: 'terminal_not_live', detail: 'The terminal no longer exists in Orca.' };
  const got = worktreePathOf(t.worktreeId || t.worktreePath || t.worktree);
  if (!want || got !== want) {
    return { ok: false, code: 'terminal_worktree_mismatch', detail: 'The terminal is not in the recorded worktree.' };
  }
  return { ok: true, terminal: t };
}
