import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rejectNonQuestionType,
  normalizeBotName,
  normalizeQuestion,
  normalizeChat,
  buildBotQuestionSendArgv,
  buildBotReplyCheckArgv,
  buildBotReplyInboxArgv,
  replyMailboxAddress,
  extractBots,
  findBot,
  sentMessageId,
  matchBotReply,
  dropSeenBotReplies,
  shouldContinueForWorkerDone,
  summarizeMailboxRows,
  answerView,
  questionSubject,
  botAddress,
} from './bot-question.mjs';
import { ACTION_TIERS, evaluateToolsetAccess } from './toolsets.mjs';
import { CHECK_WAIT_MAX_MS } from './security-core.mjs';

describe('bot question policy', () => {
  it('accepts only question and rejects handoff before any send', () => {
    assert.equal(rejectNonQuestionType(undefined), null);
    assert.equal(rejectNonQuestionType(''), null);
    assert.equal(rejectNonQuestionType(' Question '), null);
    const handoff = rejectNonQuestionType('handoff');
    assert.equal(handoff.error, 'question_only');
    assert.equal(handoff.sent, false);
    assert.equal(handoff.resent, false);
    assert.equal(rejectNonQuestionType('status').error, 'question_only');
  });

  it('builds a bot: address and never a caller-supplied --to', () => {
    const named = normalizeBotName('  Workspace cleanup  ');
    assert.equal(named.ok, true);
    assert.equal(botAddress(named.name), 'bot:Workspace cleanup');
    assert.equal(normalizeBotName('bot:Workspace cleanup').name, 'Workspace cleanup');
    assert.equal(normalizeBotName('').ok, false);
    assert.equal(normalizeBotName('has\nnewline').ok, false);
    const argv = buildBotQuestionSendArgv({
      name: 'Workspace cleanup',
      question: 'あなたは何をする bot ですか',
      chat: 'chat_home',
    });
    assert.deepEqual(argv.slice(0, 6), [
      'orchestration', 'send',
      '--to', 'bot:Workspace cleanup',
      '--type', 'question',
    ]);
    assert.ok(argv.includes('--subject=質問'));
    assert.ok(argv.includes('--body=あなたは何をする bot ですか'));
    assert.equal(argv.includes('--body'), false);
    assert.equal(argv.includes('--subject'), false);
    const dashed = buildBotQuestionSendArgv({ name: 'Workspace cleanup', question: '--who are you' });
    assert.ok(dashed.includes('--body=--who are you'));
    assert.ok(dashed.includes('--subject=質問'));
    assert.equal(dashed.some((token) => token === '--who are you'), false);
    assert.equal(argv.includes('handoff'), false);
    assert.equal(argv.at(-2), '--chat');
    assert.equal(argv.at(-1), 'chat_home');
    assert.equal(normalizeChat('new').chat, 'new');
    assert.equal(normalizeChat('--handoff').ok, false);
    assert.equal(normalizeQuestion('').ok, false);
  });

  it('peeks run: or dispatch: and never consumes', () => {
    const argv = buildBotReplyCheckArgv({ waitMs: 45_000, mailbox: 'run:run_1' });
    assert.deepEqual(argv, [
      'orchestration', 'check', '--peek', '--json',
      '--terminal', 'run:run_1',
      '--wait', '--timeout-ms', '45000',
    ]);
    assert.equal(argv.includes('--run'), false);
    assert.ok(CHECK_WAIT_MAX_MS <= 45_000);
    const inbox = buildBotReplyInboxArgv({ mailbox: 'dispatch:ctx_1' });
    assert.deepEqual(inbox, [
      'orchestration', 'inbox', '--full', '--limit', '50', '--json',
      '--terminal', 'dispatch:ctx_1',
    ]);
    assert.equal(replyMailboxAddress({ boundRunId: 'run_bound' }), 'run:run_bound');
    assert.equal(
      replyMailboxAddress({
        boundRunId: 'run_bound',
        sendEnvelope: { result: { message: { to: 'dispatch:bot_disp', run_id: 'bot_run' } } },
      }),
      'run:run_bound',
    );
    assert.equal(replyMailboxAddress({}), null);
  });

  it('reads bot list, matches name or id, and finds the reply by request id', () => {
    const bots = extractBots({
      ok: true,
      result: {
        bots: [
          { id: 'bot_ws', name: 'Workspace cleanup', paused: false, chats: { count: 1, home: true } },
          { id: 'bot_paused', name: 'Paused one', paused: true },
        ],
      },
    });
    assert.equal(findBot(bots, 'workspace cleanup').id, 'bot_ws');
    assert.equal(findBot(bots, 'bot_paused').name, 'Paused one');
    assert.equal(findBot(bots, 'missing'), null);
    const envelope = { ok: true, result: { message: { id: 'msg_q1' }, sent: true } };
    assert.equal(sentMessageId(envelope), 'msg_q1');
    const reply = {
      id: 'msg_a',
      type: 'status',
      subject: 'Re: question',
      body: '作業フォルダを片付けます。',
      thread_id: 'msg_q1',
      payload: JSON.stringify({ requestId: 'msg_q1', botAnswer: { view: 'answered' } }),
    };
    const noise = { id: 'msg_done', type: 'worker_done', dispatchId: 'ctx_1', body: 'done' };
    assert.equal(matchBotReply([noise, reply], { messageId: 'msg_q1' }), reply);
    assert.equal(matchBotReply([noise], { messageId: 'msg_q1' }), null);
    const follow = {
      id: 'msg_follow',
      type: 'status',
      thread_id: 'msg_q1',
      body: 'still working on it',
      payload: JSON.stringify({ requestId: 'msg_q1' }),
    };
    const seen = { replyIds: new Set(['msg_a']) };
    const kept = dropSeenBotReplies([noise, reply, follow], seen);
    assert.deepEqual(kept.map((m) => m.id), ['msg_done', 'msg_follow']);
    assert.equal(shouldContinueForWorkerDone([reply], seen), true);
    assert.equal(shouldContinueForWorkerDone([reply, noise], seen), false);
    assert.equal(shouldContinueForWorkerDone([follow], seen), false);
    const rows = summarizeMailboxRows([reply, noise]);
    assert.equal(rows[0].type, 'status');
    assert.equal(rows[0].request_id, 'msg_q1');
    assert.equal(rows[0].thread_id, 'msg_q1');
    assert.ok(rows[0].body.length <= 80);
    assert.equal(answerView(reply).body, '作業フォルダを片付けます。');
    assert.equal(questionSubject('one\ntwo'), 'one');
  });

  it('sits in the dispatch toolset and does not require admin', () => {
    assert.equal(ACTION_TIERS.ask, 'dispatch');
    const denied = evaluateToolsetAccess({ op: 'ask', enabled: ['status'] });
    assert.equal(denied.ok, false);
    assert.equal(denied.required_tier, 'dispatch');
    const allowed = evaluateToolsetAccess({ op: 'ask', enabled: ['status', 'dispatch'] });
    assert.equal(allowed.ok, true);
  });
});
