import { buildTitleSummary, chooseTitleIcon, setSessionTitleIfDefaultOr, TITLE_STOP_WORDS } from './store';

const DEFAULT_TITLE_MODEL = 'hermes-agent';
const TITLE_TIMEOUT_MS = Number(process.env.HERMES_TITLE_TIMEOUT_MS || '8000');
const TITLE_RETRY_TIMEOUT_MS = Number(process.env.HERMES_TITLE_RETRY_TIMEOUT_MS || '30000');
const TITLE_RETRY_DELAY_MS = Number(process.env.HERMES_TITLE_RETRY_DELAY_MS || '2000');
const TITLE_MAX_TOKENS = Number(process.env.HERMES_TITLE_MAX_TOKENS || '24');
const TITLE_TEMPERATURE = Number(process.env.HERMES_TITLE_TEMPERATURE || '0.2');
const TITLE_MAX_LENGTH = 48;
const TITLE_MAX_WORDS = 5;
const TITLE_LEADING_VERBS = new Set(['add', 'build', 'check', 'create', 'debug', 'fix', 'help', 'implement', 'make', 'review', 'update']);
const baseUrl = (process.env.HERMES_TITLE_BASE_URL || process.env.HERMES_BASE_URL || 'http://127.0.0.1:8642').replace(/\/$/, '');
const apiKey = process.env.HERMES_TITLE_API_KEY || process.env.HERMES_API_KEY || process.env.API_SERVER_KEY || '';
const titleModel = process.env.HERMES_TITLE_MODEL || process.env.HERMES_AUX_TITLE_MODEL || DEFAULT_TITLE_MODEL;
const REMOTE_TITLE_SYNC_ATTEMPTS = Number(process.env.HERMES_TITLE_SYNC_ATTEMPTS || '8');
const REMOTE_TITLE_SYNC_RETRY_MS = Number(process.env.HERMES_TITLE_SYNC_RETRY_MS || '300');

function headers(extra?: HeadersInit): HeadersInit {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    'X-Hermes-Session-Key': process.env.HERMES_TITLE_SESSION_KEY || 'web-ui:title-generator',
    ...extra,
  };
}

function abortAfter(ms: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(250, ms));
  return { controller, timeout };
}

export function isTitleGenerationAbort(error: unknown) {
  return Boolean(
    error && typeof error === 'object' && 'name' in error && String((error as { name?: unknown }).name) === 'AbortError',
  ) || error === 'AbortError';
}

function wordTokens(text: string) {
  return Array.from(text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu), (match) => match[0]);
}

function startsWithEmoji(text: string) {
  return /^\p{Extended_Pictographic}/u.test(text.trim());
}

function meaningfulWords(text: string) {
  const words = wordTokens(text).filter((word) => !TITLE_STOP_WORDS.has(word.toLowerCase()));
  let start = 0;
  while (words.length - start > 2 && TITLE_LEADING_VERBS.has(words[start].toLowerCase())) start += 1;
  return start > 0 ? words.slice(start) : words;
}

export function normalizeGeneratedTitle(raw: string, fallback: string) {
  let title = raw
    .split(/\r?\n/)[0]
    .replace(/^\s*(title|chat title)\s*:\s*/i, '')
    .trim()
    .replace(/^['"`“”‘’]+|['"`“”‘’]+$/g, '')
    .replace(/[.!?。！？]+$/g, '')
    .trim();

  if (!title) return fallback;
  if (!startsWithEmoji(title)) title = `💬 ${title}`;

  const firstSpace = title.search(/\s/);
  const rest = firstSpace === -1 ? title : title.slice(firstSpace).trim();
  const words = meaningfulWords(rest).slice(0, TITLE_MAX_WORDS);
  if (words.length === 0) return fallback;
  const icon = chooseTitleIcon(words.join(' '));
  const compact = `${icon} ${words.join(' ')}`;
  const clamped = compact.slice(0, TITLE_MAX_LENGTH).trim();
  return clamped || fallback;
}

async function generateTitleWithHermes(input: string, signal: AbortSignal) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: titleModel,
      stream: false,
      max_tokens: TITLE_MAX_TOKENS,
      temperature: TITLE_TEMPERATURE,
      messages: [
        {
          role: 'system',
          content: 'You create compact chat titles. Return only one title. Start with one emoji that matches the final title topic, not the wording of the request. Use at most 5 meaningful words after the emoji. Omit filler/request words like can, you, please, help, fix, make, update. No quotes, no newline, no punctuation at the end. Describe the topic, not the act of chatting.',
        },
        {
          role: 'user',
          content: `Create a title for this first user message:\n${input.slice(0, 1000)}`,
        },
      ],
    }),
    signal,
  });
  if (!response.ok) throw new Error(`title generation returned ${response.status}: ${await response.text()}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content || '';
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncRemoteHermesSessionTitle(sessionId: string, title: string) {
  const remoteId = `web_${sessionId}`;
  for (let attempt = 0; attempt < Math.max(1, REMOTE_TITLE_SYNC_ATTEMPTS); attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(remoteId)}`, {
        method: 'PATCH',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title }),
      });
      if (response.ok) return;
      if (response.status !== 404) return;
    } catch {
      return;
    }
    await wait(Math.max(50, REMOTE_TITLE_SYNC_RETRY_MS));
  }
}

async function setLocalAndRemoteTitle(sessionId: string, title: string, fallback: string) {
  const didSetLocalTitle = await setSessionTitleIfDefaultOr(sessionId, title, fallback);
  if (didSetLocalTitle) void syncRemoteHermesSessionTitle(sessionId, title);
}

async function generateAndSetTitle(sessionId: string, input: string, fallback: string, timeoutMs: number) {
  const { controller, timeout } = abortAfter(timeoutMs);
  try {
    const raw = await generateTitleWithHermes(input, controller.signal);
    await setLocalAndRemoteTitle(sessionId, normalizeGeneratedTitle(raw, fallback), fallback);
  } finally {
    clearTimeout(timeout);
  }
}

export function autoTitleSessionFromFirstMessage(sessionId: string, input: string) {
  if (!input.trim()) return;
  const fallback = buildTitleSummary(input);

  void generateAndSetTitle(sessionId, input, fallback, TITLE_TIMEOUT_MS).catch((error) => {
    if (isTitleGenerationAbort(error)) return;
    console.warn('Agent Workspace title generation initial pass failed', error);
    void wait(Math.max(0, TITLE_RETRY_DELAY_MS))
      .then(() => generateAndSetTitle(sessionId, input, fallback, TITLE_RETRY_TIMEOUT_MS))
      .catch((retryError) => {
        if (isTitleGenerationAbort(retryError)) return;
        console.warn('Agent Workspace title generation retry failed', retryError);
      });
  });
}
