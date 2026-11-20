/**
 * Ask one Orca bot a question and recognize the mailed answer.
 *
 * Pure helpers. The server sends `orchestration send --to bot:<name> --type question`
 * once, then waits with the same `orchestration check --wait` await uses.
 * Handoff and every other type are refused here, before any argv is built.
 *
 * Shapes below are estimated from the caller's live `orca bot list` / `bot chats`
 * notes (2026-11-20) and from upstream Orca (bot roster + bot-request-outcome).
 * This repo's pinned CLI spec is v1.4.180 and has no `bot` commands and no
 * `send --chat`. Nothing here was executed against a live `orca` binary.
 */

export const BOT_ADDRESS_PREFIX = 'bot:';

/** Same ceiling as await. A few seconds of inbox fallback is allowed on top of the blocking wait. */
export const BOT_REPLY_POLL_MS = 1000;

/** A question is one argv slot. Keep it well under typical OS limits. */
export const BOT_QUESTION_MAX_CHARS = 32_000;

const BOT_NAME_MAX_CHARS = 200;
const BOT_CHAT_MAX_CHARS = 200;
const SUBJECT_MAX_CHARS = 80;

/**
 * @param {unknown} type
 * @returns {{ ok: false, error: string, type: string, sent: false, resent: false, detail: string } | null}
 */
export function rejectNonQuestionType(type) {
  if (type == null) return null;
  const text = String(type).trim().toLowerCase();
  if (!text || text === 'question') return null;
  return {
    ok: false,
    error: 'question_only',
    type: text,
    sent: false,
    resent: false,
    detail:
      'action=ask sends only --type question. ' +
      'handoff and other work requests are rejected and nothing was sent.',
  };
}

/**
 * Bot name, or one leading `bot:` prefix. Never a raw `--to` the caller composed.
 * @param {unknown} raw
 * @returns {{ ok: true, name: string } | { ok: false, error: string, sent: false, resent: false, detail: string }}
 */
export function normalizeBotName(raw) {
  let name = String(raw ?? '').trim();
  if (name.toLowerCase().startsWith(BOT_ADDRESS_PREFIX)) {
    name = name.slice(BOT_ADDRESS_PREFIX.length).trim();
  }
  if (!name) {
    return {
      ok: false,
      error: 'bot_required',
      sent: false,
      resent: false,
      detail: 'bot is required (the bot name, for example "Workspace cleanup").',
    };
  }
  if (name.length > BOT_NAME_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(name)) {
    return {
      ok: false,
      error: 'bot_invalid',
      sent: false,
      resent: false,
      detail: 'bot must be a single name without control characters.',
    };
  }
  return { ok: true, name };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, question: string } | { ok: false, error: string, sent: false, resent: false, detail: string }}
 */
export function normalizeQuestion(raw) {
  const question = String(raw ?? '');
  if (!question.trim()) {
    return {
      ok: false,
      error: 'question_required',
      sent: false,
      resent: false,
      detail: 'question is required.',
    };
  }
  if (question.length > BOT_QUESTION_MAX_CHARS || /[\u0000]/.test(question)) {
    return {
      ok: false,
      error: 'question_invalid',
      sent: false,
      resent: false,
      detail: `question must be at most ${BOT_QUESTION_MAX_CHARS} characters.`,
    };
  }
  return { ok: true, question };
}

/**
 * Optional chat id. Omitted → the bot's Home Chat (upstream send notes).
 * `new` is still a question, not a handoff.
 * @param {unknown} raw
 * @returns {{ ok: true, chat: string | null } | { ok: false, error: string, sent: false, resent: false, detail: string }}
 */
export function normalizeChat(raw) {
  if (raw == null || String(raw).trim() === '') return { ok: true, chat: null };
  const chat = String(raw).trim();
  if (chat.length > BOT_CHAT_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(chat) || chat.startsWith('-')) {
    return {
      ok: false,
      error: 'chat_invalid',
      sent: false,
      resent: false,
      detail: 'chat must be a chat id from `orca bot chats`, or "new".',
    };
  }
  return { ok: true, chat };
}

/** `--to bot:<name>`. The name is one argv element, so spaces stay inside it. */
export function botAddress(name) {
  return `${BOT_ADDRESS_PREFIX}${name}`;
}

/**
 * Fixed subject. The body is the question; repeating it as the subject makes
 * the bot chat show the same sentence twice (title and text).
 */
export const BOT_QUESTION_SUBJECT = '質問';

/** First line, collapsed, capped. Not used as the mailed subject. */
export function questionSubject(question) {
  const line = String(question).split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim();
  if (!line) return 'question';
  if (line.length <= SUBJECT_MAX_CHARS) return line;
  return `${line.slice(0, SUBJECT_MAX_CHARS - 1)}…`;
}

/** One argv token. A separate token that starts with `--` is parsed as a flag. */
function flagEquals(name, value) {
  return `--${name}=${String(value)}`;
}

/**
 * Argv before sender injection. Type is fixed. There is no parameter for it.
 * Subject and body are `=` tokens so a question that starts with `--` still arrives.
 * @param {{ name: string, question: string, chat?: string | null, subject?: string }} p
 */
export function buildBotQuestionSendArgv({ name, question, chat = null, subject } = {}) {
  const argv = [
    'orchestration',
    'send',
    '--to',
    botAddress(name),
    '--type',
    'question',
    flagEquals('subject', subject || BOT_QUESTION_SUBJECT),
    flagEquals('body', question),
    '--json',
  ];
  if (chat) argv.push('--chat', String(chat));
  return argv;
}

/**
 * Mailbox a bound coordinator reads for the bot's answer.
 * The answer returns to the sender's bound Run (`run:<coordinator id>`).
 * The send receipt's `to` / `run_id` names the bot's own Run or Dispatch and
 * is ignored. Null means the sender is not bound: read the sender terminal.
 * @param {{ boundRunId?: string | null }} p
 * @returns {string | null}
 */
export function replyMailboxAddress({ boundRunId = null } = {}) {
  if (boundRunId == null || String(boundRunId).trim() === '') return null;
  const id = String(boundRunId).replace(/^run:/, '').trim();
  if (!id) return null;
  return `run:${id}`;
}

/**
 * Non-consuming wait. Always `--peek`. `--terminal` is the reply mailbox when
 * it is `run:` or `dispatch:`; otherwise the server injects the sender handle.
 * No `--run`: that flag plus the sender handle does not read `run:<id>`.
 */
export function buildBotReplyCheckArgv({ waitMs = 0, mailbox = null } = {}) {
  const argv = ['orchestration', 'check', '--peek', '--json'];
  if (mailbox) argv.push('--terminal', String(mailbox));
  const ms = Number(waitMs);
  if (Number.isFinite(ms) && ms > 0) argv.push('--wait', '--timeout-ms', String(Math.floor(ms)));
  return argv;
}

/** Non-consuming read of the same mailbox. Never marks mail handled. */
export function buildBotReplyInboxArgv({ mailbox = null, limit = 50 } = {}) {
  const argv = ['orchestration', 'inbox', '--full', '--limit', String(limit), '--json'];
  if (mailbox) argv.push('--terminal', String(mailbox));
  return argv;
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

export function coercePayload(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw;
  return null;
}

/**
 * `orca bot list --json` → result.bots[]. Also accepts a bare array.
 * @param {unknown} envelope
 * @returns {object[]}
 */
export function extractBots(envelope) {
  const root = envelope && typeof envelope === 'object' ? envelope : {};
  const result = root.result && typeof root.result === 'object' ? root.result : root;
  const bots = Array.isArray(result.bots)
    ? result.bots
    : Array.isArray(result)
      ? result
      : Array.isArray(root.bots)
        ? root.bots
        : [];
  return bots.filter((b) => b && typeof b === 'object');
}

/**
 * Match upstream `botOfAddress`: exact id, else name case-insensitively.
 * @param {object[]} bots
 * @param {string} name
 */
export function findBot(bots, name) {
  const key = String(name || '');
  const folded = key.toLowerCase();
  return (
    bots.find((bot) => String(bot.id || '') === key) ||
    bots.find((bot) => String(bot.name || '').toLowerCase() === folded) ||
    null
  );
}

export function sentMessageId(envelope) {
  const root = envelope && typeof envelope === 'object' ? envelope : {};
  const result = root.result && typeof root.result === 'object' ? root.result : root;
  const message = result.message && typeof result.message === 'object' ? result.message : null;
  const id =
    pick(message || {}, 'id', 'messageId', 'message_id') ||
    pick(result, 'id', 'messageId', 'message_id') ||
    pick(root, 'id', 'messageId', 'message_id');
  return id == null ? null : String(id);
}

export function messagesFromEnvelope(envelope) {
  const root = envelope && typeof envelope === 'object' ? envelope : {};
  const result = root.result && typeof root.result === 'object' && !Array.isArray(root.result)
    ? root.result
    : root;
  const messages = result.messages || result.inbox || root.messages;
  return Array.isArray(messages) ? messages : [];
}

export function messageRefersToRequest(message, messageId) {
  if (!message || typeof message !== 'object' || !messageId) return false;
  const id = String(messageId);
  const payload = coercePayload(message.payload);
  if (payload) {
    const requestId = payload.requestId || payload.request_id;
    if (requestId != null && String(requestId) === id) return true;
  }
  for (const key of ['thread_id', 'threadId', 'in_reply_to', 'inReplyTo', 'reply_to', 'replyTo']) {
    if (message[key] != null && String(message[key]) === id) return true;
  }
  return false;
}

function messageLooksLikeBotAnswer(message, botName) {
  if (!message || typeof message !== 'object') return false;
  const payload = coercePayload(message.payload);
  if (payload && payload.botAnswer && typeof payload.botAnswer === 'object') return true;
  if (!botName) return false;
  const from = String(pick(message, 'from_handle', 'from', 'fromHandle') || '');
  return from.toLowerCase() === botAddress(botName).toLowerCase();
}

/**
 * The answer to this send. With a message id, only a row that points at it.
 * @param {unknown[]} messages
 * @param {{ messageId?: string | null, botName?: string | null }} ctx
 */
export function matchBotReply(messages, { messageId = null, botName = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (messageId) {
    return list.find((m) => messageRefersToRequest(m, messageId)) || null;
  }
  return list.find((m) => messageLooksLikeBotAnswer(m, botName)) || null;
}

/**
 * Short unread summary for a timeout. Body is truncated. No full payload.
 * @param {unknown[]} messages
 */
export function summarizeMailboxRows(messages, { bodyChars = 80, limit = 12 } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object');
  return list.slice(0, limit).map((m) => {
    const view = answerView(m);
    const body = String(view.body || '');
    return {
      type: view.type || null,
      from: view.from || null,
      request_id: view.request_id || null,
      thread_id: view.thread_id || null,
      body: body.length > bodyChars ? `${body.slice(0, bodyChars - 1)}…` : body,
    };
  });
}

/**
 * Drop only the reply message ids `ask` already returned.
 * A later row on the same thread (follow-up, unanswered notice) stays.
 * @param {unknown[]} messages
 * @param {{ replyIds?: Set<string> } | Set<string> | null} seen
 */
export function dropSeenBotReplies(messages, seen) {
  const list = Array.isArray(messages) ? messages : [];
  const replyIds = seen instanceof Set
    ? seen
    : seen && seen.replyIds instanceof Set
      ? seen.replyIds
      : null;
  if (!replyIds || replyIds.size === 0) return list;
  return list.filter((m) => {
    if (!m || typeof m !== 'object') return true;
    const id = pick(m, 'id', 'messageId', 'message_id');
    return id == null || !replyIds.has(String(id));
  });
}

/** True when the row is a bot's mailed answer (`payload.botAnswer`). */
export function isBotAnswerMessage(message) {
  if (!message || typeof message !== 'object') return false;
  const payload = coercePayload(message.payload);
  return Boolean(payload && payload.botAnswer && typeof payload.botAnswer === 'object');
}

function messageTypeOf(message) {
  return String(pick(message, 'type', 'messageType', 'kind') || '').toLowerCase();
}

/**
 * The batch is only the reply ask already returned, or only bot answers,
 * and it has no worker_done / escalation / question. Await should read the
 * next batch in the same call so worker_done behind a bot answer is not
 * delayed by another window. A check cannot mark one message read.
 * @param {unknown[]} messages the batch just consumed, before filtering
 * @param {{ replyIds?: Set<string> } | Set<string> | null} seen
 */
export function shouldContinueForWorkerDone(messages, seen) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object');
  if (list.length === 0) return false;
  const blocking = new Set(['worker_done', 'escalation', 'question']);
  if (list.some((m) => blocking.has(messageTypeOf(m)))) return false;
  const kept = dropSeenBotReplies(list, seen);
  if (kept.length === 0) return true;
  return kept.every(isBotAnswerMessage);
}

export function answerView(message) {
  if (!message || typeof message !== 'object') return null;
  const payload = coercePayload(message.payload);
  return {
    id: pick(message, 'id', 'messageId', 'message_id') || null,
    type: pick(message, 'type', 'messageType', 'kind') || null,
    subject: pick(message, 'subject', 'title') || null,
    body: pick(message, 'body', 'text', 'content') || '',
    from: pick(message, 'from_handle', 'from', 'fromHandle') || null,
    thread_id: pick(message, 'thread_id', 'threadId') || null,
    request_id: payload ? (payload.requestId || payload.request_id || null) : null,
  };
}

export function checkTimedOut(envelope, messages) {
  const root = envelope && typeof envelope === 'object' ? envelope : {};
  const result = root.result && typeof root.result === 'object' ? root.result : root;
  if (result.timedOut === true || root.timedOut === true) return true;
  return !messages || messages.length === 0;
}
