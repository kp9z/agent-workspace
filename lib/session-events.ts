import type { ChatSession, Message } from './types';

type SessionListener = (event: SessionEvent) => void;

type SessionEventState = {
  listeners: Map<string, Set<SessionListener>>;
};

export type SessionSummaryPatch = {
  title?: string;
  status?: ChatSession['status'];
  updated_at?: string;
  last_error?: string | null;
  pinned_at?: string | null;
  archived_at?: string | null;
  message_count?: number;
};

export type SessionMessagePatch = {
  id: string;
  role?: Message['role'];
  content?: string;
  status?: Message['status'];
  created_at?: string;
  updated_at?: string;
  attachments?: Message['attachments'];
  tool_events?: Message['tool_events'];
  metadata?: Message['metadata'];
};

export type SessionEvent =
  | { type: 'snapshot'; session: ChatSession }
  | { type: 'summary'; session_id: string; patch: SessionSummaryPatch }
  | { type: 'message'; session_id: string; message: SessionMessagePatch };

export function sessionEventName(event: SessionEvent) {
  if (event.type === 'snapshot') return 'session';
  return `session-${event.type}`;
}

const globalState = globalThis as typeof globalThis & {
  __agentWorkspaceSessionEvents?: SessionEventState;
  __kiraWorkspaceSessionEvents?: SessionEventState;
};
const state = globalState.__agentWorkspaceSessionEvents
  ?? globalState.__kiraWorkspaceSessionEvents
  ?? { listeners: new Map<string, Set<SessionListener>>() };
globalState.__agentWorkspaceSessionEvents = state;
globalState.__kiraWorkspaceSessionEvents = state;

export function subscribeToSession(sessionId: string, listener: SessionListener) {
  const listeners = state.listeners.get(sessionId) ?? new Set<SessionListener>();
  listeners.add(listener);
  state.listeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) state.listeners.delete(sessionId);
  };
}

function publish(sessionId: string, event: SessionEvent) {
  const listeners = state.listeners.get(sessionId);
  if (!listeners?.size) return;
  for (const listener of Array.from(listeners)) listener(event);
}

export function publishSessionSnapshot(sessionId: string, session: ChatSession) {
  publish(sessionId, { type: 'snapshot', session });
}

export function publishSessionSummary(sessionId: string, patch: SessionSummaryPatch) {
  publish(sessionId, { type: 'summary', session_id: sessionId, patch });
}

export function publishSessionMessage(sessionId: string, message: SessionMessagePatch) {
  publish(sessionId, { type: 'message', session_id: sessionId, message });
}
