import { randomUUID } from 'node:crypto';
import { getProject } from './store';
import type { Attachment, ChatSession, Message, RuntimeInfo, ToolEvent, UiStreamEvent } from './types';
import { upsertToolEvent } from './tool-events';
import { getWorkspaceSessionKey } from './workspace-env';

const baseUrl = (process.env.HERMES_BASE_URL || 'http://127.0.0.1:8642').replace(/\/$/, '');
const apiKey = process.env.HERMES_API_KEY || process.env.API_SERVER_KEY || '';
const sessionKey = getWorkspaceSessionKey();

export const HERMES_RUNS_SESSION_HISTORY_INCOMPATIBLE_MESSAGE =
  'This Hermes runtime does not support persistent /v1/runs session history. Install a Hermes release containing PR #52827 or apply the compatibility patch.';

export class HermesCapabilityError extends Error {
  kind: 'incompatible' | 'unavailable';

  constructor(kind: 'incompatible' | 'unavailable', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HermesCapabilityError';
    this.kind = kind;
  }
}

export class HermesHttpError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string, message = `Hermes request returned ${status}`) {
    super(message);
    this.name = 'HermesHttpError';
    this.status = status;
    this.body = body;
  }
}
const workspaceSystemPrompt = [
  'Agent Workspace is a markdown-capable browser UI.',
  'Ignore previous API-server rendering guidance that says the rendering layer is unknown, to assume plain text, or to avoid Markdown.',
  'Use lightweight Markdown when it improves readability: short headings, bullets, numbered lists, links, and fenced code blocks. Avoid over-formatting.',
].join(' ');
let compatibleCapabilities: Record<string, unknown> | null = null;
let capabilityProbeInFlight: Promise<Record<string, unknown>> | null = null;

function headers(extra?: HeadersInit): HeadersInit {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    'X-Hermes-Session-Key': sessionKey,
    ...extra,
  };
}

export async function runtimeHealth(): Promise<RuntimeInfo> {
  const info: RuntimeInfo = {
    id: 'default',
    name: process.env.HERMES_RUNTIME_NAME || 'Agent Workspace Hermes',
    base_url: baseUrl,
    profile: process.env.HERMES_PROFILE || 'default',
    model_label: 'hermes-agent',
    execution_host_label: process.env.HERMES_EXECUTION_HOST || 'server-side Agent Workspace runtime',
    status: 'ok',
  };
  try {
    const health = await fetch(`${baseUrl}/health`, { headers: headers(), cache: 'no-store' });
    if (!health.ok) throw new Error(`Hermes health returned ${health.status}`);
    const body = await health.json();
    info.version = body.version;
    info.capabilities = await requirePersistentRunsSessionHistory();
    return info;
  } catch (error) {
    return { ...info, status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

type HermesContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

type HermesHistoryMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  tool_name?: string;
};

function contentForHermes(text: string, attachments?: Attachment[]): HermesContent {
  const imageAttachments = attachments?.flatMap((attachment) => {
    if (!attachment.data_url) return [];
    return [{ type: 'image_url' as const, image_url: { url: attachment.data_url } }];
  }) || [];
  if (imageAttachments.length === 0) return text;
  return [
    { type: 'text', text: text || 'Please analyze the attached image.' },
    ...imageAttachments,
  ];
}

function capabilityFlag(body: unknown, key: string) {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  if (record[key] === true) return true;
  const features = record.features;
  return typeof features === 'object' && features !== null && !Array.isArray(features)
    ? (features as Record<string, unknown>)[key] === true
    : false;
}

export function resetHermesCapabilityCacheForTests() {
  compatibleCapabilities = null;
  capabilityProbeInFlight = null;
}

async function fetchCompatibleCapabilities(signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: headers(),
      cache: 'no-store',
      signal,
    });
  } catch (cause) {
    throw new HermesCapabilityError('unavailable', 'Hermes capability probe unavailable.', { cause });
  }
  if (!response.ok) {
    throw new HermesCapabilityError('incompatible', HERMES_RUNS_SESSION_HISTORY_INCOMPATIBLE_MESSAGE);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HermesCapabilityError('incompatible', HERMES_RUNS_SESSION_HISTORY_INCOMPATIBLE_MESSAGE);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !capabilityFlag(body, 'runs_session_history')) {
    throw new HermesCapabilityError('incompatible', HERMES_RUNS_SESSION_HISTORY_INCOMPATIBLE_MESSAGE);
  }
  compatibleCapabilities = body as Record<string, unknown>;
  return compatibleCapabilities;
}

function sharedCapabilityProbe() {
  if (compatibleCapabilities) return Promise.resolve(compatibleCapabilities);
  if (!capabilityProbeInFlight) {
    capabilityProbeInFlight = fetchCompatibleCapabilities().finally(() => {
      capabilityProbeInFlight = null;
    });
  }
  return capabilityProbeInFlight;
}

export async function requirePersistentRunsSessionHistory(signal?: AbortSignal) {
  if (compatibleCapabilities) return compatibleCapabilities;
  if (signal?.aborted) {
    throw new HermesCapabilityError('unavailable', 'Hermes capability probe aborted.', { cause: signal.reason });
  }
  // Signalled turn probes remain independently cancellable. Health checks and
  // other unsignalled callers share one in-flight request.
  return signal ? fetchCompatibleCapabilities(signal) : sharedCapabilityProbe();
}

function textFromHermesContent(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((part) => {
    if (typeof part !== 'object' || part === null) return '';
    const record = part as Record<string, unknown>;
    if (record.type === 'text') return String(record.text || '');
    if (record.type === 'image_url') return '[image]';
    return '';
  }).filter(Boolean).join(' ');
}

function parseJsonRecord(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function skillLabelFromArgs(args: unknown) {
  const parsed = typeof args === 'string'
    ? parseJsonRecord(args)
    : typeof args === 'object' && args !== null && !Array.isArray(args)
      ? args as Record<string, unknown>
      : null;
  const name = typeof parsed?.name === 'string' ? parsed.name : '';
  if (!name) return '';
  const filePath = typeof parsed?.file_path === 'string' && parsed.file_path.trim() ? `/${parsed.file_path.trim()}` : '';
  return `${name}${filePath}`;
}

function skillLabelFromToolOutput(content: unknown) {
  const parsed = parseJsonRecord(content);
  const name = typeof parsed?.name === 'string' ? parsed.name : '';
  if (!name) return '';
  const filePath = typeof parsed?.file === 'string' && parsed.file.trim() ? `/${parsed.file.trim()}` : '';
  return `${name}${filePath}`;
}

function loadedSkillMemo(label: string) {
  return `[Agent Workspace continuation: skill_view("${label}") was already loaded earlier in this Hermes session. Treat that skill as available; do not call skill_view for it again unless the user asks to refresh it, asks for a linked file, or the prior details are insufficient.]`;
}

function normalizeHermesMessages(raw: unknown): HermesHistoryMessage[] {
  if (!raw || typeof raw !== 'object') return [];
  const body = raw as Record<string, unknown>;
  const session = body.session as Record<string, unknown> | undefined;
  const messages = Array.isArray(body.data)
    ? body.data
    : Array.isArray(session?.messages)
      ? session.messages
      : Array.isArray(body.messages)
        ? body.messages
        : [];
  return messages.filter((message): message is HermesHistoryMessage => typeof message === 'object' && message !== null);
}

async function fetchHermesMessages(remoteId: string, signal?: AbortSignal): Promise<HermesHistoryMessage[]> {
  const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(remoteId)}/messages`, {
    headers: headers(),
    cache: 'no-store',
    signal,
  });
  if (!response.ok) return [];
  return normalizeHermesMessages(await response.json());
}

function historyFromAuthoritativeMessages(messages: HermesHistoryMessage[]) {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const loadedSkills = new Set<string>();

  const addLoadedSkill = (label: string) => {
    if (!label || loadedSkills.has(label)) return;
    loadedSkills.add(label);
    history.push({ role: 'assistant', content: loadedSkillMemo(label) });
  };

  for (const message of messages) {
    const role = message.role;
    if (role === 'user' || role === 'assistant') {
      const content = textFromHermesContent(message.content).trim();
      if (content) history.push({ role, content });
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (call?.function?.name === 'skill_view') addLoadedSkill(skillLabelFromArgs(call.function.arguments));
        }
      }
      continue;
    }
    if (role === 'tool' && (message.tool_name === 'skill_view' || !message.tool_name)) {
      addLoadedSkill(skillLabelFromToolOutput(message.content));
    }
  }
  return history;
}

function hermesSessionId(session: ChatSession) {
  return session.hermes_session_id || `web_${session.id}`;
}

function remoteHermesSessionTitle(session: ChatSession) {
  const remoteId = hermesSessionId(session);
  const baseTitle = (session.title || 'Agent Workspace session').trim();
  const suffix = remoteId.replace(/^web_/, '').slice(0, 8);
  return `${baseTitle} · ${suffix}`.slice(0, 120);
}

async function ensureHermesSession(session: ChatSession, signal?: AbortSignal) {
  const remoteId = hermesSessionId(session);
  const existing = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(remoteId)}`, {
    headers: headers(),
    cache: 'no-store',
    signal,
  });
  if (existing.ok) return remoteId;
  if (existing.status !== 404) {
    throw new Error(`Hermes session lookup returned ${existing.status}: ${await existing.text()}`);
  }
  const created = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: remoteId, title: remoteHermesSessionTitle(session) }),
    signal,
  });
  if (!created.ok && created.status !== 409) {
    throw new Error(`Hermes session create returned ${created.status}: ${await created.text()}`);
  }
  return remoteId;
}

function toolEventSummary(message: Message) {
  if (!message.tool_events?.length) return '';
  const lines = message.tool_events.map((event) => {
    const status = event.status || event.phase;
    const output = event.output ? `\n${event.output}` : '';
    return `[tool ${status}] ${event.tool_name}: ${event.summary}${output}`;
  });
  return lines.join('\n');
}

function contentForTranscriptMessage(message: Message) {
  const parts = [message.content.trim(), toolEventSummary(message).trim()].filter(Boolean);
  return parts.join('\n\n');
}

const CLEAR_CONTEXT_COMMAND_PROMPT = [
  'Create a compact context capsule for this chat so it can continue cleanly in a fresh context.',
  'Summarize only durable, useful state: current goal, key decisions, constraints/preferences, files or commands touched, open TODOs, blockers, and the next recommended step.',
  'Do not clear, archive, rename, or otherwise mutate anything. Do not take extra actions. Return the capsule only.',
].join(' ');

function slashCommandInput(input: string) {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/clear(?:\s*:?\s+([\s\S]*))?$/i);
  if (!match) return null;
  const note = match[1]?.trim();
  return note ? `${CLEAR_CONTEXT_COMMAND_PROMPT}\n\nUser note: ${note}` : CLEAR_CONTEXT_COMMAND_PROMPT;
}

function isPendingAssistantForCurrentTurn(message: Message) {
  return message.role === 'assistant' && (message.status === 'pending' || message.status === 'streaming') && !message.content.trim() && !message.tool_events?.length;
}

async function runInputWithClientTranscriptFallback(session: ChatSession, input: string, attachments: Attachment[] = [], remoteId?: string, signal?: AbortSignal, systemPrompt?: string) {
  const commandInput = slashCommandInput(input);
  let messages: Array<{ role: Message['role']; content: HermesContent | string }> = [];
  if (session.continuation_strategy === 'full_transcript') {
    const authoritative = remoteId ? historyFromAuthoritativeMessages(await fetchHermesMessages(remoteId, signal)) : [];
    messages = authoritative.length > 0
      ? authoritative
      : session.messages
          .filter((message) => !isPendingAssistantForCurrentTurn(message))
          .map((message) => {
            const content = contentForTranscriptMessage(message);
            if (!content && message.role !== 'user') return null;
            return { role: message.role, content };
          })
          .filter((message): message is { role: Message['role']; content: string } => Boolean(message));
  }

  if (systemPrompt?.trim() && messages[0]?.role !== 'system') {
    messages = [{ role: 'system' as const, content: systemPrompt.trim() }, ...messages];
  }

  const lastMessage = messages.at(-1);
  const lastUser = lastMessage?.role === 'user' ? String(lastMessage.content).trim() : '';
  if (commandInput && lastUser === input.trim()) {
    return [...messages.slice(0, -1), { role: 'user' as const, content: commandInput }];
  }
  if (lastUser === input.trim() && attachments.length === 0) return messages;

  return [...messages, { role: 'user' as const, content: contentForHermes(commandInput || input, attachments) }];
}

function normalizeToolEvent(data: Record<string, unknown>, fallbackName?: string): UiStreamEvent {
  const tool = String(data.tool || data.tool_name || data.name || fallbackName || 'tool');
  const status = String(data.status || data.event || 'running');
  const preview = typeof data.preview === 'string' ? data.preview : undefined;
  const summary = String(data.label || data.summary || data.command || preview || `${tool} ${status}`);
  const type = status.includes('completed') || status.includes('complete') || status.includes('failed') ? 'tool_output' : 'tool_call';
  const output = typeof data.output === 'string' ? data.output : typeof data.result === 'string' ? data.result : preview;
  const toolCallId = data.toolCallId || data.tool_call_id || data.call_id || data.id || `${tool}:${data.run_id || 'active'}`;
  return {
    type,
    tool_name: tool,
    summary,
    status,
    toolCallId: toolCallId ? String(toolCallId) : undefined,
    output,
    raw_payload: data,
  };
}

function normalizeRunEvent(data: Record<string, unknown>): UiStreamEvent | null {
  const event = String(data.event || data.type || '');
  if (event === 'message.delta' && typeof data.delta === 'string') return { type: 'assistant_delta', text: data.delta };
  if (event === 'run.completed') return null;
  if (event === 'run.failed') return { type: 'error', message: String(data.error || 'Hermes run failed'), retryable: true };
  if (event === 'approval.request') {
    const command = typeof data.command === 'string' ? data.command : typeof data.summary === 'string' ? data.summary : 'Approval required';
    return {
      type: 'tool_call',
      tool_name: 'approval',
      summary: command,
      status: 'pending_approval',
      toolCallId: String(data.run_id || data.id || randomUUID()),
      raw_payload: data,
    };
  }
  if (event === 'approval.responded') {
    return {
      type: 'tool_output',
      tool_name: 'approval',
      summary: `Approval ${String(data.choice || 'responded')}`,
      status: 'complete',
      toolCallId: String(data.run_id || data.id || randomUUID()),
      raw_payload: data,
    };
  }
  if (event.startsWith('tool.') || event.includes('tool')) return normalizeToolEvent(data, event.replace(/^tool\./, ''));
  return null;
}

export async function* streamHermesTurn(
  session: ChatSession,
  input: string,
  attachments: Attachment[] = [],
  signal?: AbortSignal,
  options?: { onRunId?: (runId: string) => void },
): AsyncGenerator<UiStreamEvent> {
  await requirePersistentRunsSessionHistory(signal);
  const remoteId = await ensureHermesSession(session, signal);
  const project = session.project_id ? await getProject(session.project_id) : null;
  const projectSystemPrompt = project?.system_prompt?.trim() || '';
  const instructions = [workspaceSystemPrompt, projectSystemPrompt].filter(Boolean).join('\n\n');
  const slashInput = slashCommandInput(input);
  const inputPayload = contentForHermes(slashInput || input, slashInput ? [] : attachments);
  const runResponse = await fetch(`${baseUrl}/v1/runs`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ model: 'hermes-agent', session_id: remoteId, input: inputPayload, instructions }),
    signal,
  });
  if (!runResponse.ok) {
    throw new Error(`Hermes run create returned ${runResponse.status}: ${await runResponse.text()}`);
  }
  const runBody = await runResponse.json();
  const runId = String(runBody.run_id || '');
  if (!runId) throw new Error('Hermes run did not return run_id');
  options?.onRunId?.(runId);

  const eventsResponse = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
    headers: headers({ Accept: 'text/event-stream' }),
    cache: 'no-store',
    signal,
  });
  if (!eventsResponse.ok || !eventsResponse.body) {
    throw new Error(`Hermes run events returned ${eventsResponse.status}: ${await eventsResponse.text()}`);
  }

  const reader = eventsResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const dataLines = chunk.split(/\r?\n/).filter((line) => line.startsWith('data:'));
      if (dataLines.length === 0) continue;
      const payload = dataLines.map((line) => line.slice(5).trim()).join('\n');
      if (!payload || payload === '[DONE]') continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(payload); } catch { continue; }
      const event = normalizeRunEvent(parsed);
      if (event) yield event;
    }
  }
  yield { type: 'done', message_id: randomUUID() };
}

export async function respondToHermesApproval(runId: string, choice: 'once' | 'session' | 'always' | 'deny') {
  const response = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/approval`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ choice }),
  });
  if (!response.ok) throw new Error(`Hermes approval returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<{ run_id: string; choice: string; resolved?: number }>;
}

export async function steerHermesRun(runId: string, input: string) {
  const response = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/steer`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ input }),
  });
  if (!response.ok) throw new HermesHttpError(response.status, await response.text(), `Hermes steer returned ${response.status}`);
  return response.json() as Promise<{ run_id: string; accepted?: boolean }>;
}

export function eventToToolEvent(event: UiStreamEvent): ToolEvent | null {
  if (event.type !== 'tool_call' && event.type !== 'tool_output') return null;
  return upsertToolEvent([], event, { id: randomUUID() })[0] ?? null;
}

export function applyToolEvent(events: ToolEvent[], event: UiStreamEvent): ToolEvent[] {
  return upsertToolEvent(events, event, { id: randomUUID() });
}
