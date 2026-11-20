import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStructuredSessionHandle,
  readLaunchPlacement,
  sessionIdFromStructuredHandle,
} from './structured-session.mjs';

const SID = '75a099c4-1111-4111-8111-111111111111';
const HANDLE = `structured-agent-session-${SID}`;

describe('readLaunchPlacement', () => {
  it('reads a structured chat the way worktree create reports it', () => {
    const placement = readLaunchPlacement({
      launch: {
        outcome: { kind: 'structured', handle: HANDLE, sessionId: SID },
        receipt: { reason: 'user_default', detail: 'Started a structured chat session, the default for new agent tabs in your settings.' },
      },
    });
    assert.equal(placement.kind, 'structured');
    assert.equal(placement.handle, HANDLE);
    assert.equal(placement.sessionId, SID);
    assert.equal(placement.mailAddress, `orca_session_id:${SID}`);
    assert.equal(isStructuredSessionHandle(HANDLE), true);
  });

  it('derives the session id from the documented tab handle when sessionId is absent', () => {
    const placement = readLaunchPlacement({
      launch: { outcome: { kind: 'structured', handle: HANDLE } },
    });
    assert.equal(placement.sessionId, SID);
    assert.equal(sessionIdFromStructuredHandle(HANDLE), SID);
  });

  it('keeps a terminal outcome and ignores kind chat', () => {
    assert.equal(
      readLaunchPlacement({ launch: { outcome: { kind: 'terminal', handle: 'term_x' } } }).handle,
      'term_x',
    );
    assert.equal(
      readLaunchPlacement({ launch: { outcome: { kind: 'chat', handle: 'chat_1' } } }).handle,
      '',
    );
    assert.equal(readLaunchPlacement(null).handle, '');
  });
});
