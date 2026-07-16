import type { ChatSession, Message } from './types';
import type { SessionMessagePatch } from './session-events';

export type SessionSummaryLike = Omit<ChatSession, 'messages'> & { message_count: number };
export type SessionSummaryLikePatch = Partial<SessionSummaryLike> & { id: string };

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || left === undefined || right === undefined) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return Object.is(left, right);
  if (Array.isArray(left) !== Array.isArray(right)) return false;

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameValue(left[index], right[index])) return false;
    }
    return true;
  }

  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightObject = right as Record<string, unknown>;
  if (leftEntries.length !== Object.keys(rightObject).length) return false;
  for (const [key, value] of leftEntries) {
    if (!Object.hasOwn(rightObject, key)) return false;
    if (!sameValue(value, rightObject[key])) return false;
  }
  return true;
}

function mergeMessagePatch(current: Message | undefined, patch: SessionMessagePatch): Message {
  const next: Message = {
    id: patch.id,
    role: patch.role ?? current?.role ?? 'assistant',
    content: patch.content ?? current?.content ?? '',
    status: patch.status ?? current?.status ?? 'streaming',
    created_at: patch.created_at ?? current?.created_at ?? new Date().toISOString(),
    attachments: patch.attachments !== undefined ? patch.attachments : current?.attachments,
    tool_events: patch.tool_events !== undefined ? patch.tool_events : current?.tool_events,
    metadata: patch.metadata !== undefined ? patch.metadata : current?.metadata,
  };

  if (
    current
    && current.id === next.id
    && current.role === next.role
    && current.content === next.content
    && current.status === next.status
    && current.created_at === next.created_at
    && sameValue(current.attachments, next.attachments)
    && sameValue(current.tool_events, next.tool_events)
    && sameValue(current.metadata, next.metadata)
  ) {
    return current;
  }

  return next;
}

function mergeMessageLists(existing: Message[], incoming: Message[]) {
  if (existing.length === 0) return incoming;
  const byId = new Map(existing.map((message) => [message.id, message] as const));
  const next: Message[] = [];
  let changed = false;

  for (const incomingMessage of incoming) {
    const current = byId.get(incomingMessage.id);
    const merged = mergeMessagePatch(current, incomingMessage);
    next.push(merged);
    if (merged !== current) changed = true;
    byId.delete(incomingMessage.id);
  }

  if (byId.size > 0) {
    changed = true;
    for (const message of existing) {
      if (byId.has(message.id)) next.push(message);
    }
  }

  if (!changed && next.length === existing.length) return existing;
  return next;
}

export function sessionSnapshotToSummary(snapshot: ChatSession): SessionSummaryLike {
  return {
    ...snapshot,
    message_count: snapshot.messages.length,
  };
}

export function mergeSessionSnapshot(current: ChatSession | null | undefined, snapshot: ChatSession): ChatSession {
  if (!current || current.id !== snapshot.id) return snapshot;
  const mergedMessages = mergeMessageLists(current.messages, snapshot.messages);
  if (
    mergedMessages === current.messages
    && current.hermes_session_id === snapshot.hermes_session_id
    && current.project_id === snapshot.project_id
    && current.title === snapshot.title
    && current.created_at === snapshot.created_at
    && current.updated_at === snapshot.updated_at
    && current.runtime_id === snapshot.runtime_id
    && current.continuation_strategy === snapshot.continuation_strategy
    && current.status === snapshot.status
    && current.last_error === snapshot.last_error
    && current.pinned_at === snapshot.pinned_at
    && current.archived_at === snapshot.archived_at
  ) {
    return current;
  }

  return {
    ...current,
    ...snapshot,
    messages: mergedMessages,
  };
}

export function mergeSessionSummary<T extends SessionSummaryLike>(current: T | null | undefined, patch: SessionSummaryLikePatch): T | null {
  if (!current || current.id !== patch.id) return current ?? null;
  const next: T = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.updated_at !== undefined ? { updated_at: patch.updated_at } : {}),
    ...(patch.last_error !== undefined ? { last_error: patch.last_error || undefined } : {}),
    ...(patch.pinned_at !== undefined ? { pinned_at: patch.pinned_at } : {}),
    ...(patch.archived_at !== undefined ? { archived_at: patch.archived_at } : {}),
    ...(patch.message_count !== undefined ? { message_count: patch.message_count } : {}),
    ...(patch.hermes_session_id !== undefined ? { hermes_session_id: patch.hermes_session_id } : {}),
    ...(patch.project_id !== undefined ? { project_id: patch.project_id } : {}),
    ...(patch.created_at !== undefined ? { created_at: patch.created_at } : {}),
    ...(patch.runtime_id !== undefined ? { runtime_id: patch.runtime_id } : {}),
    ...(patch.continuation_strategy !== undefined ? { continuation_strategy: patch.continuation_strategy } : {}),
  };

  if (
    current.hermes_session_id === next.hermes_session_id
    && current.project_id === next.project_id
    && current.title === next.title
    && current.created_at === next.created_at
    && current.updated_at === next.updated_at
    && current.runtime_id === next.runtime_id
    && current.continuation_strategy === next.continuation_strategy
    && current.status === next.status
    && current.last_error === next.last_error
    && current.pinned_at === next.pinned_at
    && current.archived_at === next.archived_at
    && current.message_count === next.message_count
  ) {
    return current;
  }

  return next;
}

export function mergeSessionMessage(current: ChatSession | null | undefined, sessionId: string, patch: SessionMessagePatch): ChatSession | null {
  if (!current || current.id !== sessionId) return current ?? null;
  const index = current.messages.findIndex((message) => message.id === patch.id);
  if (index < 0) {
    return { ...current, messages: [...current.messages, mergeMessagePatch(undefined, patch)] };
  }

  const message = mergeMessagePatch(current.messages[index], patch);
  if (message === current.messages[index]) return current;
  const nextMessages = [...current.messages];
  nextMessages[index] = message;
  return { ...current, messages: nextMessages };
}

export function mergeSessionSummaryList<T extends SessionSummaryLike>(current: T[], patch: SessionSummaryLikePatch): T[] {
  const index = current.findIndex((session) => session.id === patch.id);
  if (index < 0) return current;
  const merged = mergeSessionSummary(current[index], patch);
  if (!merged || merged === current[index]) return current;
  const next = [...current];
  next[index] = merged;
  return next;
}
