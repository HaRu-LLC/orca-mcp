/**
 * Structured (chat) agent sessions from `worktree create --agent`.
 *
 * Confirmed against Orca main (stablyai/orca), not guessed:
 * - `AgentLaunchOutcome` kind `structured` carries `sessionId` and `handle`
 *   (src/shared/agent-launch/contracts/agent-launch-intent.ts).
 * - The chat tab id is `structured-agent-session-${sessionId}`
 *   (`structuredAgentSessionTabId`).
 * - Mail to a chat is `orca_session_id:<sessionId>`
 *   (CLI skill "Messaging agents"; `ORCA_SESSION_ADDRESS_PREFIX`).
 *   A terminal is addressed by its handle. A terminal's session id is refused.
 * - `--prompt` on create journals the opening chat message
 *   (`prompt.outcome === 'journaled'`). This bridge does not pass `--prompt`
 *   (that flag is the forbidden raw handoff). After the session exists, the
 *   brief is `orchestration send --to orca_session_id:<id> --type dispatch`.
 *   The skill says a chat receives that mail as the message, with a sender header.
 * - `orchestration dispatch --inject` types into a terminal and is refused when
 *   no agent process is detected (`buildInjectRejectionMessage`). Structured
 *   placement binds with `--return-preamble` and without `--inject`.
 * - `orchestration check --wait` blocks until a matching message arrives or
 *   `--timeout-ms` expires (CLI spec). There is no CLI for `agentSession.subscribe`.
 *   A push stream of chat events is 未確認. Await uses check --wait, which
 *   returns when the message arrives.
 * - No CLI closes a chat tab. `worker-release` closes a supervised chat worker;
 *   an unsupervised `orchestration dispatch` is documented as retained with no
 *   process action. `worker-stop` fences that dispatch. `terminal close` does
 *   not accept every worker handle (worker-start notes). This bridge does not
 *   call `terminal close` for a structured-agent-session handle.
 */

export const STRUCTURED_SESSION_HANDLE_PREFIX = 'structured-agent-session-';
export const ORCA_SESSION_ADDRESS_PREFIX = 'orca_session_id:';

function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

export function isStructuredSessionHandle(handle) {
  return str(handle).startsWith(STRUCTURED_SESSION_HANDLE_PREFIX);
}

/** Bare session id from a `structured-agent-session-<id>` tab handle. */
export function sessionIdFromStructuredHandle(handle) {
  const h = str(handle);
  if (!h.startsWith(STRUCTURED_SESSION_HANDLE_PREFIX)) return '';
  return h.slice(STRUCTURED_SESSION_HANDLE_PREFIX.length);
}

/**
 * Read `result.launch.outcome` from a worktree-create / agent-launch envelope.
 * kind `chat` and any other non-terminal, non-structured kind yield an empty handle
 * (place-agent still fails). kind omitted with a handle is the older terminal shape.
 *
 * @param {object|null|undefined} result
 */
export function readLaunchPlacement(result) {
  const outcome = result && result.launch && result.launch.outcome;
  const empty = { kind: '', handle: '', sessionId: '', mailAddress: '' };
  if (!outcome || typeof outcome !== 'object') return empty;
  const kind = str(outcome.kind);
  const handle = str(outcome.handle || outcome.terminalHandle);
  let sessionId = str(outcome.sessionId);
  if (!sessionId && kind === 'structured') {
    sessionId = sessionIdFromStructuredHandle(handle);
  }
  if (kind === 'structured') {
    return {
      kind,
      handle,
      sessionId,
      mailAddress: sessionId ? `${ORCA_SESSION_ADDRESS_PREFIX}${sessionId}` : handle,
    };
  }
  if (kind === 'terminal' || kind === '') {
    return { kind: kind || 'terminal', handle, sessionId: '', mailAddress: handle };
  }
  return empty;
}

/**
 * Worker handle the bridge may treat as placed.
 * Structured: outcome.handle only (do not fall through to a worktree id).
 * Terminal / omitted kind: outcome.handle.
 * Anything else: ''.
 */
export function launchOutcomeWorkerHandle(result) {
  const placement = readLaunchPlacement(result);
  if (placement.kind === 'structured' || placement.kind === 'terminal') return placement.handle;
  return '';
}
